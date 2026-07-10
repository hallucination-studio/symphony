from __future__ import annotations

import logging
from typing import Any

from .conductor_managed_run_attempts import active_attempt_records

LOGGER = logging.getLogger("conductor.conductor_managed_run_coordinator")


def _log_blocked(*, run_id: str, work_item_id: str, error_code: str, reason: str, action_required: str) -> None:
    LOGGER.error(
        "event=managed_run_blocked run_id=%s work_item_id=%s error_code=%s sanitized_reason=%s action_required=%s retryable=false",
        run_id,
        work_item_id or "-",
        error_code,
        _sanitize_reason(reason),
        action_required,
    )


def _sanitize_reason(reason: str) -> str:
    text = str(reason or "blocked").replace("\n", " ").replace("\r", " ")
    for marker in ("token=", "password=", "secret=", "authorization="):
        if marker in text.lower():
            return "redacted_sensitive_reason"
    return text[:300]


def _output_tail(stdout: Any, stderr: Any) -> str:
    text = f"{_to_text(stdout)}\n{_to_text(stderr)}".replace("\n", " ").replace("\r", " ").strip()
    return _sanitize_reason(text or "no output")[-200:]


def _review_relevant_file(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip()
    if not normalized:
        return False
    parts = [part for part in normalized.rstrip("/").split("/") if part]
    if any(part in {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".tox", ".nox"} for part in parts):
        return False
    return not normalized.endswith((".pyc", ".pyo", ".coverage"))


def _active_work_item_ids(run: dict[str, Any]) -> set[str]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    attempts = active_attempt_records(payload, kind="work_item")
    ids = {
        str(attempt.get("work_item_id") or "")
        for attempt in attempts
        if isinstance(attempt, dict)
    }
    active = str(run.get("active_work_item_id") or "")
    if active:
        ids.add(active)
    return {item_id for item_id in ids if item_id}


def _parallel_compatible(candidate: dict[str, Any], active: dict[str, Any]) -> bool:
    candidate_policy = _parallel_policy(candidate)
    active_policy = _parallel_policy(active)
    if not (candidate_policy.get("safe_to_parallelize") and active_policy.get("safe_to_parallelize")):
        return False
    candidate_group = str(candidate_policy.get("parallel_group") or "")
    active_group = str(active_policy.get("parallel_group") or "")
    return not (candidate_group and active_group and candidate_group != active_group)


def _parallel_policy(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    policy = payload.get("parallelization") if isinstance(payload.get("parallelization"), dict) else {}
    return policy


def _to_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return str(value or "")
