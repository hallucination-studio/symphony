from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .conductor_models import ConductorSettings, InstanceRecord, utc_now_iso


INSTANCE_COLUMNS = (
    "id", "name", "repo_source_type", "repo_source_value", "resolved_repo_path",
    "instance_dir", "workspace_root", "persistence_path", "log_path", "http_port",
    "linear_project", "linear_filters_json", "process_status", "pid", "last_exit_code",
    "last_error", "restart_count", "restart_window_started_at", "restart_next_at",
    "created_at", "updated_at",
)


def _settings_values(settings: ConductorSettings) -> tuple[Any, ...]:
    return (
        settings.podium_url,
        settings.podium_runtime_id,
        settings.podium_runtime_token,
        settings.podium_proxy_token,
        settings.runtime_group_id,
        1 if settings.managed_mode else 0,
        settings.conductor_id,
        utc_now_iso(),
    )


def _instance_values(instance: InstanceRecord) -> tuple[Any, ...]:
    return (
        instance.id, instance.name, instance.repo_source_type, instance.repo_source_value,
        instance.resolved_repo_path, instance.instance_dir, instance.workspace_root,
        instance.persistence_path, instance.log_path, instance.http_port, instance.linear_project,
        json.dumps(instance.linear_filters, separators=(",", ":"), sort_keys=True),
        instance.process_status, instance.pid, instance.last_exit_code, instance.last_error,
        instance.restart_count, instance.restart_window_started_at, instance.restart_next_at,
        instance.created_at, instance.updated_at,
    )


def _instance_from_row(row: sqlite3.Row) -> InstanceRecord:
    filters = json.loads(str(row["linear_filters_json"])) if row["linear_filters_json"] else {}
    return InstanceRecord(
        id=str(row["id"]), name=str(row["name"]), repo_source_type=row["repo_source_type"],
        repo_source_value=str(row["repo_source_value"]), resolved_repo_path=str(row["resolved_repo_path"]),
        instance_dir=str(row["instance_dir"]), workspace_root=str(row["workspace_root"]),
        persistence_path=str(row["persistence_path"]), log_path=str(row["log_path"]),
        http_port=int(row["http_port"]), linear_project=str(row["linear_project"]),
        linear_filters=filters if isinstance(filters, dict) else {}, process_status=row["process_status"],
        pid=row["pid"], last_exit_code=row["last_exit_code"], last_error=row["last_error"],
        restart_count=int(row["restart_count"] or 0), restart_window_started_at=row["restart_window_started_at"],
        restart_next_at=row["restart_next_at"], created_at=str(row["created_at"]), updated_at=str(row["updated_at"]),
    )


class ConductorStore:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.instances_root = data_root / "instances"
        self.db_path = data_root / "workflow.db"
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
                      runtime_group_id,
                      managed_mode,
                      conductor_id,
                      updated_at
                    )
                    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
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
                  runtime_group_id,
                  managed_mode,
                  conductor_id,
                  updated_at
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  podium_url = excluded.podium_url,
                  podium_runtime_id = excluded.podium_runtime_id,
                  podium_runtime_token = excluded.podium_runtime_token,
                  podium_proxy_token = excluded.podium_proxy_token,
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
        values = [
            value
            for column, value in zip(INSTANCE_COLUMNS, _instance_values(instance), strict=True)
            if column != "id"
        ]
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
                  workspace_root TEXT NOT NULL,
                  persistence_path TEXT NOT NULL,
                  log_path TEXT NOT NULL,
                  http_port INTEGER NOT NULL,
                  linear_project TEXT NOT NULL,
                  linear_filters_json TEXT NOT NULL,
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

                """
            )
