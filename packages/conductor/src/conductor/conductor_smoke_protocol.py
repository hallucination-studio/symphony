from __future__ import annotations

import re
from typing import Any

from performer_api.labels import is_managed_project_label


CHECK_NAMES = (
    "binding_identity",
    "repository_readiness",
    "linear_proxy_access",
    "runtime_config_validity",
    "project_label_state",
)


class SmokeCommandError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def normalize_smoke_command(payload: dict[str, Any]) -> dict[str, Any]:
    repository = payload.get("repository") if isinstance(payload.get("repository"), dict) else {}
    expected_label = payload.get("expected_label") if isinstance(payload.get("expected_label"), dict) else {}
    label_name = expected_label.get("name")
    command = {
        "type": str(payload.get("type") or ""),
        "smoke_check_id": _identifier(payload.get("smoke_check_id")),
        "binding_id": _identifier(payload.get("binding_id")),
        "config_version": _positive_int(payload.get("config_version")),
        "linear_project_id": _identifier(payload.get("linear_project_id")),
        "project_slug": str(payload.get("project_slug") or "").strip(),
        "repository": {
            "mode": str(repository.get("mode") or ""),
            "value": str(repository.get("value") or "").strip(),
        },
        "expected_label": {
            "id": _identifier(expected_label.get("id")),
            "name": str(label_name or ""),
        },
        "runtime_config_version": _positive_int(payload.get("runtime_config_version")),
    }
    if command["type"] != "smoke.check" or not command["project_slug"]:
        raise SmokeCommandError("invalid_smoke_command", "Smoke command identity is incomplete")
    if command["repository"]["mode"] not in {"local_path", "git_url"} or not command["repository"]["value"]:
        raise SmokeCommandError("invalid_smoke_command", "Smoke command repository is invalid")
    if not is_managed_project_label(label_name):
        raise SmokeCommandError("invalid_smoke_command", "Smoke command project label is invalid")
    return command


def smoke_result(
    command: dict[str, Any],
    checks: dict[str, bool],
    failure: tuple[str, str, str, bool] | None,
) -> dict[str, Any]:
    passed = all(checks.get(name) is True for name in CHECK_NAMES)
    if passed:
        error_code, reason, action, retryable = "", "", "", False
    else:
        error_code, reason, action, retryable = failure or (
            "smoke_check_failed",
            "Conductor smoke check failed",
            "inspect_conductor_smoke_result",
            True,
        )
    return {
        "smoke_check_id": command["smoke_check_id"],
        "binding_id": command["binding_id"],
        "status": "passed" if passed else "failed",
        "checks": [{"name": name, "passed": bool(checks.get(name))} for name in CHECK_NAMES],
        "error_code": error_code,
        "sanitized_reason": sanitize_reason(reason) if reason else "",
        "retryable": retryable,
        "action_required": action,
        "next_action": "" if passed else "rerun_smoke_check",
    }


def sanitize_reason(value: Any) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").replace("\x00", " ").strip()
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(
        r"(?i)\b(access_token|refresh_token|api_key|token|password|client_secret|cookie)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    return text[:500] or "runtime_error"


def _identifier(value: Any) -> str:
    identifier = str(value or "").strip()
    if not identifier or len(identifier) > 200 or re.fullmatch(r"[A-Za-z0-9._:-]+", identifier) is None:
        raise SmokeCommandError("invalid_smoke_command", "Smoke command identifier is invalid")
    return identifier


def _positive_int(value: Any) -> int:
    if isinstance(value, bool):
        raise SmokeCommandError("invalid_smoke_command", "Smoke command version is invalid")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise SmokeCommandError("invalid_smoke_command", "Smoke command version is invalid") from exc
    if number <= 0:
        raise SmokeCommandError("invalid_smoke_command", "Smoke command version is invalid")
    return number
