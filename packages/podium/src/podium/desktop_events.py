from __future__ import annotations

from typing import Any


def unavailable_state(reason: str) -> dict[str, str]:
    return {"kind": "unavailable", "reason": reason}


def failure_state(
    *,
    kind: str,
    error_code: str,
    sanitized_reason: str,
    action_required: bool,
    retryable: bool,
    next_action: str,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "error_code": error_code,
        "sanitized_reason": sanitized_reason,
        "action_required": action_required,
        "retryable": retryable,
        "next_action": next_action,
    }
