from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from performer_api.runtime import RuntimeConfigEnvelope

from .podium_shared import utc_now_iso


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


def valid_runtime_config_version(config: Any, group_id: str) -> int:
    try:
        envelope = RuntimeConfigEnvelope.from_dict(config if isinstance(config, dict) else {})
        envelope.validate()
    except Exception:
        return 0
    return int(envelope.version) if envelope.runtime_group_id == group_id else 0


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
        "runtime_config_validity": "Publish a valid runtime configuration",
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
