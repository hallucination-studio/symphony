from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.phase import RunPhase

from .conductor_phase import PhaseTransitionError, OrchestrationEvent, OrchestrationRun, new_run, with_updates
from .conductor_models import ConductorSettings, InstanceRecord, utc_now_iso


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
        blocked_by: list[str] | None = None,
        parent_issue_id: str | None = None,
    ) -> OrchestrationRun:
        blocked_by = _clean_string_list(blocked_by)
        parent_issue_id = _optional_text(parent_issue_id)
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
                        "issue_identifier": issue_identifier,
                        "workflow_profile": workflow_profile,
                        "blocked_by": blocked_by,
                        "parent_issue_id": parent_issue_id,
                    },
                },
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
                        "issue_identifier": issue_identifier,
                        "workflow_profile": workflow_profile,
                        "epoch": run.epoch + 1,
                        "blocked_by": blocked_by,
                        "parent_issue_id": parent_issue_id,
                    },
                },
            )
        return self.apply_event(
            run.run_id,
            {
                "event_type": "dispatch.duplicate",
                "to_phase": run.phase,
                "payload": {
                    "dispatch_id": dispatch_id,
                    "issue_identifier": issue_identifier,
                    "workflow_profile": workflow_profile,
                    "blocked_by": blocked_by,
                    "parent_issue_id": parent_issue_id,
                },
            },
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
            instance_id = _event_field(event, "instance_id") or (current.instance_id if current is not None else "")
            issue_id = _event_field(event, "issue_id") or (current.issue_id if current is not None else "")
            if not instance_id or not issue_id:
                raise FileNotFoundError(f"Orchestration run does not exist: {run_id}")
            if expected_current_phases is not None:
                if current is None:
                    raise PhaseTransitionError(f"Expected run {run_id} to exist before {event_type}")
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
            _write_orchestration_run_projection(connection, updated)
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

def _settings_values(settings: ConductorSettings) -> tuple[Any, ...]:
    return (
        settings.podium_url,
        settings.podium_runtime_id,
        settings.podium_runtime_token,
        settings.podium_proxy_token,
        settings.podium_ws_url,
        settings.runtime_group_id,
        1 if settings.managed_mode else 0,
        settings.conductor_id,
        utc_now_iso(),
    )


def _instance_values(instance: InstanceRecord) -> tuple[Any, ...]:
    return (
        instance.id,
        instance.name,
        instance.repo_source_type,
        instance.repo_source_value,
        instance.resolved_repo_path,
        instance.instance_dir,
        instance.workflow_path,
        instance.workspace_root,
        instance.persistence_path,
        instance.log_path,
        instance.http_port,
        instance.linear_project,
        _json_dumps(instance.linear_filters),
        instance.workflow_profile,
        _json_dumps(instance.workflow_inputs),
        instance.workflow_content,
        instance.workflow_generation_status,
        instance.process_status,
        instance.pid,
        instance.last_exit_code,
        instance.last_error,
        instance.restart_count,
        instance.restart_window_started_at,
        instance.restart_next_at,
        instance.created_at,
        instance.updated_at,
    )


def _instance_from_row(row: sqlite3.Row) -> InstanceRecord:
    return InstanceRecord(
        id=str(row["id"]),
        name=str(row["name"]),
        repo_source_type=row["repo_source_type"],
        repo_source_value=str(row["repo_source_value"]),
        resolved_repo_path=str(row["resolved_repo_path"]),
        instance_dir=str(row["instance_dir"]),
        workflow_path=str(row["workflow_path"]),
        workspace_root=str(row["workspace_root"]),
        persistence_path=str(row["persistence_path"]),
        log_path=str(row["log_path"]),
        http_port=int(row["http_port"]),
        linear_project=str(row["linear_project"]),
        linear_filters=_json_loads_dict(row["linear_filters_json"]),
        workflow_profile=str(row["workflow_profile"]),
        workflow_inputs=_json_loads_dict(row["workflow_inputs_json"]),
        workflow_content=str(row["workflow_content"]),
        workflow_generation_status=row["workflow_generation_status"],
        process_status=row["process_status"],
        pid=row["pid"],
        last_exit_code=row["last_exit_code"],
        last_error=row["last_error"],
        restart_count=int(row["restart_count"] or 0),
        restart_window_started_at=row["restart_window_started_at"],
        restart_next_at=row["restart_next_at"],
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _orchestration_run_values(run: OrchestrationRun) -> tuple[Any, ...]:
    return (
        run.run_id,
        run.instance_id,
        run.issue_id,
        run.issue_identifier,
        _json_dumps(run.blocked_by),
        run.parent_issue_id,
        run.phase.value,
        run.status,
        run.epoch,
        run.attempt,
        run.workflow_profile,
        run.dispatch_id,
        run.request_path,
        run.result_path,
        run.workspace_path,
        run.ops_snapshot_path,
        _json_dumps(run.human_action),
        run.human_response,
        run.last_reason,
        run.last_error,
        run.process_pid,
        run.crash_count,
        run.retry_count,
        run.init_failure_count,
        run.overload_count,
        run.next_run_at,
        run.ack_status,
        run.acked_at,
        run.created_at,
        run.updated_at,
    )


def _orchestration_run_from_row(row: sqlite3.Row) -> OrchestrationRun:
    return OrchestrationRun(
        run_id=str(row["run_id"]),
        instance_id=str(row["instance_id"]),
        issue_id=str(row["issue_id"]),
        issue_identifier=row["issue_identifier"],
        blocked_by=_json_loads_list(row["blocked_by_json"]),
        parent_issue_id=row["parent_issue_id"],
        phase=RunPhase(str(row["phase"])),
        status=str(row["status"]),
        epoch=int(row["epoch"] or 1),
        attempt=int(row["attempt"] or 1),
        workflow_profile=row["workflow_profile"],
        dispatch_id=row["dispatch_id"],
        request_path=row["request_path"],
        result_path=row["result_path"],
        workspace_path=row["workspace_path"],
        ops_snapshot_path=row["ops_snapshot_path"],
        human_action=_json_loads_dict(row["human_action_json"]),
        human_response=row["human_response"],
        last_reason=row["last_reason"],
        last_error=row["last_error"],
        process_pid=row["process_pid"],
        crash_count=int(row["crash_count"] or 0),
        retry_count=int(row["retry_count"] or 0),
        init_failure_count=int(row["init_failure_count"] or 0),
        overload_count=int(row["overload_count"] or 0),
        next_run_at=row["next_run_at"],
        ack_status=row["ack_status"],
        acked_at=row["acked_at"],
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _write_orchestration_run_projection(connection: sqlite3.Connection, run: OrchestrationRun) -> None:
    connection.execute(
        """
        INSERT INTO orchestration_runs (
          run_id,
          instance_id,
          issue_id,
          issue_identifier,
          blocked_by_json,
          parent_issue_id,
          phase,
          status,
          epoch,
          attempt,
          workflow_profile,
          dispatch_id,
          request_path,
          result_path,
          workspace_path,
          ops_snapshot_path,
          human_action_json,
          human_response,
          last_reason,
          last_error,
          process_pid,
          crash_count,
          retry_count,
          init_failure_count,
          overload_count,
          next_run_at,
          ack_status,
          acked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          instance_id = excluded.instance_id,
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          blocked_by_json = excluded.blocked_by_json,
          parent_issue_id = excluded.parent_issue_id,
          phase = excluded.phase,
          status = excluded.status,
          epoch = excluded.epoch,
          attempt = excluded.attempt,
          workflow_profile = excluded.workflow_profile,
          dispatch_id = excluded.dispatch_id,
          request_path = excluded.request_path,
          result_path = excluded.result_path,
          workspace_path = excluded.workspace_path,
          ops_snapshot_path = excluded.ops_snapshot_path,
          human_action_json = excluded.human_action_json,
          human_response = excluded.human_response,
          last_reason = excluded.last_reason,
          last_error = excluded.last_error,
          process_pid = excluded.process_pid,
          crash_count = excluded.crash_count,
          retry_count = excluded.retry_count,
          init_failure_count = excluded.init_failure_count,
          overload_count = excluded.overload_count,
          next_run_at = excluded.next_run_at,
          ack_status = excluded.ack_status,
          acked_at = excluded.acked_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        """,
        _orchestration_run_values(run),
    )


def _project_orchestration_event(current: OrchestrationRun | None, event: OrchestrationEvent) -> OrchestrationRun:
    payload = dict(event.payload)
    if current is None:
        if event.event_type != "dispatch.created":
            raise FileNotFoundError(f"Cannot project {event.event_type} without an existing run")
        return new_run(
            run_id=event.run_id,
            instance_id=event.instance_id,
            issue_id=event.issue_id,
            issue_identifier=_optional_text(payload.get("issue_identifier")),
            blocked_by=_clean_string_list(payload.get("blocked_by")),
            parent_issue_id=_optional_text(payload.get("parent_issue_id")),
            workflow_profile=_optional_text(payload.get("workflow_profile")),
            dispatch_id=_optional_text(payload.get("dispatch_id")),
            epoch=_optional_int(payload.get("epoch"), default=1),
            now=event.created_at,
        )

    changes: dict[str, Any] = {"updated_at": event.created_at}
    if event.to_phase is not None:
        changes["phase"] = event.to_phase
    if event.event_type == "dispatch.duplicate":
        for key in ("issue_identifier", "workflow_profile", "dispatch_id"):
            if payload.get(key):
                changes[key] = payload[key]
        if "blocked_by" in payload:
            changes["blocked_by"] = _clean_string_list(payload.get("blocked_by"))
        if "parent_issue_id" in payload:
            changes["parent_issue_id"] = _optional_text(payload.get("parent_issue_id"))
    elif event.event_type == "projection.patch":
        changes.update(_normalize_projection_payload(payload))
    elif event.event_type in {
        "performer.started",
        "performer.result",
        "performer.init_failed",
        "performer.upstream_overloaded",
        "performer.crashed",
        "human.completed",
        "dispatch.acked",
        "human.failure_child_created",
    }:
        changes.update(_normalize_projection_payload(payload))
    elif event.event_type.startswith("remediation."):
        changes.update(_normalize_projection_payload(payload))
    return with_updates(current, **changes)


def _append_orchestration_event(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    instance_id: str,
    issue_id: str,
    event_type: str,
    from_phase: RunPhase | None,
    to_phase: RunPhase | None,
    reason: str | None,
    payload: dict[str, Any],
    now: str,
) -> str:
    event_id = f"evt-{uuid4().hex}"
    connection.execute(
        """
        INSERT INTO orchestration_events (
          event_id,
          run_id,
          instance_id,
          issue_id,
          event_type,
          from_phase,
          to_phase,
          reason,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            run_id,
            instance_id,
            issue_id,
            event_type,
            from_phase.value if from_phase is not None else None,
            to_phase.value if to_phase is not None else None,
            reason,
            _json_dumps(payload),
            now,
        ),
    )
    return event_id


def _orchestration_event_from_row(row: sqlite3.Row) -> OrchestrationEvent:
    return OrchestrationEvent.from_dict(
        {
            "event_id": row["event_id"],
            "run_id": row["run_id"],
            "instance_id": row["instance_id"],
            "issue_id": row["issue_id"],
            "event_type": row["event_type"],
            "from_phase": row["from_phase"],
            "to_phase": row["to_phase"],
            "reason": row["reason"],
            "payload": _json_loads_dict(row["payload_json"]),
            "created_at": row["created_at"],
        }
    )


def _normalize_run_change(key: str, value: Any) -> Any:
    if key == "phase" and isinstance(value, RunPhase):
        return value
    if key == "phase" and value is not None:
        return RunPhase(str(value))
    if key == "status" and hasattr(value, "value"):
        return value.value
    if key == "blocked_by":
        return _clean_string_list(value)
    if key == "parent_issue_id":
        return _optional_text(value)
    return value


def _normalize_projection_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    allowed = {
        "phase",
        "status",
        "epoch",
        "attempt",
        "workflow_profile",
        "dispatch_id",
        "request_path",
        "result_path",
        "workspace_path",
        "ops_snapshot_path",
        "human_action",
        "human_response",
        "last_reason",
        "last_error",
        "process_pid",
        "crash_count",
        "retry_count",
        "init_failure_count",
        "overload_count",
        "next_run_at",
        "ack_status",
        "acked_at",
        "issue_identifier",
        "blocked_by",
        "parent_issue_id",
    }
    for key, value in payload.items():
        if key not in allowed:
            continue
        if key == "status" and "run_status" in payload:
            continue
        normalized[key] = _normalize_run_change(key, value)
    if "run_status" in payload:
        normalized["status"] = _normalize_run_change("status", payload["run_status"])
    return normalized


def _event_payload(event: OrchestrationEvent | dict[str, Any]) -> dict[str, Any]:
    if isinstance(event, OrchestrationEvent):
        return dict(event.payload)
    value = event.get("payload", {})
    return dict(value) if isinstance(value, dict) else {}


def _event_field(event: OrchestrationEvent | dict[str, Any], key: str) -> str:
    value = _event_value(event, key)
    return str(value or "")


def _event_value(event: OrchestrationEvent | dict[str, Any], key: str) -> Any:
    if isinstance(event, OrchestrationEvent):
        return getattr(event, key)
    return event.get(key)


def _event_phase(event: OrchestrationEvent | dict[str, Any], key: str) -> RunPhase | None:
    value = _event_value(event, key)
    if isinstance(value, RunPhase):
        return value
    if value is None:
        return None
    text = str(value)
    return RunPhase(text) if text else None


def _phase_value(value: RunPhase | str) -> str:
    return value.value if isinstance(value, RunPhase) else str(value)


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _optional_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _ensure_column(connection: sqlite3.Connection, table: str, name: str, definition: str) -> None:
    columns = {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    if name not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def _runtime_action_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = _json_loads_dict(data.pop("payload_json"))
    return data


def _json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _json_loads_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    payload = json.loads(str(value))
    return payload if isinstance(payload, dict) else {}


def _json_loads_list(value: Any) -> list[str]:
    if not value:
        return []
    payload = json.loads(str(value))
    return _clean_string_list(payload)


def _clean_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        cleaned.append(text)
    return cleaned
