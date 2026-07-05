from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.phase import RunPhase

from .conductor_phase import OrchestrationEvent, OrchestrationRun, new_run, with_updates
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
    "gated_followup_stages_json",
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

    def claim_gated_followup_marker(self, instance_id: str, issue_id: str, stage: str) -> bool:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT status
                FROM gated_followup_markers
                WHERE instance_id = ? AND issue_id = ? AND stage = ?
                """,
                (instance_id, issue_id, stage),
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO gated_followup_markers (
                      instance_id,
                      issue_id,
                      stage,
                      status,
                      attempt,
                      last_error,
                      created_at,
                      updated_at
                    )
                    VALUES (?, ?, ?, 'starting', 1, NULL, ?, ?)
                    """,
                    (instance_id, issue_id, stage, now, now),
                )
                return True
            if row["status"] == "failed":
                connection.execute(
                    """
                    UPDATE gated_followup_markers
                    SET status = 'starting',
                        attempt = attempt + 1,
                        last_error = NULL,
                        updated_at = ?
                    WHERE instance_id = ? AND issue_id = ? AND stage = ? AND status = 'failed'
                    """,
                    (now, instance_id, issue_id, stage),
                )
                return True
        return False

    def mark_gated_followup_started(self, instance_id: str, issue_id: str, stage: str) -> None:
        self._set_gated_followup_status(instance_id, issue_id, stage, status="started")

    def mark_gated_followup_failed(self, instance_id: str, issue_id: str, stage: str, error: str) -> None:
        self._set_gated_followup_status(instance_id, issue_id, stage, status="failed", error=error)

    def get_gated_followup_marker(self, instance_id: str, issue_id: str, stage: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM gated_followup_markers
                WHERE instance_id = ? AND issue_id = ? AND stage = ?
                """,
                (instance_id, issue_id, stage),
            ).fetchone()
        return dict(row) if row is not None else None

    def upsert_orchestration_run(
        self,
        *,
        instance_id: str,
        issue_id: str,
        issue_identifier: str | None,
        workflow_profile: str | None,
        dispatch_id: str | None,
    ) -> OrchestrationRun:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM orchestration_runs WHERE instance_id = ? AND issue_id = ?",
                (instance_id, issue_id),
            ).fetchone()
            if row is None:
                run = new_run(
                    instance_id=instance_id,
                    issue_id=issue_id,
                    issue_identifier=issue_identifier,
                    workflow_profile=workflow_profile,
                    dispatch_id=dispatch_id,
                    now=now,
                )
                connection.execute(
                    """
                    INSERT INTO orchestration_runs (
                      run_id,
                      instance_id,
                      issue_id,
                      issue_identifier,
                      phase,
                      status,
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
                      next_run_at,
                      ack_status,
                      acked_at,
                      created_at,
                      updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _orchestration_run_values(run),
                )
                _append_orchestration_event(
                    connection,
                    run_id=run.run_id,
                    instance_id=instance_id,
                    issue_id=issue_id,
                    event_type="dispatch.created",
                    from_phase=None,
                    to_phase=RunPhase.QUEUED,
                    reason=None,
                    payload={"dispatch_id": dispatch_id, "issue_identifier": issue_identifier},
                    now=now,
                )
                return run
            run = _orchestration_run_from_row(row)
            updated = with_updates(
                run,
                issue_identifier=issue_identifier or run.issue_identifier,
                workflow_profile=workflow_profile or run.workflow_profile,
                dispatch_id=dispatch_id or run.dispatch_id,
                updated_at=now,
            )
            connection.execute(
                """
                UPDATE orchestration_runs
                SET issue_identifier = ?,
                    workflow_profile = ?,
                    dispatch_id = ?,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (
                    updated.issue_identifier,
                    updated.workflow_profile,
                    updated.dispatch_id,
                    now,
                    updated.run_id,
                ),
            )
            _append_orchestration_event(
                connection,
                run_id=updated.run_id,
                instance_id=updated.instance_id,
                issue_id=updated.issue_id,
                event_type="dispatch.duplicate",
                from_phase=run.phase,
                to_phase=updated.phase,
                reason=None,
                payload={"dispatch_id": dispatch_id, "issue_identifier": issue_identifier},
                now=now,
            )
        return updated

    def get_orchestration_run(self, run_id: str) -> OrchestrationRun | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM orchestration_runs WHERE run_id = ?", (run_id,)).fetchone()
        return _orchestration_run_from_row(row) if row is not None else None

    def get_orchestration_run_by_issue(self, instance_id: str, issue_id: str) -> OrchestrationRun | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM orchestration_runs WHERE instance_id = ? AND issue_id = ?",
                (instance_id, issue_id),
            ).fetchone()
        return _orchestration_run_from_row(row) if row is not None else None

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
        updated = with_updates(current, **normalized, updated_at=utc_now_iso())
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE orchestration_runs
                SET phase = ?,
                    status = ?,
                    attempt = ?,
                    workflow_profile = ?,
                    dispatch_id = ?,
                    request_path = ?,
                    result_path = ?,
                    workspace_path = ?,
                    ops_snapshot_path = ?,
                    human_action_json = ?,
                    human_response = ?,
                    last_reason = ?,
                    last_error = ?,
                    process_pid = ?,
                    crash_count = ?,
                    retry_count = ?,
                    init_failure_count = ?,
                    next_run_at = ?,
                    ack_status = ?,
                    acked_at = ?,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (
                    updated.phase.value,
                    updated.status,
                    updated.attempt,
                    updated.workflow_profile,
                    updated.dispatch_id,
                    updated.request_path,
                    updated.result_path,
                    updated.workspace_path,
                    updated.ops_snapshot_path,
                    _json_dumps(updated.human_action),
                    updated.human_response,
                    updated.last_reason,
                    updated.last_error,
                    updated.process_pid,
                    updated.crash_count,
                    updated.retry_count,
                    updated.init_failure_count,
                    updated.next_run_at,
                    updated.ack_status,
                    updated.acked_at,
                    updated.updated_at,
                    run_id,
                ),
            )
            if cursor.rowcount == 0:
                raise FileNotFoundError(f"Orchestration run does not exist: {run_id}")
        return updated

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
        now = utc_now_iso()
        with self.connect() as connection:
            return _append_orchestration_event(
                connection,
                run_id=run_id,
                instance_id=instance_id,
                issue_id=issue_id,
                event_type=event_type,
                from_phase=from_phase,
                to_phase=to_phase,
                reason=reason,
                payload=payload or {},
                now=now,
            )

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
                  gated_followup_stages_json TEXT NOT NULL,
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

                CREATE TABLE IF NOT EXISTS gated_followup_markers (
                  instance_id TEXT NOT NULL,
                  issue_id TEXT NOT NULL,
                  stage TEXT NOT NULL,
                  status TEXT NOT NULL,
                  attempt INTEGER NOT NULL DEFAULT 0,
                  last_error TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(instance_id, issue_id, stage),
                  FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_gated_followup_markers_status
                  ON gated_followup_markers(status, updated_at);

                CREATE TABLE IF NOT EXISTS orchestration_runs (
                  run_id TEXT PRIMARY KEY,
                  instance_id TEXT NOT NULL,
                  issue_id TEXT NOT NULL,
                  issue_identifier TEXT,
                  phase TEXT NOT NULL,
                  status TEXT NOT NULL,
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
                  next_run_at TEXT,
                  ack_status TEXT,
                  acked_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_runs_instance_issue
                  ON orchestration_runs(instance_id, issue_id);
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

    def _set_gated_followup_status(
        self,
        instance_id: str,
        issue_id: str,
        stage: str,
        *,
        status: str,
        error: str | None = None,
    ) -> None:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO gated_followup_markers (
                  instance_id,
                  issue_id,
                  stage,
                  status,
                  attempt,
                  last_error,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(instance_id, issue_id, stage) DO UPDATE SET
                  status = excluded.status,
                  last_error = excluded.last_error,
                  updated_at = excluded.updated_at
                """,
                (instance_id, issue_id, stage, status, error, now, now),
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
        _json_dumps(instance.gated_followup_stages),
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
        gated_followup_stages=_json_loads_dict(row["gated_followup_stages_json"]),
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
        run.phase.value,
        run.status,
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
        phase=RunPhase(str(row["phase"])),
        status=str(row["status"]),
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
        next_run_at=row["next_run_at"],
        ack_status=row["ack_status"],
        acked_at=row["acked_at"],
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


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
    return value


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
