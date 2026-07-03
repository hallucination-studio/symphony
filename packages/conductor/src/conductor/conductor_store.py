from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

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
                """
            )

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
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


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
