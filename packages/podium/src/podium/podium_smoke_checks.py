from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from performer_api.labels import managed_project_label_name

from .podium_shared import runtime_group_alias, utc_now_iso


LOGGER = logging.getLogger(__name__)
SMOKE_TIMEOUT_SECONDS = 120
MAX_CAS_ATTEMPTS = 5
RUNTIME_CHECK_NAMES = {
    "binding_identity",
    "repository_readiness",
    "linear_proxy_access",
    "runtime_config_validity",
    "project_label_state",
}
REQUIRED_LINEAR_SCOPES = {"read", "write", "app:assignable"}


class SmokeCheckError(RuntimeError):
    def __init__(self, status_code: int, code: str, reason: str) -> None:
        super().__init__(reason)
        self.status_code = status_code
        self.code = code
        self.reason = reason


def validate_runtime_result(payload: dict[str, Any]) -> dict[str, Any]:
    status = str(payload.get("status") or "")
    checks = payload.get("checks")
    if status not in {"passed", "failed"} or not isinstance(checks, list):
        raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke result is invalid")
    normalized_checks: list[dict[str, Any]] = []
    for raw in checks:
        if not isinstance(raw, dict) or type(raw.get("passed")) is not bool:
            raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke checks are invalid")
        normalized_checks.append({"name": str(raw.get("name") or ""), "passed": raw["passed"]})
    names = [check["name"] for check in normalized_checks]
    if set(names) != RUNTIME_CHECK_NAMES or len(names) != len(RUNTIME_CHECK_NAMES):
        raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke checks are incomplete")
    if (status == "passed") != all(check["passed"] for check in normalized_checks):
        raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke status contradicts its checks")
    if type(payload.get("retryable")) is not bool:
        raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke retryability must be boolean")
    error_code = clean_code(payload.get("error_code"), required=status == "failed")
    reason = sanitize_reason(payload.get("sanitized_reason"))
    if status == "failed" and not reason:
        raise SmokeCheckError(400, "invalid_smoke_result", "Failed runtime smoke result requires a reason")
    action_required = clean_code(payload.get("action_required"), required=status == "failed")
    next_action = clean_code(payload.get("next_action"), required=status == "failed")
    if status == "passed" and any((error_code, reason, payload["retryable"], action_required, next_action)):
        raise SmokeCheckError(400, "invalid_smoke_result", "Passed runtime smoke result cannot contain errors")
    return {
        "status": status,
        "checks": normalized_checks,
        "error_code": error_code,
        "sanitized_reason": reason,
        "retryable": payload["retryable"],
        "action_required": action_required,
        "next_action": next_action,
    }


def aggregate_smoke_result(result: dict[str, Any]) -> dict[str, Any]:
    entries = result["conductors"]
    if any(row.get("status") not in {"passed", "failed"} for row in entries):
        return result
    failed = [row for row in entries if row.get("status") == "failed"]
    now = utc_now_iso()
    return {
        **result,
        "status": "failed" if failed else "passed",
        "recommendations": [str(row.get("next_action") or row.get("action_required")) for row in failed],
        "error_code": "smoke_check_failed" if failed else "",
        "sanitized_reason": "One or more Conductor smoke checks failed" if failed else "",
        "retryable": any(bool(row.get("retryable")) for row in failed),
        "action_required": "inspect_conductor_smoke_results" if failed else "",
        "next_action": "rerun_smoke_check" if failed else "",
        "timestamp": now,
        "completed_at": now,
    }


def intake_ready(installation: dict[str, Any] | None) -> bool:
    if not installation:
        return False
    polling = installation.get("reconciliation_state") == "healthy" and bool(installation.get("last_reconciliation_at"))
    return bool(polling)


def installation_identity_ready(installation: dict[str, Any] | None, callback_ready: bool) -> bool:
    if not installation or not callback_ready:
        return False
    try:
        expires_at = datetime.fromisoformat(str(installation.get("expires_at") or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    scopes = {str(scope) for scope in installation.get("scope") or []}
    return bool(
        installation.get("state") == "ready"
        and expires_at.tzinfo is not None
        and expires_at > datetime.now(timezone.utc)
        and REQUIRED_LINEAR_SCOPES <= scopes
        and str(installation.get("actor") or "").lower() == "app"
        and installation.get("linear_organization_id")
        and installation.get("app_user_id")
    )


def repository_public(raw: Any) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    source_type = str(source.get("type") or source.get("mode") or "")
    return {"mode": "git_url" if source_type == "git" else source_type, "value": str(source.get("value") or "")}


def check(name: str, passed: bool) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed)}


def recommendation(name: str) -> str:
    return {
        "callback_acceptance": "Authorize a Linear application",
        "installation_identity": "Reauthorize Linear with an app actor",
        "selected_project_access": "Select accessible Linear projects",
        "intake_health": "Restore healthy Linear reconciliation",
        "ready_bindings": "Bind every selected project to a ready Conductor",
        "runtime_connectivity": "Bring every bound Conductor online",
        "runtime_config_validity": "Verify the local Codex runtime",
    }[name]


def result_fingerprint(row: dict[str, Any]) -> tuple[Any, ...]:
    keys = ("status", "checks", "error_code", "sanitized_reason", "retryable", "action_required", "next_action")
    return tuple(row.get(key) for key in keys)


def clean_code(value: Any, *, required: bool = False) -> str:
    code = str(value or "").strip()
    if (required and not code) or (code and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) is None):
        raise SmokeCheckError(400, "invalid_smoke_result", "Runtime smoke error fields are invalid")
    return code


def sanitize_reason(value: Any) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").replace("\x00", " ").strip()
    text = re.sub(
        r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(
        r"(?i)\b(access_token|refresh_token|api_key|token|password|client_secret|cookie)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    return text[:500]


class PodiumSmokeChecksMixin:
    async def start_smoke_check(self, workspace_id: str) -> dict[str, Any]:
        for _attempt in range(MAX_CAS_ATTEMPTS):
            current = await self.get_smoke_result(workspace_id)
            if isinstance(current, dict) and current.get("status") == "running":
                await self._enqueue_smoke_commands(current)
                return current
            expected_revision = int((current or {}).get("revision") or 0)
            result = await self._new_smoke_result(workspace_id, expected_revision + 1)
            if not await self.store.compare_and_save_smoke_result(workspace_id, expected_revision, result):
                continue
            await self.sync_smoke_onboarding(workspace_id)
            await self._record_smoke_start(result)
            return result
        raise SmokeCheckError(409, "smoke_check_conflict", "Smoke check changed concurrently; retry")

    async def _new_smoke_result(self, workspace_id: str, revision: int) -> dict[str, Any]:
        check_id = f"smoke_{secrets.token_urlsafe(12)}"
        checks, conductors = await self._smoke_preflight(workspace_id)
        failed = [item for item in checks if not item["passed"]]
        now = utc_now_iso()
        return {
            "smoke_check_id": check_id,
            "workspace_id": workspace_id,
            "revision": revision,
            "status": "failed" if failed else "running",
            "checks": checks,
            "conductors": conductors,
            "recommendations": [recommendation(str(item["name"])) for item in failed],
            "error_code": "smoke_prerequisites_failed" if failed else "",
            "sanitized_reason": "Smoke check prerequisites are not ready" if failed else "",
            "retryable": bool(failed),
            "action_required": "fix_smoke_prerequisites" if failed else "",
            "next_action": "rerun_smoke_check" if failed else "",
            "timestamp": now,
            "completed_at": now if failed else None,
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=SMOKE_TIMEOUT_SECONDS)
            ).isoformat().replace("+00:00", "Z"),
        }

    async def _record_smoke_start(self, result: dict[str, Any]) -> None:
        if result["status"] == "failed":
            LOGGER.error(
                "event=podium_smoke_check_failed smoke_check_id=%s workspace_id=%s error_type=SmokePrerequisiteError "
                "error_code=smoke_prerequisites_failed sanitized_reason=%s action_required=fix_smoke_prerequisites "
                "retryable=true next_action=rerun_smoke_check",
                result["smoke_check_id"],
                result["workspace_id"],
                result["sanitized_reason"],
            )
            return
        await self._enqueue_smoke_commands(result)
        LOGGER.info(
            "event=podium_smoke_check_started smoke_check_id=%s workspace_id=%s runtime_count=%s retryable=false",
            result["smoke_check_id"],
            result["workspace_id"],
            len(result["conductors"]),
        )

    async def submit_smoke_check_result(
        self,
        runtime: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        workspace_id = str(runtime.get("user_id") or "")
        runtime_id = str(runtime.get("id") or "")
        normalized = validate_runtime_result(payload)
        for _attempt in range(MAX_CAS_ATTEMPTS):
            current = await self.get_smoke_result(workspace_id)
            if not isinstance(current, dict):
                raise SmokeCheckError(404, "smoke_check_not_found", "No smoke check is active")
            if str(payload.get("smoke_check_id") or "") != str(current.get("smoke_check_id") or ""):
                raise SmokeCheckError(409, "stale_smoke_check", "Smoke check id is stale")
            entries = [dict(row) for row in current.get("conductors") or [] if isinstance(row, dict)]
            entry = next((row for row in entries if str(row.get("runtime_id") or "") == runtime_id), None)
            if entry is None or str(payload.get("binding_id") or "") != str(entry.get("binding_id") or ""):
                raise SmokeCheckError(409, "smoke_binding_mismatch", "Runtime does not own this smoke binding")
            if entry.get("status") in {"passed", "failed"}:
                if result_fingerprint(entry) == result_fingerprint(normalized):
                    return current
                raise SmokeCheckError(409, "smoke_result_conflict", "Runtime result conflicts with its prior result")
            if current.get("status") != "running" or entry.get("status") != "running":
                raise SmokeCheckError(409, "smoke_check_not_running", "Smoke check is not accepting results")
            entry.update(normalized)
            entry["completed_at"] = utc_now_iso()
            entries = [entry if row.get("runtime_id") == runtime_id else row for row in entries]
            expected_revision = int(current.get("revision") or 0)
            updated = aggregate_smoke_result(
                {**current, "conductors": entries, "revision": expected_revision + 1}
            )
            if not await self.store.compare_and_save_smoke_result(workspace_id, expected_revision, updated):
                continue
            await self.sync_smoke_onboarding(workspace_id)
            _log_runtime_result(updated, entry)
            _log_smoke_completion(updated)
            return updated
        raise SmokeCheckError(409, "smoke_result_conflict", "Smoke result changed concurrently; retry")

    async def expire_smoke_check(
        self,
        workspace_id: str,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        if result.get("status") != "running" or not _is_expired(result.get("expires_at")):
            return result
        expected_revision = int(result.get("revision") or 0)
        expired = _expired_smoke_result(result, expected_revision + 1)
        if not await self.store.compare_and_save_smoke_result(workspace_id, expected_revision, expired):
            latest = await self.store.get_smoke_result(workspace_id)
            return latest if isinstance(latest, dict) else result
        await self.sync_smoke_onboarding(workspace_id)
        _log_smoke_timeout(expired, workspace_id)
        return expired

    async def _smoke_preflight(self, workspace_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        installation = await self.get_active_linear_installation(workspace_id)
        selected = await self.list_selected_linear_projects(workspace_id)
        bindings = await self.store.list_project_bindings_for_user(workspace_id)
        contexts = [await self._smoke_binding_context(binding, installation) for binding in bindings]
        selected_ids = {str(row.get("linear_project_id") or "") for row in selected}
        accessible_ids = {
            str(row.get("id") or "")
            for row in (installation or {}).get("projects") or []
            if isinstance(row, dict)
        }
        callback_ready = bool(installation and installation.get("active") and installation.get("state") == "ready")
        identity_ready = installation_identity_ready(installation, callback_ready)
        project_access = bool(
            identity_ready
            and selected_ids
            and selected_ids <= accessible_ids
            and all(row.get("access_state") == "ready" for row in selected)
        )
        delivery_ready = intake_ready(installation)
        binding_ready = bool(selected_ids and {row["linear_project_id"] for row in contexts} == selected_ids)
        readiness = [
            (
                bool(row.pop("_binding_ready")),
                bool(row.pop("_runtime_ready")),
                bool(row.pop("_config_ready")),
            )
            for row in contexts
        ]
        binding_ready = binding_ready and all(values[0] for values in readiness)
        runtime_ready = bool(readiness and all(values[1] for values in readiness))
        config_ready = bool(readiness and all(values[2] for values in readiness))
        checks = [
            check("callback_acceptance", callback_ready),
            check("installation_identity", identity_ready),
            check("selected_project_access", project_access),
            check("intake_health", delivery_ready),
            check("ready_bindings", binding_ready),
            check("runtime_connectivity", runtime_ready),
            check("runtime_config_validity", config_ready),
        ]
        status = "running" if all(check["passed"] for check in checks) else "blocked"
        return checks, [{**row, "status": status} for row in contexts]

    async def _smoke_binding_context(
        self,
        binding: dict[str, Any],
        installation: dict[str, Any] | None,
    ) -> dict[str, Any]:
        runtime_id = str(binding.get("conductor_id") or "")
        runtime = await self.store.get_runtime(runtime_id)
        group_id = runtime_group_alias(runtime_id)
        repository = repository_public(binding.get("repo_source"))
        binding_ready = bool(
            runtime
            and runtime.get("enrollment_state") == "enrolled"
            and binding.get("state") == "ready"
            and binding.get("active", True)
            and int(binding.get("config_version") or 0) > 0
            and int(binding.get("acknowledged_config_version") or 0) == int(binding.get("config_version") or 0)
            and str(binding.get("installation_id") or "") == str((installation or {}).get("id") or "")
            and str(binding.get("agent_app_user_id") or "") == str((installation or {}).get("app_user_id") or "")
            and repository["mode"] in {"local_path", "git_url"}
            and repository["value"]
            and binding.get("label_id")
            and binding.get("label_name")
            and str((runtime or {}).get("id") or "") == runtime_id
            and str((runtime or {}).get("user_id") or "") == str(binding.get("user_id") or "")
            and str(binding.get("label_name") or "") == managed_project_label_name(
                str((runtime or {}).get("name") or ""),
                str((runtime or {}).get("public_id") or ""),
            )
        )
        return {
            "runtime_id": runtime_id,
            "runtime_group_id": group_id,
            "instance_id": str(binding.get("instance_id") or ""),
            "binding_id": str(binding.get("id") or ""),
            "linear_project_id": str(binding.get("linear_project_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "binding_config_version": int(binding.get("config_version") or 0),
            "runtime_config_version": int(binding.get("config_version") or 0),
            "repository": repository,
            "expected_label": {
                "id": str(binding.get("label_id") or ""),
                "name": str(binding.get("label_name") or ""),
            },
            "checks": [],
            "error_code": "",
            "sanitized_reason": "",
            "retryable": False,
            "action_required": "",
            "next_action": "",
            "_binding_ready": binding_ready,
            "_runtime_ready": bool(runtime_id and await self.is_runtime_online(runtime_id)),
            "_config_ready": bool(runtime_id),
        }

    async def _enqueue_smoke_commands(self, result: dict[str, Any]) -> None:
        for row in result.get("conductors") or []:
            if not isinstance(row, dict) or row.get("status") != "running":
                continue
            command = {
                "type": "smoke.check",
                "smoke_check_id": result["smoke_check_id"],
                "binding_id": row["binding_id"],
                "config_version": row["binding_config_version"],
                **{key: row[key] for key in (
                    "linear_project_id", "project_slug", "repository", "expected_label", "runtime_config_version",
                )},
            }
            dedupe_key = f"smoke:{result['smoke_check_id']}:{row['binding_id']}"
            await self.enqueue_runtime_command_once(str(row["runtime_id"]), dedupe_key, command)


def _expired_smoke_result(result: dict[str, Any], revision: int) -> dict[str, Any]:
    now = utc_now_iso()
    entries = []
    for raw in result.get("conductors") or []:
        row = dict(raw) if isinstance(raw, dict) else {}
        if row.get("status") == "running":
            row.update(
                {
                    "status": "failed",
                    "error_code": "smoke_result_timeout",
                    "sanitized_reason": "Conductor did not report smoke results before the deadline",
                    "retryable": True,
                    "action_required": "restore_conductor_connectivity",
                    "next_action": "rerun_smoke_check",
                    "completed_at": now,
                }
            )
        entries.append(row)
    return {
        **result,
        "revision": revision,
        "status": "failed",
        "conductors": entries,
        "recommendations": ["Restore Conductor connectivity and rerun the smoke check"],
        "error_code": "smoke_check_timeout",
        "sanitized_reason": "Timed out waiting for Conductor smoke results",
        "retryable": True,
        "action_required": "restore_conductor_connectivity",
        "next_action": "rerun_smoke_check",
        "timestamp": now,
        "completed_at": now,
    }


def _log_runtime_result(result: dict[str, Any], entry: dict[str, Any]) -> None:
    level = LOGGER.error if entry["status"] == "failed" else LOGGER.info
    level(
        "event=podium_smoke_result_recorded smoke_check_id=%s runtime_group_id=%s runtime_id=%s "
        "conductor_id=%s instance_id=%s binding_id=%s linear_project_id=%s status=%s error_type=%s "
        "error_code=%s sanitized_reason=%s action_required=%s retryable=%s next_action=%s",
        result["smoke_check_id"], entry.get("runtime_group_id") or "-", entry["runtime_id"],
        entry["runtime_id"], entry.get("instance_id") or "-", entry["binding_id"],
        entry["linear_project_id"], entry["status"], "ConductorSmokeCheckError" if entry["status"] == "failed" else "-",
        entry["error_code"] or "-", entry["sanitized_reason"] or "-", entry["action_required"] or "-",
        str(entry["retryable"]).lower(), entry["next_action"] or "-",
    )


def _log_smoke_timeout(result: dict[str, Any], workspace_id: str) -> None:
    LOGGER.error(
        "event=podium_smoke_check_timeout smoke_check_id=%s workspace_id=%s error_type=SmokeCheckTimeout "
        "error_code=smoke_check_timeout sanitized_reason=%s action_required=restore_conductor_connectivity "
        "retryable=true next_action=rerun_smoke_check",
        result["smoke_check_id"], workspace_id, result["sanitized_reason"],
    )


def _log_smoke_completion(result: dict[str, Any]) -> None:
    if result.get("status") == "running":
        return
    level = LOGGER.error if result.get("status") == "failed" else LOGGER.info
    level(
        "event=podium_smoke_check_%s smoke_check_id=%s workspace_id=%s error_code=%s sanitized_reason=%s "
        "action_required=%s retryable=%s next_action=%s",
        result["status"], result["smoke_check_id"], result.get("workspace_id") or "-",
        result.get("error_code") or "-",
        result.get("sanitized_reason") or "-", result.get("action_required") or "-",
        str(bool(result.get("retryable"))).lower(), result.get("next_action") or "-",
    )


def _is_expired(value: Any) -> bool:
    try:
        deadline = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    if deadline.tzinfo is None:
        return True
    return deadline <= datetime.now(timezone.utc)
