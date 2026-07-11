from __future__ import annotations

import json
import sqlite3
from typing import Any

from .conductor_models import ConductorSettings, InstanceRecord, utc_now_iso

INSTANCE_COLUMNS = (
    "id",
    "name",
    "repo_source_type",
    "repo_source_value",
    "resolved_repo_path",
    "instance_dir",
    "workspace_root",
    "persistence_path",
    "log_path",
    "http_port",
    "linear_project",
    "linear_filters_json",
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


def settings_values(settings: ConductorSettings) -> tuple[Any, ...]:
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


def instance_values(instance: InstanceRecord) -> tuple[Any, ...]:
    return (
        instance.id,
        instance.name,
        instance.repo_source_type,
        instance.repo_source_value,
        instance.resolved_repo_path,
        instance.instance_dir,
        instance.workspace_root,
        instance.persistence_path,
        instance.log_path,
        instance.http_port,
        instance.linear_project,
        json_dumps(instance.linear_filters),
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


def instance_from_row(row: sqlite3.Row) -> InstanceRecord:
    return InstanceRecord(
        id=str(row["id"]),
        name=str(row["name"]),
        repo_source_type=row["repo_source_type"],
        repo_source_value=str(row["repo_source_value"]),
        resolved_repo_path=str(row["resolved_repo_path"]),
        instance_dir=str(row["instance_dir"]),
        workspace_root=str(row["workspace_root"]),
        persistence_path=str(row["persistence_path"]),
        log_path=str(row["log_path"]),
        http_port=int(row["http_port"]),
        linear_project=str(row["linear_project"]),
        linear_filters=json_loads_dict(row["linear_filters_json"]),
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


def runtime_action_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_loads_dict(data.pop("payload_json"))
    return data


def ensure_column(connection: sqlite3.Connection, table: str, name: str, definition: str) -> None:
    columns = {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    if name not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def json_loads_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    payload = json.loads(str(value))
    return payload if isinstance(payload, dict) else {}
