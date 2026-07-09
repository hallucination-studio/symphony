from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.managed_runs import ManagedRunPlan, ManagedRunState, WorkItemState

from conductor.conductor_managed_run_store_artifacts import ConductorManagedRunStoreArtifactsMixin, gate_snapshots_for_plan
from conductor.conductor_managed_run_store_rows import (
    _json_dumps,
    _json_loads,
    _now,
    _run_from_row,
    _work_item_from_row,
    init_managed_run_db,
)
from conductor.conductor_managed_run_store_views import ConductorManagedRunStoreViewMixin


@dataclass(frozen=True)
class ManagedRunDispatchAccepted:
    run_id: str
    parent_issue_id: str
    issue_identifier: str


class ConductorManagedRunStore(ConductorManagedRunStoreViewMixin, ConductorManagedRunStoreArtifactsMixin):
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
            payload = self._plan_payload_for_save(connection, run_id, plan, version, backend_session_id, now)
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
                    _json_dumps(payload),
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

    def update_work_item_payload(self, run_id: str, work_item_id: str, payload: dict[str, Any]) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE managed_run_work_items
                SET payload_json = ?, updated_at = ?
                WHERE run_id = ? AND work_item_id = ?
                """,
                (_json_dumps(payload), _now(), run_id, work_item_id),
            )

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

    def _plan_payload_for_save(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        plan: ManagedRunPlan,
        version: int,
        backend_session_id: str,
        now: str,
    ) -> dict[str, Any]:
        return {
            **self._run_payload(connection, run_id),
            "gate_snapshots": gate_snapshots_for_plan(
                run_id=run_id,
                plan=plan,
                plan_version=version,
                creator_attempt_id=backend_session_id or f"plan-{version}",
                created_at=now,
            ),
            "plan_validation_failures": 0,
        }

    def _init_db(self) -> None:
        with self.connect() as connection:
            init_managed_run_db(connection)


__all__ = ["ConductorManagedRunStore", "ManagedRunDispatchAccepted"]
