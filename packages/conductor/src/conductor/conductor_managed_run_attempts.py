from __future__ import annotations

from typing import Any


TERMINAL_ATTEMPT_STATES = frozenset({"succeeded", "failed", "blocked", "cancelled", "timed_out"})


def completed_attempt_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("completed_attempts")
    return [dict(attempt) for attempt in raw if isinstance(attempt, dict)] if isinstance(raw, list) else []


def active_attempt_records(payload: dict[str, Any], *, kind: str | None = None) -> list[dict[str, Any]]:
    raw = payload.get("active_attempts")
    attempts = [dict(attempt) for attempt in raw if isinstance(attempt, dict)] if isinstance(raw, list) else []
    if not attempts:
        current = payload.get("active_attempt")
        if isinstance(current, dict) and current:
            attempts = [dict(current)]
    terminal_ids = {attempt_id(attempt) for attempt in completed_attempt_records(payload) if attempt_id(attempt)}
    active = [attempt for attempt in attempts if attempt_id(attempt) not in terminal_ids]
    return [attempt for attempt in active if kind is None or str(attempt.get("kind") or "") == kind]


def canonical_attempt_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for attempt in completed_attempt_records(payload):
        identifier = attempt_id(attempt)
        if identifier and identifier in seen_ids:
            continue
        attempts.append(attempt)
        if identifier:
            seen_ids.add(identifier)
    for attempt in active_attempt_records(payload):
        identifier = attempt_id(attempt)
        if identifier and identifier in seen_ids:
            continue
        attempts.append(attempt)
        if identifier:
            seen_ids.add(identifier)
    return attempts


def attempt_integrity_errors(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    completed_ids: set[str] = set()
    for attempt in completed_attempt_records(payload):
        identifier = attempt_id(attempt)
        if not identifier:
            errors.append("completed_attempt_id_missing")
        elif identifier in completed_ids:
            errors.append(f"completed_attempt_duplicate:{identifier}")
        else:
            completed_ids.add(identifier)
        state = str(attempt.get("state") or "").lower()
        if state not in TERMINAL_ATTEMPT_STATES:
            errors.append(f"completed_attempt_nonterminal:{identifier or 'missing'}:{state or 'missing'}")
    active_ids: set[str] = set()
    raw = payload.get("active_attempts")
    active = [dict(attempt) for attempt in raw if isinstance(attempt, dict)] if isinstance(raw, list) else []
    if not active:
        current = payload.get("active_attempt")
        if isinstance(current, dict) and current:
            active = [dict(current)]
    for attempt in active:
        identifier = attempt_id(attempt)
        if not identifier:
            errors.append("active_attempt_id_missing")
            continue
        if identifier in completed_ids:
            errors.append(f"active_attempt_already_terminal:{identifier}")
        if identifier in active_ids:
            errors.append(f"active_attempt_duplicate:{identifier}")
        active_ids.add(identifier)
        state = str(attempt.get("state") or "running").lower()
        if state in TERMINAL_ATTEMPT_STATES:
            errors.append(f"active_attempt_terminal:{identifier}:{state}")
    return sorted(set(errors))


def next_attempt_number(payload: dict[str, Any], *, kind: str, work_item_id: str = "") -> int:
    matching = [
        attempt
        for attempt in _all_attempt_records(payload)
        if str(attempt.get("kind") or "") == kind and str(attempt.get("work_item_id") or "") == work_item_id
    ]
    numbers = [int(attempt.get("attempt_number") or 0) for attempt in matching if str(attempt.get("attempt_number") or "").isdigit()]
    return max(numbers, default=len({attempt_id(attempt) for attempt in matching if attempt_id(attempt)})) + 1


def attempt_id(attempt: dict[str, Any]) -> str:
    return str(attempt.get("attempt_id") or "")


def _all_attempt_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    attempts = [*completed_attempt_records(payload), *active_attempt_records(payload)]
    failed = payload.get("last_failed_attempt")
    if isinstance(failed, dict):
        attempts.append(dict(failed))
    return attempts


__all__ = [
    "TERMINAL_ATTEMPT_STATES",
    "active_attempt_records",
    "attempt_id",
    "attempt_integrity_errors",
    "canonical_attempt_records",
    "completed_attempt_records",
    "next_attempt_number",
]
