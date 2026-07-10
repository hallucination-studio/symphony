from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from performer_api.managed_runs import ManagedRunRuntimeWait


RUNTIME_WAIT_GATE_PREFIX = "runtime_wait:"
RUNTIME_WAIT_PENDING_GATE_PREFIX = "runtime_wait_pending:"
RUNTIME_WAIT_RESOLVED_GATE_PREFIX = "runtime_wait_resolved:"


def runtime_wait_from_turn_payload(payload: dict[str, Any]) -> ManagedRunRuntimeWait | None:
    raw = payload.get("runtime_wait")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("runtime_wait_not_object")
    wait = ManagedRunRuntimeWait.from_dict(raw)
    errors = wait.validation_errors()
    if errors:
        raise ValueError(errors[0])
    return wait


def build_runtime_wait_record(
    run: dict[str, Any],
    attempt: dict[str, Any],
    wait: ManagedRunRuntimeWait,
) -> dict[str, str]:
    run_id = str(run.get("run_id") or "")
    attempt_id = str(attempt.get("attempt_id") or "")
    context = attempt.get("turn_context") if isinstance(attempt.get("turn_context"), dict) else {}
    work_item_id = str(attempt.get("work_item_id") or context.get("work_item_id") or "")
    return {
        "wait_id": f"runtime-wait:{run_id}:{attempt_id}:{wait.wait_kind}",
        "run_id": run_id,
        "work_item_id": work_item_id,
        "attempt_id": attempt_id,
        "turn_kind": str(attempt.get("kind") or ""),
        "lease_id": str(attempt.get("lease_id") or context.get("lease_id") or ""),
        "turn_id": str(attempt.get("turn_id") or context.get("turn_id") or ""),
        "wait_kind": wait.wait_kind,
        "sanitized_message": sanitize_runtime_wait_message(wait.message),
        "status": "waiting",
        "created_at": _now(),
    }


def runtime_waits(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("runtime_waits")
    return [dict(wait) for wait in raw if isinstance(wait, dict)] if isinstance(raw, list) else []


def merge_runtime_wait(wait_records: list[dict[str, Any]], record: dict[str, Any]) -> list[dict[str, Any]]:
    wait_id = str(record.get("wait_id") or "")
    merged = [dict(wait) for wait in wait_records if str(wait.get("wait_id") or "") != wait_id]
    merged.append(dict(record))
    return merged


def waiting_runtime_wait(payload: dict[str, Any], work_item_id: str) -> dict[str, Any] | None:
    for wait in reversed(runtime_waits(payload)):
        if wait.get("status") != "waiting":
            continue
        if str(wait.get("work_item_id") or "") == work_item_id:
            return wait
    return None


def runtime_wait_probe_requested(payload: dict[str, Any], work_item_id: str, enabled: Any) -> bool:
    if enabled is not True and str(enabled).strip().lower() not in {"1", "true", "yes", "on"}:
        return False
    return not any(str(wait.get("work_item_id") or "") == work_item_id for wait in runtime_waits(payload))


def is_runtime_wait_gate_status(gate_status: str) -> bool:
    return gate_status.startswith(RUNTIME_WAIT_GATE_PREFIX) or gate_status.startswith(RUNTIME_WAIT_PENDING_GATE_PREFIX)


def runtime_wait_title(wait: dict[str, Any]) -> str:
    return f"[Human Action] Runtime wait: {str(wait.get('wait_kind') or 'input_required')}"


def runtime_wait_description(wait: dict[str, Any]) -> str:
    return "\n".join(
        [
            "## Symphony Runtime Wait",
            "",
            f"- run_id: {wait.get('run_id') or ''}",
            f"- work_item_id: {wait.get('work_item_id') or 'parent'}",
            f"- wait_id: {wait.get('wait_id') or ''}",
            f"- attempt_id: {wait.get('attempt_id') or ''}",
            f"- lease_id: {wait.get('lease_id') or ''}",
            f"- wait_kind: {wait.get('wait_kind') or ''}",
            f"- status: {wait.get('status') or ''}",
            f"- sanitized_message: {wait.get('sanitized_message') or ''}",
            "- completing this child issue is the runtime-wait resume signal",
        ]
    )


def linear_issue_is_completed(issue: dict[str, Any]) -> bool:
    if str(issue.get("state_type") or "").strip().lower() == "completed":
        return True
    return str(issue.get("state") or "").strip().lower() in {"done", "completed", "canceled", "cancelled"}


def sanitize_runtime_wait_message(value: str) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:300] or "runtime_input_required"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


_SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)\b(token|password|secret|api[_-]?key|access_token|refresh_token)=([^\s,;]+)"), r"\1=[REDACTED]"),
)


__all__ = [
    "RUNTIME_WAIT_GATE_PREFIX",
    "RUNTIME_WAIT_PENDING_GATE_PREFIX",
    "RUNTIME_WAIT_RESOLVED_GATE_PREFIX",
    "build_runtime_wait_record",
    "is_runtime_wait_gate_status",
    "linear_issue_is_completed",
    "merge_runtime_wait",
    "runtime_wait_description",
    "runtime_wait_from_turn_payload",
    "runtime_wait_probe_requested",
    "runtime_wait_title",
    "runtime_waits",
    "waiting_runtime_wait",
]
