from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from performer_api.managed_runs import Checkpoint


def init_managed_run_db(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
                        CREATE TABLE IF NOT EXISTS managed_run_runs (
                          run_id TEXT PRIMARY KEY,
                          parent_issue_id TEXT NOT NULL,
                          issue_identifier TEXT NOT NULL,
                          instance_id TEXT NOT NULL,
                          state TEXT NOT NULL,
                          active_work_item_id TEXT NOT NULL DEFAULT '',
                          latest_reason TEXT NOT NULL DEFAULT '',
                          plan_version INTEGER NOT NULL,
                          backend_session_id TEXT NOT NULL,
                          payload_json TEXT NOT NULL,
                          created_at TEXT NOT NULL,
                          updated_at TEXT NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS managed_run_plan_versions (
                          run_id TEXT NOT NULL,
                          version INTEGER NOT NULL,
                          payload_json TEXT NOT NULL,
                          created_at TEXT NOT NULL,
                          PRIMARY KEY (run_id, version)
                        );
                        CREATE TABLE IF NOT EXISTS managed_run_work_items (
                          run_id TEXT NOT NULL,
                          work_item_id TEXT NOT NULL,
                          plan_version INTEGER NOT NULL,
                          position INTEGER NOT NULL,
                          state TEXT NOT NULL,
                          gate_status TEXT NOT NULL,
                          payload_json TEXT NOT NULL,
                          result_json TEXT NOT NULL DEFAULT '{}',
                          updated_at TEXT NOT NULL,
                          PRIMARY KEY (run_id, work_item_id)
                        );
                        CREATE TABLE IF NOT EXISTS managed_run_linear_projections (
                          projection_id TEXT PRIMARY KEY,
                          run_id TEXT NOT NULL,
                          work_item_id TEXT NOT NULL,
                          linear_issue_id TEXT NOT NULL,
                          metadata_json TEXT NOT NULL,
                          updated_at TEXT NOT NULL
                        );
                        CREATE TABLE IF NOT EXISTS managed_run_checkpoint_results (
                          run_id TEXT NOT NULL,
                          checkpoint_key TEXT NOT NULL,
                          after_json TEXT NOT NULL,
                          verify_json TEXT NOT NULL,
                          passed INTEGER NOT NULL,
                          reason TEXT NOT NULL,
                          updated_at TEXT NOT NULL,
                          PRIMARY KEY (run_id, checkpoint_key)
                        );
                        """
    )


def _run_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "run_id": row["run_id"],
        "parent_issue_id": row["parent_issue_id"],
        "issue_identifier": row["issue_identifier"],
        "instance_id": row["instance_id"],
        "state": row["state"],
        "active_work_item_id": row["active_work_item_id"],
        "latest_reason": row["latest_reason"],
        "plan_version": int(row["plan_version"]),
        "backend_session_id": row["backend_session_id"],
        "payload": _json_loads(row["payload_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _work_item_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "run_id": row["run_id"],
        "work_item_id": row["work_item_id"],
        "plan_version": int(row["plan_version"]),
        "position": int(row["position"]),
        "state": row["state"],
        "gate_status": row["gate_status"],
        "payload": _json_loads(row["payload_json"]),
        "result": _json_loads(row["result_json"]),
        "updated_at": row["updated_at"],
    }


def _projection_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "projection_id": row["projection_id"],
        "run_id": row["run_id"],
        "work_item_id": row["work_item_id"],
        "linear_issue_id": row["linear_issue_id"],
        "metadata": _json_loads(row["metadata_json"]),
        "updated_at": row["updated_at"],
    }


def _checkpoint_result_from_row(row: sqlite3.Row) -> dict[str, Any]:
    after = _json_loads(row["after_json"]).get("items", [])
    verify = _json_loads(row["verify_json"]).get("commands", [])
    return {
        "checkpoint_key": row["checkpoint_key"],
        "run_id": row["run_id"],
        "after": [str(item) for item in after] if isinstance(after, list) else [],
        "verify": [str(item) for item in verify] if isinstance(verify, list) else [],
        "passed": bool(row["passed"]),
        "reason": row["reason"],
        "updated_at": row["updated_at"],
    }


def _run_attempts_for_view(run_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    for attempt in payload.get("completed_attempts") or []:
        if isinstance(attempt, dict):
            attempts.append({"run_id": run_id, **attempt})
    for attempt in payload.get("active_attempts") or []:
        if isinstance(attempt, dict):
            attempts.append({"run_id": run_id, **attempt, "state": attempt.get("state") or "running"})
    return attempts


def checkpoint_key_for(checkpoint: Checkpoint) -> str:
    after = ",".join(checkpoint.after)
    verify = " && ".join(checkpoint.verify)
    return f"{after}::{verify}"


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _json_loads(payload: str) -> dict[str, Any]:
    try:
        loaded = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
