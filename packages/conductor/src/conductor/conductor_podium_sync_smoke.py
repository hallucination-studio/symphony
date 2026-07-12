from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .models import utc_now_iso
from .conductor_smoke_protocol import (
    SmokeCommandError,
    normalize_smoke_command,
    sanitize_reason,
    smoke_result,
)


LOGGER = logging.getLogger(__name__)


class PodiumSmokeCheckMixin:
    async def handle_smoke_check(
        self,
        raw_command: dict[str, Any],
        *,
        post_smoke_result: Any | None = None,
    ) -> dict[str, Any]:
        _ = post_smoke_result
        try:
            command = normalize_smoke_command(raw_command)
        except SmokeCommandError as exc:
            _log_invalid_command(exc, self._smoke_instance(), self.store.get_settings())
            return {"status": "rejected", "reason": exc.code}
        async with self._smoke_check_lock:
            instance = self._smoke_instance()
            settings = self.store.get_settings()
            _log_smoke_started(command, instance, settings)
            result = await self._execute_smoke_check(command, instance)
            _log_smoke_completed(command, result, instance, settings)
            return {"status": "completed" if result["status"] == "passed" else "failed", "result": result}

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
                    expected = command["expected_label"]
                    label_ready = any(
                        str(label.get("id") or "") == expected["id"]
                        or str(label.get("name") or "") == expected["name"]
                        for label in labels
                        if isinstance(label, dict)
                    )
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
