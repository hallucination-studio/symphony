from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

from .conductor_models import utc_now_iso
from .conductor_smoke_protocol import (
    SmokeCommandError,
    command_fingerprint,
    normalize_smoke_command,
    safe_code,
    sanitize_reason,
    smoke_result,
)


LOGGER = logging.getLogger(__name__)
SmokeResultPoster = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class PodiumSmokeCheckMixin:
    async def handle_smoke_check(
        self,
        raw_command: dict[str, Any],
        *,
        post_smoke_result: SmokeResultPoster | None = None,
    ) -> dict[str, Any]:
        try:
            command = normalize_smoke_command(raw_command)
        except SmokeCommandError as exc:
            _log_invalid_command(exc, self._smoke_instance(), self.store.get_settings())
            return {"status": "rejected", "reason": exc.code}
        async with self._smoke_check_lock:
            return await self._handle_normalized_smoke_check(command, post_smoke_result)

    async def _handle_normalized_smoke_check(
        self,
        command: dict[str, Any],
        post_smoke_result: SmokeResultPoster | None,
    ) -> dict[str, Any]:
        existing = self.smoke_check_store.get(command["smoke_check_id"])
        if existing is not None:
            if command_fingerprint(existing["command"]) != command_fingerprint(command):
                _log_command_conflict(command, self._smoke_instance(), self.store.get_settings())
                return {"status": "rejected", "reason": "smoke_command_conflict"}
            if existing["delivery_status"] == "delivered":
                return _outcome(existing, status="already_reported")
            if existing["delivery_status"] == "rejected" or not existing["retryable"]:
                return _outcome(existing, status="delivery_rejected")
            if post_smoke_result is not None:
                return await self._deliver_smoke_result(existing, post_smoke_result)
            return _outcome(existing, status="result_pending")
        instance = self._smoke_instance()
        settings = self.store.get_settings()
        _log_smoke_started(command, instance, settings)
        result = await self._execute_smoke_check(command, instance)
        record = self.smoke_check_store.save_result(command, result)
        _log_smoke_completed(command, result, instance, settings)
        if post_smoke_result is None:
            return _outcome(record, status="result_pending")
        return await self._deliver_smoke_result(record, post_smoke_result)

    async def _execute_smoke_check(self, command: dict[str, Any], instance: Any | None) -> dict[str, Any]:
        binding_ready = _binding_matches(instance, command)
        repository_ready = _repository_ready(instance, command)
        # Runtime configuration is local to this Conductor. Podium only checks
        # that the enrolled runtime is alive; it no longer stores a profile
        # registry that the worker must fetch.
        config_ready = bool(instance is not None)
        proxy_ready = False
        label_ready = False
        proxy_reason = "Project binding identity did not match the smoke command"
        if binding_ready and instance is not None:
            try:
                proxy = self.project_label_proxy_factory(instance)
                project_id = await proxy.find_project_id(command["project_slug"])
                proxy_ready = project_id == command["linear_project_id"]
                if proxy_ready:
                    labels = await proxy.fetch_project_labels(str(project_id))
                    label_ready = command["expected_label"] in labels
                else:
                    proxy_reason = "Linear proxy returned a different project identity"
            except Exception as exc:
                proxy_reason = sanitize_reason(exc)
        checks = {
            "binding_identity": binding_ready,
            "repository_readiness": repository_ready,
            "linear_proxy_access": proxy_ready,
            "runtime_config_validity": config_ready,
            "project_label_state": label_ready,
        }
        return smoke_result(command, checks, _first_failure(checks, proxy_reason))

    async def _deliver_smoke_result(
        self,
        record: dict[str, Any],
        poster: SmokeResultPoster,
    ) -> dict[str, Any]:
        check_id = str(record["smoke_check_id"])
        posting = self.smoke_check_store.begin_delivery(check_id)
        try:
            raw_outcome = await poster(dict(posting["result"]))
        except Exception as exc:
            raw_outcome = {
                "status": "retryable_error",
                "error_code": "smoke_result_post_failed",
                "sanitized_reason": sanitize_reason(exc),
                "retryable": True,
                "action_required": "retry_smoke_result",
                "next_action": "retry_smoke_result",
            }
        outcome = _delivery_outcome(raw_outcome)
        if outcome["status"] == "accepted":
            delivered = self.smoke_check_store.mark_delivered(check_id)
            _log_delivery_success(delivered, self.store.get_settings(), self._smoke_instance())
            return _outcome(delivered, status="reported")
        failed = self.smoke_check_store.mark_delivery_failed(
            check_id,
            error_code=outcome["error_code"],
            reason=outcome["sanitized_reason"],
            retryable=outcome["retryable"],
            action_required=outcome["action_required"],
            next_action=outcome["next_action"],
        )
        _log_delivery_failure(failed, self.store.get_settings(), self._smoke_instance())
        return _outcome(failed, status="delivery_failed")

    async def retry_pending_smoke_results(
        self,
        poster: SmokeResultPoster,
        *,
        force: bool = False,
    ) -> dict[str, int]:
        delivered = 0
        failed = 0
        rows = self.smoke_check_store.list_pending(force=force)
        for row in rows:
            async with self._smoke_check_lock:
                current = self.smoke_check_store.get(str(row["smoke_check_id"]))
                if (
                    current is None
                    or current["delivery_status"] in {"delivered", "rejected"}
                    or not current["retryable"]
                ):
                    continue
                outcome = await self._deliver_smoke_result(current, poster)
            if outcome["delivery_status"] == "delivered":
                delivered += 1
            else:
                failed += 1
        pending = len(self.smoke_check_store.list_pending(force=True))
        return {"delivered": delivered, "failed": failed, "pending": pending}

    def list_smoke_checks(self) -> list[dict[str, Any]]:
        return self.smoke_check_store.list_public()

    def _smoke_instance(self) -> Any | None:
        instances = self.store.list_instances()
        return instances[0] if len(instances) == 1 else None


def _binding_matches(instance: Any | None, command: dict[str, Any]) -> bool:
    if instance is None:
        return False
    filters = instance.linear_filters
    return bool(
        str(filters.get("binding_id") or "") == command["binding_id"]
        and int(filters.get("binding_config_version") or 0) == command["config_version"]
        and str(filters.get("linear_project_id") or "") == command["linear_project_id"]
        and instance.linear_project == command["project_slug"]
    )


def _repository_ready(instance: Any | None, command: dict[str, Any]) -> bool:
    if instance is None:
        return False
    expected_type = "git" if command["repository"]["mode"] == "git_url" else "local_path"
    path = Path(instance.resolved_repo_path)
    return bool(
        instance.repo_source_type == expected_type
        and instance.repo_source_value == command["repository"]["value"]
        and path.is_dir()
        and os.access(path, os.R_OK | os.X_OK)
    )


def _first_failure(checks: dict[str, bool], proxy_reason: str) -> tuple[str, str, str, bool] | None:
    failures = (
        ("binding_identity", "smoke_binding_mismatch", "Conductor binding does not match Podium", "rebind_project"),
        ("repository_readiness", "repository_not_ready", "Bound repository is not ready", "fix_repository"),
        ("runtime_config_validity", "runtime_runtime_unavailable", "Conductor runtime is unavailable", "restore_conductor"),
        ("linear_proxy_access", "linear_proxy_check_failed", proxy_reason, "restore_linear_proxy"),
        ("project_label_state", "managed_project_label_mismatch", "Managed project label is missing", "restore_project_label"),
    )
    for name, code, reason, action in failures:
        if not checks[name]:
            return code, reason, action, True
    return None


def _delivery_outcome(raw: Any) -> dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    if payload.get("status") == "accepted":
        return {"status": "accepted", "error_code": "", "sanitized_reason": "", "retryable": False,
                "action_required": "", "next_action": ""}
    retryable = bool(payload.get("retryable", True))
    return {
        "status": "retryable_error" if retryable else "rejected",
        "error_code": safe_code(payload.get("error_code"), "smoke_result_post_failed"),
        "sanitized_reason": sanitize_reason(payload.get("sanitized_reason")),
        "retryable": retryable,
        "action_required": safe_code(payload.get("action_required"), "retry_smoke_result"),
        "next_action": safe_code(payload.get("next_action"), "retry_smoke_result"),
    }


def _outcome(record: dict[str, Any], *, status: str) -> dict[str, Any]:
    return {
        "status": status,
        "smoke_check_id": record["smoke_check_id"],
        "delivery_status": record["delivery_status"],
        "delivery_attempts": record["delivery_attempts"],
        "delivery_error_code": record["delivery_error_code"],
        "delivery_error_reason": record["delivery_error_reason"],
        "retryable": record["retryable"],
        "action_required": record["action_required"],
        "next_action": record["next_action"],
        "result": record["result"],
    }


def _log_smoke_started(command: dict[str, Any], instance: Any | None, settings: Any) -> None:
    message = _event_fields("conductor_smoke_check_started", command, instance, settings)
    LOGGER.info(message)
    _append_instance_log(instance, message)


def _log_smoke_completed(command: dict[str, Any], result: dict[str, Any], instance: Any | None, settings: Any) -> None:
    message = (
        f"{_event_fields('conductor_smoke_check_completed', command, instance, settings)} status={result['status']} "
        f"error_type={'ConductorSmokeCheckError' if result['status'] == 'failed' else '-'} "
        f"error_code={result['error_code'] or '-'} sanitized_reason={result['sanitized_reason'] or '-'} "
        f"action_required={result['action_required'] or '-'} retryable={str(result['retryable']).lower()} "
        f"next_action={result['next_action'] or '-'}"
    )
    (LOGGER.error if result["status"] == "failed" else LOGGER.info)(message)
    _append_instance_log(instance, message)


def _log_invalid_command(error: SmokeCommandError, instance: Any | None, settings: Any) -> None:
    message = (
        f"event=conductor_smoke_command_rejected {_runtime_fields(settings, instance)} "
        f"error_type=SmokeCommandError error_code={error.code} sanitized_reason={error.reason} "
        "action_required=retry_smoke_check retryable=false next_action=inspect_podium_command"
    )
    LOGGER.error(message)
    _append_instance_log(instance, message)


def _log_command_conflict(command: dict[str, Any], instance: Any | None, settings: Any) -> None:
    message = (
        f"event=conductor_smoke_command_rejected {_runtime_fields(settings, instance)} "
        f"smoke_check_id={command['smoke_check_id']} binding_id={command['binding_id']} "
        "error_type=SmokeCommandError error_code=smoke_command_conflict "
        "sanitized_reason=Smoke command conflicts with durable evidence "
        "action_required=inspect_podium_command retryable=false next_action=issue_new_smoke_check"
    )
    LOGGER.error(message)
    _append_instance_log(instance, message)


def _log_delivery_success(record: dict[str, Any], settings: Any, instance: Any | None) -> None:
    message = (
        f"event=conductor_smoke_result_delivered {_runtime_fields(settings, instance)} "
        f"smoke_check_id={record['smoke_check_id']} binding_id={record['binding_id']} "
        f"attempt_number={record['delivery_attempts']} retryable=false"
    )
    LOGGER.info(message)
    _append_instance_log(instance, message)


def _log_delivery_failure(record: dict[str, Any], settings: Any, instance: Any | None) -> None:
    level = LOGGER.warning if record["retryable"] else LOGGER.error
    message = (
        f"event=conductor_smoke_result_delivery_failed {_runtime_fields(settings, instance)} "
        f"smoke_check_id={record['smoke_check_id']} binding_id={record['binding_id']} "
        f"error_type=SmokeDeliveryError error_code={record['delivery_error_code']} "
        f"sanitized_reason={record['delivery_error_reason']} action_required={record['action_required']} "
        f"retryable={str(record['retryable']).lower()} attempt_number={record['delivery_attempts']} "
        f"next_action={record['next_action']}"
    )
    level(message)
    _append_instance_log(instance, message)


def _event_fields(event: str, command: dict[str, Any], instance: Any | None, settings: Any) -> str:
    return (
        f"event={event} {_runtime_fields(settings, instance)} smoke_check_id={command['smoke_check_id']} "
        f"binding_id={command['binding_id']} linear_project_id={command['linear_project_id']}"
    )


def _runtime_fields(settings: Any, instance: Any | None) -> str:
    runtime_id = settings.podium_runtime_id or settings.conductor_id or "-"
    return (
        f"runtime_group_id={settings.runtime_group_id or '-'} runtime_id={runtime_id} "
        f"conductor_id={settings.conductor_id or runtime_id} "
        f"instance_id={getattr(instance, 'id', '-') if instance else '-'}"
    )


def _append_instance_log(instance: Any | None, message: str) -> None:
    if instance is None or not getattr(instance, "log_path", None):
        return
    try:
        path = Path(str(instance.log_path))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now_iso()} {message}\n")
    except OSError:
        LOGGER.warning("event=conductor_smoke_log_write_failed instance_id=%s", getattr(instance, "id", "-"))
