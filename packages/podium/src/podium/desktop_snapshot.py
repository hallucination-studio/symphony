from __future__ import annotations

import logging
import re
import sqlite3
from typing import Any

from .desktop_app import LifecycleSnapshot
from .desktop_events import failure_state, unavailable_state
from .desktop_failures import read_failures
from .desktop_protocol import ProtocolError, encode_frame

DEFAULT_LIMIT = 25
MAX_LIMIT = 25
DEFAULT_STALE_AFTER = 60
_CURSOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")
_DISPLAY_TEXT = re.compile(r"[^\x00-\x1f\x7f]{1,200}")
LOGGER = logging.getLogger(__name__)


def build_desktop_snapshot(
    connection: sqlite3.Connection,
    lifecycle: LifecycleSnapshot,
    *,
    now: int,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
    stale_after: int = DEFAULT_STALE_AFTER,
) -> dict[str, Any]:
    _validate_page(now, limit, cursor, stale_after)
    conductors, next_cursor = _read_conductors(
        connection,
        now=now,
        stale_after=stale_after,
        limit=limit,
        cursor=cursor,
    )
    snapshot = {
        "schema_version": 1,
        "generated_at": now,
        "podium": _podium_state(lifecycle),
        "linear": _linear_state(connection),
        "conductors": {"items": conductors, "next_cursor": next_cursor},
        "performer": unavailable_state("performer_report_unavailable"),
        "runs": unavailable_state("run_report_unavailable"),
        "waits": unavailable_state("wait_report_unavailable"),
        "failures": read_failures(connection, limit=limit),
    }
    try:
        encode_frame(snapshot)
    except ProtocolError:
        LOGGER.warning(
            "event=desktop_snapshot_too_large error_type=invalid_persisted_state "
            "error_code=desktop_snapshot_too_large sanitized_reason=snapshot_too_large "
            "action_required=true retryable=false next_action=inspect_application_data"
        )
        return _oversized_snapshot(now)
    return snapshot


def _oversized_snapshot(now: int) -> dict[str, Any]:
    failure = {
        "kind": "active",
        "error_code": "desktop_snapshot_too_large",
        "correlation_id": "desktop_snapshot_too_large",
        "sanitized_reason": "snapshot_too_large",
        "retry_count": 0,
        "next_action": "inspect_application_data",
        "next_attempt_at": None,
    }
    return {
        "schema_version": 1,
        "generated_at": now,
        "podium": failure_state(
            kind="degraded",
            error_code="desktop_snapshot_too_large",
            sanitized_reason="snapshot_too_large",
            action_required=True,
            retryable=False,
            next_action="inspect_application_data",
        ),
        "linear": unavailable_state("snapshot_too_large"),
        "conductors": {"items": [], "next_cursor": None},
        "performer": unavailable_state("snapshot_too_large"),
        "runs": unavailable_state("snapshot_too_large"),
        "waits": unavailable_state("snapshot_too_large"),
        "failures": [failure],
    }


def _validate_page(
    now: int, limit: int, cursor: str | None, stale_after: int
) -> None:
    if isinstance(now, bool) or not isinstance(now, int) or now < 0:
        raise ValueError("desktop_snapshot_time_invalid")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise ValueError("desktop_snapshot_limit_invalid")
    if cursor is not None and (
        not isinstance(cursor, str) or _CURSOR.fullmatch(cursor) is None
    ):
        raise ValueError("desktop_snapshot_cursor_invalid")
    if (
        isinstance(stale_after, bool)
        or not isinstance(stale_after, int)
        or stale_after < 1
    ):
        raise ValueError("desktop_snapshot_stale_after_invalid")


def _podium_state(lifecycle: LifecycleSnapshot) -> dict[str, Any]:
    if lifecycle.error_code is None:
        return {"kind": lifecycle.status}
    return failure_state(
        kind=lifecycle.status,
        error_code=lifecycle.error_code,
        sanitized_reason=lifecycle.sanitized_reason or "podium_failure",
        action_required=lifecycle.action_required,
        retryable=lifecycle.retryable,
        next_action=lifecycle.next_action,
    )


def _linear_state(connection: sqlite3.Connection) -> dict[str, Any]:
    row = connection.execute(
        """SELECT installation_id, organization_name, status, error_code
        FROM linear_installations ORDER BY installation_id LIMIT 1"""
    ).fetchone()
    if row is None:
        return {"kind": "not_installed"}
    if (
        _CURSOR.fullmatch(row["installation_id"]) is None
        or _DISPLAY_TEXT.fullmatch(row["organization_name"]) is None
    ):
        LOGGER.warning(
            "event=desktop_snapshot_linear_invalid error_type=invalid_persisted_state "
            "error_code=linear_snapshot_invalid sanitized_reason=linear_metadata_invalid "
            "action_required=true retryable=false next_action=reconnect_linear"
        )
        return {
            "kind": "unavailable",
            "reason": "linear_metadata_invalid",
            "error_code": "linear_snapshot_invalid",
            "correlation_id": "linear_snapshot_invalid",
        }
    state: dict[str, Any] = {
        "kind": row["status"],
        "installation_id": row["installation_id"],
        "organization_name": row["organization_name"],
    }
    if row["error_code"] is not None:
        state["error_code"] = row["error_code"]
    return state


def _read_conductors(
    connection: sqlite3.Connection,
    *,
    now: int,
    stale_after: int,
    limit: int,
    cursor: str | None,
) -> tuple[list[dict[str, Any]], str | None]:
    rows = connection.execute(
        """SELECT binding.binding_id, binding.project_id, binding.conductor_id,
            binding.generation AS desired_revision,
            report.generation AS applied_revision, report.instance_id,
            report.status, report.heartbeat_at, report.error_code
        FROM conductor_bindings AS binding
        LEFT JOIN runtime_reports AS report
          ON report.binding_id = binding.binding_id
         AND report.generation = binding.generation
        WHERE binding.active = 1 AND binding.binding_id > ?
        ORDER BY binding.binding_id LIMIT ?""",
        (cursor or "", limit + 1),
    ).fetchall()
    has_more = len(rows) > limit
    page = rows[:limit]
    items = [_conductor_state(row, now=now, stale_after=stale_after) for row in page]
    next_cursor = page[-1]["binding_id"] if has_more else None
    return items, next_cursor


def _conductor_state(
    row: sqlite3.Row, *, now: int, stale_after: int
) -> dict[str, Any]:
    common = {
        "binding_id": row["binding_id"],
        "project_id": row["project_id"],
        "conductor_id": row["conductor_id"],
        "desired_revision": row["desired_revision"],
    }
    if row["applied_revision"] is None:
        return {"kind": "unknown", **common}

    kind = row["status"]
    if row["heartbeat_at"] > now:
        kind = "unknown"
    elif now - row["heartbeat_at"] > stale_after:
        kind = "stale"
    state = {
        "kind": kind,
        **common,
        "applied_revision": row["applied_revision"],
        "instance_id": row["instance_id"],
        "heartbeat_at": row["heartbeat_at"],
    }
    if row["error_code"] is not None:
        state["error_code"] = row["error_code"]
    return state
