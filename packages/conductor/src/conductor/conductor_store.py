from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.phase import RunPhase

from .conductor_phase import PhaseTransitionError, OrchestrationEvent, OrchestrationRun, new_run, with_updates
from .conductor_models import ConductorSettings, InstanceRecord, utc_now_iso
from .conductor_store_projection import *  # noqa: F403


INSTANCE_COLUMNS = (
    "id",
    "name",
    "repo_source_type",
    "repo_source_value",
    "resolved_repo_path",
    "instance_dir",
    "workflow_path",
    "workspace_root",
    "persistence_path",
    "log_path",
    "http_port",
    "linear_project",
    "linear_filters_json",
    "workflow_profile",
    "workflow_inputs_json",
    "workflow_content",
    "workflow_generation_status",
    "process_status",
    "pid",
    "last_exit_code",
    "last_error",
    "restart_count",
    "restart_window_started_at",
    "restart_next_at",
    "created_at",
    "updated_at",
)


class ConductorStore:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.instances_root = data_root / "instances"
        self.db_path = data_root / "conductor.db"
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.instances_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def list_instances(self) -> list[InstanceRecord]:
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT {', '.join(INSTANCE_COLUMNS)} FROM instances ORDER BY created_at, id"
            ).fetchall()
        return [_instance_from_row(row) for row in rows]

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {', '.join(INSTANCE_COLUMNS)} FROM instances WHERE id = ?",
                (instance_id,),
            ).fetchone()
        return _instance_from_row(row) if row is not None else None

    def get_settings(self) -> ConductorSettings:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT
                  podium_url,
                  podium_runtime_id,
                  podium_runtime_token,
                  podium_proxy_token,
                  podium_ws_url,
                  runtime_group_id,
                  managed_mode,
                  conductor_id
                FROM settings
                WHERE id = 1
                """
            ).fetchone()
            if row is None:
                settings = ConductorSettings()
                connection.execute(
                    """
                    INSERT INTO settings (
                      id,
                      podium_url,
                      podium_runtime_id,
                      podium_runtime_token,
                      podium_proxy_token,
                      podium_ws_url,
                      runtime_group_id,
                      managed_mode,
                      conductor_id,
                      updated_at
                    )
                    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _settings_values(settings),
                )
                return settings
        return ConductorSettings.from_dict(dict(row))

    def save_settings(self, settings: ConductorSettings) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO settings (
                  id,
                  podium_url,
                  podium_runtime_id,
                  podium_runtime_token,
                  podium_proxy_token,
                  podium_ws_url,
                  runtime_group_id,
                  managed_mode,
                  conductor_id,
                  updated_at
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  podium_url = excluded.podium_url,
                  podium_runtime_id = excluded.podium_runtime_id,
                  podium_runtime_token = excluded.podium_runtime_token,
                  podium_proxy_token = excluded.podium_proxy_token,
                  podium_ws_url = excluded.podium_ws_url,
                  runtime_group_id = excluded.runtime_group_id,
                  managed_mode = excluded.managed_mode,
                  conductor_id = excluded.conductor_id,
                  updated_at = excluded.updated_at
                """,
                _settings_values(settings),
            )

    def save_instance(self, instance: InstanceRecord) -> None:
        current = self.get_instance(instance.id)
        if current is None:
            self.create_instance(instance)
            return
        if current.created_at == instance.created_at and current.updated_at == instance.updated_at:
            raise FileExistsError(f"Metadata already exists for {instance.id}")
        self.update_instance(instance)

    def create_instance(self, instance: InstanceRecord) -> None:
        with self.connect() as connection:
            try:
                connection.execute(
                    f"""
                    INSERT INTO instances ({', '.join(INSTANCE_COLUMNS)})
                    VALUES ({', '.join('?' for _ in INSTANCE_COLUMNS)})
                    """,
                    _instance_values(instance),
                )
            except sqlite3.IntegrityError as exc:
                raise FileExistsError(f"Metadata already exists for {instance.id}") from exc

    def update_instance(self, instance: InstanceRecord) -> None:
        assignments = ", ".join(f"{column} = ?" for column in INSTANCE_COLUMNS if column != "id")
        values = [value for column, value in zip(INSTANCE_COLUMNS, _instance_values(instance), strict=True) if column != "id"]
        with self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE instances SET {assignments} WHERE id = ?",
                (*values, instance.id),
            )
            if cursor.rowcount == 0:
                raise FileNotFoundError(f"Metadata does not exist for {instance.id}")

    def delete_instance(self, instance_id: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM instances WHERE id = ?", (instance_id,))

    def allocate_port(self, *, start: int = 8801) -> int:
        with self.connect() as connection:
            rows = connection.execute("SELECT http_port FROM instances").fetchall()
        used = {int(row["http_port"]) for row in rows}
        port = start
        while port in used:
            port += 1
        return port

    def enqueue_runtime_action(self, *, instance_id: str, action_type: str, payload: dict[str, Any] | None = None) -> str:
        action_id = uuid4().hex
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO runtime_actions (
                  id,
                  instance_id,
                  action_type,
                  payload_json,
                  status,
                  attempt,
                  lease_owner,
                  lease_expires_at,
                  last_error,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, ?)
                """,
                (action_id, instance_id, action_type, _json_dumps(payload or {}), now, now),
            )
        return action_id

    def claim_runtime_action(self, action_id: str, *, lease_owner: str, lease_expires_at: str | None = None) -> dict[str, Any] | None:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                UPDATE runtime_actions
                SET status = 'leased',
                    attempt = attempt + 1,
                    lease_owner = ?,
                    lease_expires_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND status IN ('queued', 'retryable')
                """,
                (lease_owner, lease_expires_at, now, action_id),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute(
                "SELECT * FROM runtime_actions WHERE id = ?",
                (action_id,),
            ).fetchone()
        return _runtime_action_from_row(row) if row is not None else None

    def get_runtime_action(self, action_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM runtime_actions WHERE id = ?", (action_id,)).fetchone()
        return _runtime_action_from_row(row) if row is not None else None

    def complete_runtime_action(self, action_id: str) -> None:
        self._set_runtime_action_status(action_id, status="completed")

    def fail_runtime_action(self, action_id: str, error: str, *, retryable: bool = True) -> None:
        self._set_runtime_action_status(action_id, status="retryable" if retryable else "failed", error=error)

    def upsert_orchestration_run(
        self,
        *,
        instance_id: str,
        issue_id: str,
        issue_identifier: str | None,
        workflow_profile: str | None,
        dispatch_id: str | None,
        fencing_token: int | None = None,
        blocked_by: list[str] | None = None,
        parent_issue_id: str | None = None,
        codex_profile: dict[str, Any] | None = None,
    ) -> OrchestrationRun:
        blocked_by = _clean_string_list(blocked_by)
        parent_issue_id = _optional_text(parent_issue_id)
        codex_profile = dict(codex_profile or {})
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM orchestration_runs
                WHERE instance_id = ? AND issue_id = ?
                ORDER BY epoch DESC, created_at DESC, run_id DESC
                LIMIT 1
                """,
                (instance_id, issue_id),
            ).fetchone()
        if row is None:
            run_id = f"run-{uuid4().hex}"
            return self.apply_event(
                run_id,
                {
                    "instance_id": instance_id,
                    "issue_id": issue_id,
                    "event_type": "dispatch.created",
                    "to_phase": RunPhase.QUEUED,
                    "payload": {
                        "dispatch_id": dispatch_id,
                        "fencing_token": fencing_token,
                        "issue_identifier": issue_identifier,
                        "workflow_profile": workflow_profile,
                        "blocked_by": blocked_by,
                        "parent_issue_id": parent_issue_id,
                        "codex_profile": codex_profile,
                    },
                },
                expected_current_phases=set(),
            )
        run = _orchestration_run_from_row(row)
        if run.phase in {RunPhase.DONE, RunPhase.FAILED}:
            run_id = f"run-{uuid4().hex}"
            return self.apply_event(
                run_id,
                {
                    "instance_id": instance_id,
                    "issue_id": issue_id,
                    "event_type": "dispatch.created",
                    "to_phase": RunPhase.QUEUED,
                    "payload": {
                        "dispatch_id": dispatch_id,
                        "fencing_token": fencing_token,
                        "issue_identifier": issue_identifier,
                        "workflow_profile": workflow_profile,
                        "epoch": run.epoch + 1,
                        "blocked_by": blocked_by,
                        "parent_issue_id": parent_issue_id,
                        "codex_profile": codex_profile,
                    },
                },
                expected_current_phases=set(),
            )
        return self.apply_event(
            run.run_id,
            {
                "event_type": "dispatch.duplicate",
                "to_phase": run.phase,
                "payload": {
                    "dispatch_id": dispatch_id,
                    "fencing_token": fencing_token,
                    "issue_identifier": issue_identifier,
                    "workflow_profile": workflow_profile,
                    "blocked_by": blocked_by,
                    "parent_issue_id": parent_issue_id,
                    "codex_profile": codex_profile,
                },
            },
            expected_current_phases={run.phase},
        )

    def get_orchestration_run(self, run_id: str) -> OrchestrationRun | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM orchestration_runs WHERE run_id = ?", (run_id,)).fetchone()
        return _orchestration_run_from_row(row) if row is not None else None

    def get_orchestration_run_by_issue(self, instance_id: str, issue_id: str) -> OrchestrationRun | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM orchestration_runs
                WHERE instance_id = ? AND issue_id = ?
                ORDER BY epoch DESC, created_at DESC, run_id DESC
                LIMIT 1
                """,
                (instance_id, issue_id),
            ).fetchone()
        return _orchestration_run_from_row(row) if row is not None else None

    def get_latest_orchestration_run_for_issue(self, issue_id: str) -> OrchestrationRun | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM orchestration_runs
                WHERE issue_id = ?
                ORDER BY epoch DESC, created_at DESC, run_id DESC
                LIMIT 1
                """,
                (issue_id,),
            ).fetchone()
        return _orchestration_run_from_row(row) if row is not None else None

    def has_terminal_orchestration_run_for_issue(self, issue_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT 1
                FROM orchestration_runs
                WHERE issue_id = ? AND phase IN ('done', 'failed')
                LIMIT 1
                """,
                (issue_id,),
            ).fetchone()
        return row is not None

    def list_orchestration_runs(
        self,
        *,
        instance_id: str | None = None,
        phases: set[RunPhase] | None = None,
        ack_status: str | None = None,
    ) -> list[OrchestrationRun]:
        clauses: list[str] = []
        values: list[Any] = []
        if instance_id is not None:
            clauses.append("instance_id = ?")
            values.append(instance_id)
        if phases:
            clauses.append(f"phase IN ({', '.join('?' for _ in phases)})")
            values.extend(sorted(phase.value for phase in phases))
        if ack_status is not None:
            clauses.append("ack_status = ?")
            values.append(ack_status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM orchestration_runs {where} ORDER BY updated_at DESC, run_id",
                values,
            ).fetchall()
        return [_orchestration_run_from_row(row) for row in rows]

    def list_due_orchestration_runs(self, *, now: str | None = None, instance_id: str | None = None) -> list[OrchestrationRun]:
        now = now or utc_now_iso()
        runnable_phases = {RunPhase.QUEUED, RunPhase.REVIEWING, RunPhase.REWORKING}
        clauses = [
            f"phase IN ({', '.join('?' for _ in runnable_phases)})",
            "status = ?",
            "(next_run_at IS NULL OR next_run_at <= ?)",
        ]
        values: list[Any] = [
            *sorted(phase.value for phase in runnable_phases),
            "queued",
            now,
        ]
        if instance_id is not None:
            clauses.append("instance_id = ?")
            values.append(instance_id)
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT *
                FROM orchestration_runs
                WHERE {' AND '.join(clauses)}
                ORDER BY COALESCE(next_run_at, created_at), created_at, run_id
                """,
                values,
            ).fetchall()
        return [_orchestration_run_from_row(row) for row in rows]

    def update_orchestration_run(self, run_id: str, **changes: Any) -> OrchestrationRun:
        current = self.get_orchestration_run(run_id)
        if current is None:
            raise FileNotFoundError(f"Orchestration run does not exist: {run_id}")
        normalized = {key: _normalize_run_change(key, value) for key, value in changes.items()}
        return self.apply_event(
            run_id,
            {
                "event_type": "projection.patch",
                "to_phase": normalized.get("phase", current.phase),
                "payload": normalized,
            },
            expected_current_phases={current.phase},
        )

    def apply_event(
        self,
        run_id: str,
        event: OrchestrationEvent | dict[str, Any],
        *,
        expected_current_phases: set[RunPhase] | None = None,
        expected_last_event_types: set[str] | None = None,
    ) -> OrchestrationRun:
        payload = _event_payload(event)
        event_type = _event_field(event, "event_type")
        if not event_type:
            raise ValueError("Orchestration event requires event_type")
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current_row = connection.execute("SELECT * FROM orchestration_runs WHERE run_id = ?", (run_id,)).fetchone()
            current = _orchestration_run_from_row(current_row) if current_row is not None else None
            if expected_current_phases is None:
                raise PhaseTransitionError(f"apply_event requires expected_current_phases for {event_type}")
            instance_id = _event_field(event, "instance_id") or (current.instance_id if current is not None else "")
            issue_id = _event_field(event, "issue_id") or (current.issue_id if current is not None else "")
            if not instance_id or not issue_id:
                raise FileNotFoundError(f"Orchestration run does not exist: {run_id}")
            if current is None:
                if expected_current_phases:
                    raise PhaseTransitionError(f"Expected run {run_id} to exist before {event_type}")
            else:
                expected = {_phase_value(phase) for phase in expected_current_phases}
                if current.phase.value not in expected:
                    raise PhaseTransitionError(
                        f"Expected run {run_id} phase to be one of {sorted(expected)}, found {current.phase.value}"
                    )
            if expected_last_event_types is not None:
                last_event = connection.execute(
                    """
                    SELECT event_type
                    FROM orchestration_events
                    WHERE run_id = ?
                    ORDER BY created_at DESC, event_id DESC
                    LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()
                last_event_type = str(last_event["event_type"]) if last_event is not None else None
                if last_event_type not in expected_last_event_types:
                    raise PhaseTransitionError(
                        f"Expected run {run_id} last event to be one of {sorted(expected_last_event_types)}, "
                        f"found {last_event_type or 'none'}"
                    )
            from_phase = _event_phase(event, "from_phase")
            if from_phase is None and current is not None:
                from_phase = current.phase
            to_phase = _event_phase(event, "to_phase")
            if to_phase is None and current is not None:
                to_phase = current.phase
            reason = _optional_text(_event_value(event, "reason"))
            event_id = _append_orchestration_event(
                connection,
                run_id=run_id,
                instance_id=instance_id,
                issue_id=issue_id,
                event_type=event_type,
                from_phase=from_phase,
                to_phase=to_phase,
                reason=reason,
                payload=payload,
                now=now,
            )
            stored_event = OrchestrationEvent(
                event_id=event_id,
                run_id=run_id,
                instance_id=instance_id,
                issue_id=issue_id,
                event_type=event_type,
                from_phase=from_phase,
                to_phase=to_phase,
                reason=reason,
                payload=payload,
                created_at=now,
            )
            updated = _project_orchestration_event(current, stored_event)
            try:
                _write_orchestration_run_projection(connection, updated)
            except sqlite3.IntegrityError as exc:
                if "orchestration_runs.instance_id, orchestration_runs.issue_id" not in str(exc):
                    raise
                active_duplicate = _active_run_for_issue(connection, updated.instance_id, updated.issue_id)
                if active_duplicate is None:
                    raise
                return active_duplicate
        return updated

    def rebuild_run(self, run_id: str) -> OrchestrationRun:
        events = self.list_orchestration_events(run_id)
        if not events:
            raise FileNotFoundError(f"Orchestration run has no events: {run_id}")
        projection: OrchestrationRun | None = None
        for event in events:
            projection = _project_orchestration_event(projection, event)
        if projection is None:
            raise FileNotFoundError(f"Orchestration run has no projection: {run_id}")
        return projection

    def append_orchestration_event(
        self,
        *,
        run_id: str,
        instance_id: str,
        issue_id: str,
        event_type: str,
        from_phase: RunPhase | None,
        to_phase: RunPhase | None,
        reason: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        before = self.list_orchestration_events(run_id)
        current = self.get_orchestration_run(run_id)
        self.apply_event(
            run_id,
            {
                "instance_id": instance_id,
                "issue_id": issue_id,
                "event_type": event_type,
                "from_phase": from_phase,
                "to_phase": to_phase,
                "reason": reason,
                "payload": payload or {},
            },
            expected_current_phases={current.phase} if current is not None else set(),
        )
        after = self.list_orchestration_events(run_id)
        if len(after) <= len(before):
            raise RuntimeError(f"Orchestration event was not appended for run {run_id}")
        return after[-1].event_id

    def list_orchestration_events(self, run_id: str) -> list[OrchestrationEvent]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM orchestration_events WHERE run_id = ? ORDER BY created_at, event_id",
                (run_id,),
            ).fetchall()
        return [_orchestration_event_from_row(row) for row in rows]

    def _init_db(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  podium_url TEXT NOT NULL DEFAULT '',
                  podium_runtime_id TEXT NOT NULL DEFAULT '',
                  podium_runtime_token TEXT NOT NULL DEFAULT '',
                  podium_proxy_token TEXT NOT NULL DEFAULT '',
                  podium_ws_url TEXT NOT NULL DEFAULT '',
                  runtime_group_id TEXT NOT NULL DEFAULT '',
                  managed_mode INTEGER NOT NULL DEFAULT 0,
                  conductor_id TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS instances (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  repo_source_type TEXT NOT NULL,
                  repo_source_value TEXT NOT NULL,
                  resolved_repo_path TEXT NOT NULL,
                  instance_dir TEXT NOT NULL,
                  workflow_path TEXT NOT NULL,
                  workspace_root TEXT NOT NULL,
                  persistence_path TEXT NOT NULL,
                  log_path TEXT NOT NULL,
                  http_port INTEGER NOT NULL,
                  linear_project TEXT NOT NULL,
                  linear_filters_json TEXT NOT NULL,
                  workflow_profile TEXT NOT NULL,
                  workflow_inputs_json TEXT NOT NULL,
                  workflow_content TEXT NOT NULL,
                  workflow_generation_status TEXT NOT NULL,
                  process_status TEXT NOT NULL,
                  pid INTEGER,
                  last_exit_code INTEGER,
                  last_error TEXT,
                  restart_count INTEGER NOT NULL DEFAULT 0,
                  restart_window_started_at TEXT,
                  restart_next_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_http_port ON instances(http_port);
                CREATE INDEX IF NOT EXISTS idx_instances_process_status ON instances(process_status);

                CREATE TABLE IF NOT EXISTS runtime_actions (
                  id TEXT PRIMARY KEY,
                  instance_id TEXT NOT NULL,
                  action_type TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  status TEXT NOT NULL,
                  attempt INTEGER NOT NULL DEFAULT 0,
                  lease_owner TEXT,
                  lease_expires_at TEXT,
                  last_error TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_runtime_actions_status ON runtime_actions(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_runtime_actions_instance ON runtime_actions(instance_id);

                CREATE TABLE IF NOT EXISTS orchestration_runs (
                  run_id TEXT PRIMARY KEY,
                  instance_id TEXT NOT NULL,
                  issue_id TEXT NOT NULL,
                  issue_identifier TEXT,
                  blocked_by_json TEXT NOT NULL DEFAULT '[]',
                  parent_issue_id TEXT,
                  phase TEXT NOT NULL,
                  status TEXT NOT NULL,
                  epoch INTEGER NOT NULL DEFAULT 1,
                  attempt INTEGER NOT NULL DEFAULT 1,
                  workflow_profile TEXT,
                  dispatch_id TEXT,
                  fencing_token INTEGER,
                  request_path TEXT,
                  result_path TEXT,
                  workspace_path TEXT,
                  ops_snapshot_path TEXT,
                  human_action_json TEXT NOT NULL DEFAULT '{}',
                  human_response TEXT,
                  last_reason TEXT,
                  last_error TEXT,
                  process_pid INTEGER,
                  crash_count INTEGER NOT NULL DEFAULT 0,
                  retry_count INTEGER NOT NULL DEFAULT 0,
                  init_failure_count INTEGER NOT NULL DEFAULT 0,
                  overload_count INTEGER NOT NULL DEFAULT 0,
                  next_run_at TEXT,
                  ack_status TEXT,
                  acked_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                DROP INDEX IF EXISTS idx_orchestration_runs_instance_issue;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_runs_active_instance_issue
                  ON orchestration_runs(instance_id, issue_id)
                  WHERE phase NOT IN ('done', 'failed');
                CREATE INDEX IF NOT EXISTS idx_orchestration_runs_due
                  ON orchestration_runs(phase, status, next_run_at);
                CREATE INDEX IF NOT EXISTS idx_orchestration_runs_ack
                  ON orchestration_runs(ack_status, updated_at);

                CREATE TABLE IF NOT EXISTS orchestration_events (
                  event_id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL,
                  instance_id TEXT NOT NULL,
                  issue_id TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  from_phase TEXT,
                  to_phase TEXT,
                  reason TEXT,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_orchestration_events_run
                  ON orchestration_events(run_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_orchestration_events_issue
                  ON orchestration_events(instance_id, issue_id, created_at);
                """
            )
            _ensure_column(connection, "instances", "restart_count", "INTEGER NOT NULL DEFAULT 0")
            _ensure_column(connection, "instances", "restart_window_started_at", "TEXT")
            _ensure_column(connection, "orchestration_runs", "init_failure_count", "INTEGER NOT NULL DEFAULT 0")
            _ensure_column(connection, "orchestration_runs", "overload_count", "INTEGER NOT NULL DEFAULT 0")
            _ensure_column(connection, "orchestration_runs", "epoch", "INTEGER NOT NULL DEFAULT 1")
            _ensure_column(connection, "orchestration_runs", "blocked_by_json", "TEXT NOT NULL DEFAULT '[]'")
            _ensure_column(connection, "orchestration_runs", "parent_issue_id", "TEXT")
            _ensure_column(connection, "orchestration_runs", "fencing_token", "INTEGER")
            _ensure_column(connection, "instances", "restart_next_at", "TEXT")

    def _set_runtime_action_status(self, action_id: str, *, status: str, error: str | None = None) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE runtime_actions
                SET status = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    last_error = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (status, error, utc_now_iso(), action_id),
            )

