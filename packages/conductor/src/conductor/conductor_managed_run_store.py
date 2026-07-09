from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.managed_runs import Checkpoint, ManagedRunPlan, ManagedRunState, WorkItemState


@dataclass(frozen=True)
class ManagedRunDispatchAccepted:
    run_id: str
    parent_issue_id: str
    issue_identifier: str


class ConductorManagedRunStore:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.db_path = data_root / "managed_run.db"
        self.data_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def accept_dispatch(self, event: dict[str, Any], *, instance_id: str) -> ManagedRunDispatchAccepted:
        parent_issue_id = str(event.get("issue_id") or event.get("parent_issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or parent_issue_id).strip()
        if not parent_issue_id and not issue_identifier:
            raise ValueError("dispatch requires issue_id or issue_identifier")
        existing = self._existing_run(parent_issue_id=parent_issue_id, issue_identifier=issue_identifier)
        if existing is not None:
            return ManagedRunDispatchAccepted(
                run_id=str(existing["run_id"]),
                parent_issue_id=str(existing["parent_issue_id"]),
                issue_identifier=str(existing["issue_identifier"]),
            )
        run_id = str(event.get("run_id") or f"run-{uuid4().hex}")
        now = _now()
        payload = {
            "issue_title": str(event.get("issue_title") or event.get("title") or issue_identifier or parent_issue_id),
            "issue_description": str(event.get("issue_description") or event.get("description") or ""),
            "agent_session_id": str(event.get("agent_session_id") or ""),
            "instance_id": instance_id,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO managed_run_runs (
                  run_id, parent_issue_id, issue_identifier, instance_id, state,
                  plan_version, backend_session_id, payload_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 0, '', ?, ?, ?)
                """,
                (
                    run_id,
                    parent_issue_id or issue_identifier,
                    issue_identifier or parent_issue_id,
                    instance_id,
                    ManagedRunState.QUEUED.value,
                    _json_dumps(payload),
                    now,
                    now,
                ),
            )
        return ManagedRunDispatchAccepted(run_id=run_id, parent_issue_id=parent_issue_id or issue_identifier, issue_identifier=issue_identifier or parent_issue_id)

    def save_plan(self, run_id: str, plan: ManagedRunPlan, *, backend_session_id: str = "") -> int:
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT COALESCE(MAX(version), 0) AS version FROM managed_run_plan_versions WHERE run_id = ?", (run_id,)).fetchone()
            version = int(row["version"] if row is not None else 0) + 1
            existing_rows = connection.execute("SELECT work_item_id FROM managed_run_work_items WHERE run_id = ?", (run_id,)).fetchall()
            existing_ids = {str(existing["work_item_id"]) for existing in existing_rows}
            planned_ids = {item.id for item in plan.work_items}
            connection.execute(
                """
                INSERT INTO managed_run_plan_versions (run_id, version, payload_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (run_id, version, _json_dumps(plan.to_dict()), now),
            )
            for index, item in enumerate(plan.work_items):
                connection.execute(
                    """
                    INSERT INTO managed_run_work_items (
                      run_id, work_item_id, plan_version, position, state, gate_status,
                      payload_json, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, '', ?, ?)
                    ON CONFLICT(run_id, work_item_id) DO UPDATE SET
                      plan_version = excluded.plan_version,
                      position = excluded.position,
                      payload_json = excluded.payload_json,
                      updated_at = excluded.updated_at
                    """,
                    (
                        run_id,
                        item.id,
                        version,
                        index,
                        WorkItemState.TODO.value,
                        _json_dumps(item.to_dict()),
                        now,
                    ),
                )
            for removed_id in sorted(existing_ids - planned_ids):
                connection.execute(
                    """
                    UPDATE managed_run_work_items
                    SET state = ?, gate_status = ?, updated_at = ?
                    WHERE run_id = ? AND work_item_id = ?
                    """,
                    (
                        WorkItemState.CANCELLED.value,
                        f"cancelled_by_plan_revision:{version}",
                        now,
                        run_id,
                        removed_id,
                    ),
                )
            connection.execute(
                """
                UPDATE managed_run_runs
                SET state = ?, plan_version = ?, backend_session_id = ?, payload_json = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (
                    ManagedRunState.READY.value,
                    version,
                    backend_session_id,
                    _json_dumps({**self._run_payload(connection, run_id), "plan_validation_failures": 0}),
                    now,
                    run_id,
                ),
            )
        return version

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM managed_run_runs WHERE run_id = ?", (run_id,)).fetchone()
        return _run_from_row(row) if row is not None else None

    def list_runs(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM managed_run_runs ORDER BY created_at, run_id").fetchall()
        return [_run_from_row(row) for row in rows]

    def list_work_items(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM managed_run_work_items WHERE run_id = ? ORDER BY position, work_item_id",
                (run_id,),
            ).fetchall()
        return [_work_item_from_row(row) for row in rows]

    def get_plan(self, run_id: str, version: int | None = None) -> ManagedRunPlan | None:
        query = "SELECT payload_json FROM managed_run_plan_versions WHERE run_id = ?"
        params: tuple[Any, ...]
        if version is None:
            query += " ORDER BY version DESC LIMIT 1"
            params = (run_id,)
        else:
            query += " AND version = ?"
            params = (run_id, version)
        with self.connect() as connection:
            row = connection.execute(query, params).fetchone()
        if row is None:
            return None
        return ManagedRunPlan.from_dict(_json_loads(row["payload_json"]))

    def update_run_state(self, run_id: str, state: ManagedRunState, *, active_work_item_id: str | None = None, reason: str = "") -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE managed_run_runs
                SET state = ?, active_work_item_id = ?, latest_reason = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (state.value, active_work_item_id or "", reason, _now(), run_id),
            )

    def record_plan_validation_failure(self, run_id: str, *, reason: str) -> int:
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            payload = self._run_payload(connection, run_id)
            failures = int(payload.get("plan_validation_failures") or 0) + 1
            payload["plan_validation_failures"] = failures
            payload["latest_plan_validation_error"] = reason
            connection.execute(
                """
                UPDATE managed_run_runs
                SET payload_json = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (_json_dumps(payload), now, run_id),
            )
        return failures

    def merge_run_payload(self, run_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            payload = {**self._run_payload(connection, run_id), **updates}
            connection.execute(
                """
                UPDATE managed_run_runs
                SET payload_json = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (_json_dumps(payload), now, run_id),
            )
        return payload

    def update_work_item_state(
        self,
        run_id: str,
        work_item_id: str,
        state: WorkItemState,
        *,
        gate_status: str = "",
        result: dict[str, Any] | None = None,
    ) -> None:
        with self.connect() as connection:
            if result is None:
                connection.execute(
                    """
                    UPDATE managed_run_work_items
                    SET state = ?, gate_status = ?, updated_at = ?
                    WHERE run_id = ? AND work_item_id = ?
                    """,
                    (state.value, gate_status, _now(), run_id, work_item_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE managed_run_work_items
                    SET state = ?, gate_status = ?, result_json = ?, updated_at = ?
                    WHERE run_id = ? AND work_item_id = ?
                    """,
                    (
                        state.value,
                        gate_status,
                        _json_dumps(result),
                        _now(),
                        run_id,
                        work_item_id,
                    ),
                )

    def record_linear_projection(
        self,
        run_id: str,
        work_item_id: str,
        *,
        linear_issue_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        projection_id = f"{run_id}:{work_item_id or 'parent'}"
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO managed_run_linear_projections (
                  projection_id, run_id, work_item_id, linear_issue_id, metadata_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(projection_id) DO UPDATE SET
                  linear_issue_id = excluded.linear_issue_id,
                  metadata_json = excluded.metadata_json,
                  updated_at = excluded.updated_at
                """,
                (projection_id, run_id, work_item_id, linear_issue_id, _json_dumps(metadata), now),
            )
        return {
            "projection_id": projection_id,
            "run_id": run_id,
            "work_item_id": work_item_id,
            "linear_issue_id": linear_issue_id,
            "metadata": _json_loads(_json_dumps(metadata)),
            "updated_at": now,
        }

    def list_linear_projections(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM managed_run_linear_projections WHERE run_id = ? ORDER BY projection_id",
                (run_id,),
            ).fetchall()
        return [_projection_from_row(row) for row in rows]

    def record_checkpoint_result(
        self,
        run_id: str,
        *,
        after: list[str],
        verify: list[str],
        passed: bool,
        reason: str = "",
    ) -> dict[str, Any]:
        checkpoint_key = checkpoint_key_for(Checkpoint(after=after, verify=verify))
        now = _now()
        payload = {
            "checkpoint_key": checkpoint_key,
            "run_id": run_id,
            "after": list(after),
            "verify": list(verify),
            "passed": bool(passed),
            "reason": reason,
            "updated_at": now,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO managed_run_checkpoint_results (
                  run_id, checkpoint_key, after_json, verify_json, passed, reason, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, checkpoint_key) DO UPDATE SET
                  after_json = excluded.after_json,
                  verify_json = excluded.verify_json,
                  passed = excluded.passed,
                  reason = excluded.reason,
                  updated_at = excluded.updated_at
                """,
                (
                    run_id,
                    checkpoint_key,
                    _json_dumps({"items": list(after)}),
                    _json_dumps({"commands": list(verify)}),
                    1 if passed else 0,
                    reason,
                    now,
                ),
            )
        return payload

    def list_checkpoint_results(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM managed_run_checkpoint_results WHERE run_id = ? ORDER BY checkpoint_key",
                (run_id,),
            ).fetchall()
        return [_checkpoint_result_from_row(row) for row in rows]

    def recovery_cursor(self, run_id: str) -> dict[str, Any]:
        items = self.list_work_items(run_id)
        verified = [item["work_item_id"] for item in items if item["state"] == WorkItemState.DONE.value]
        next_item = next((item for item in items if item["state"] != WorkItemState.DONE.value), None)
        run = self.get_run(run_id) or {}
        return {
            "run_id": run_id,
            "backend_session_id": str(run.get("backend_session_id") or ""),
            "verified_work_item_ids": verified,
            "next_work_item_id": next_item["work_item_id"] if next_item else None,
            "state": run.get("state"),
        }

    def managed_run_view(self) -> dict[str, Any]:
        runs = []
        attempts: list[dict[str, Any]] = []
        for run in self.list_runs():
            payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
            run_attempts = _run_attempts_for_view(str(run["run_id"]), payload)
            attempts.extend(run_attempts)
            runs.append(
                {
                    **run,
                    "work_items": self.list_work_items(str(run["run_id"])),
                    "linear_projections": self.list_linear_projections(str(run["run_id"])),
                    "checkpoint_results": self.list_checkpoint_results(str(run["run_id"])),
                    "attempts": run_attempts,
                }
            )
        return {"runs": runs, "attempts": attempts}

    def _existing_run(self, *, parent_issue_id: str, issue_identifier: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM managed_run_runs
                WHERE parent_issue_id IN (?, ?) OR issue_identifier IN (?, ?)
                ORDER BY created_at
                LIMIT 1
                """,
                (parent_issue_id, issue_identifier, parent_issue_id, issue_identifier),
            ).fetchone()
        return _run_from_row(row) if row is not None else None

    def _run_payload(self, connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
        row = connection.execute("SELECT payload_json FROM managed_run_runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            return {}
        return _json_loads(row["payload_json"])

    def _init_db(self) -> None:
        with self.connect() as connection:
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


__all__ = ["ConductorManagedRunStore", "ManagedRunDispatchAccepted", "checkpoint_key_for"]
