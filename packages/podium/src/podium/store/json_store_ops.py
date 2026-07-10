from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..podium_shared import _datetime_from_json, utc_now_iso


class JsonStoreOpsMixin:
    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        rows = self._load_map("onboarding_state.json")
        rows[user_id] = {"completed_steps": list(completed_steps), "metadata": dict(metadata), "updated_at": utc_now_iso()}
        self._write("onboarding_state.json", rows)

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("onboarding_state.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_smoke_result(self, user_id: str, result: dict[str, Any]) -> None:
        rows = self._load_map("smoke_results.json")
        rows[user_id] = dict(result)
        self._write("smoke_results.json", rows)

    async def get_smoke_result(self, user_id: str) -> dict[str, Any] | None:
        row = self._load_map("smoke_results.json").get(user_id)
        return dict(row) if isinstance(row, dict) else None

    async def set_presence(self, runtime_id: str, *, timestamp: str, expires_at: str) -> None:
        rows = self._load_map("runtime_presence.json")
        rows[runtime_id] = {"runtime_id": runtime_id, "last_seen_at": timestamp, "expires_at": expires_at}
        self._write("runtime_presence.json", rows)

    async def clear_presence(self, runtime_id: str) -> None:
        rows = self._load_map("runtime_presence.json")
        rows.pop(runtime_id, None)
        self._write("runtime_presence.json", rows)

    async def get_presence(self, runtime_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_presence.json").get(runtime_id)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is not None and expires_at < datetime.now(timezone.utc):
            return None
        return dict(row)

    async def upsert_metrics_snapshot(self, conductor_id: str, instance_id: str, metrics: dict[str, Any]) -> None:
        rows = self._load_map("metrics_snapshots.json")
        rows[f"{conductor_id}\t{instance_id}"] = dict(metrics)
        self._write("metrics_snapshots.json", rows)

    async def get_metrics_snapshot(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = self._load_map("metrics_snapshots.json").get(f"{conductor_id}\t{instance_id}")
        return dict(row) if isinstance(row, dict) else None

    async def upsert_instance_log_tail(self, conductor_id: str, instance_id: str, tail: dict[str, Any]) -> None:
        rows = self._load_map("instance_log_tails.json")
        rows[f"{conductor_id}\t{instance_id}"] = dict(tail)
        self._write("instance_log_tails.json", rows)

    async def get_instance_log_tail(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = self._load_map("instance_log_tails.json").get(f"{conductor_id}\t{instance_id}")
        return dict(row) if isinstance(row, dict) else None

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        rows = self._load_map("log_fetch_results.json")
        rows[request_id] = dict(result)
        self._write("log_fetch_results.json", rows)

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        row = self._load_map("log_fetch_results.json").get(request_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_runtime_config(self, runtime_group_id: str, config: dict[str, Any]) -> None:
        rows = self._load_map("runtime_configs.json")
        rows[runtime_group_id] = dict(config)
        self._write("runtime_configs.json", rows)

    async def get_runtime_config(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = self._load_map("runtime_configs.json").get(runtime_group_id)
        return dict(row) if isinstance(row, dict) else None

    async def save_managed_run_view(self, runtime_group_id: str, view: dict[str, Any]) -> None:
        rows = self._load_map("managed_run_views.json")
        rows[runtime_group_id] = dict(view)
        self._write("managed_run_views.json", rows)

    async def get_managed_run_view(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = self._load_map("managed_run_views.json").get(runtime_group_id)
        return dict(row) if isinstance(row, dict) else None

    async def append_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        rows = self._load_map("runtime_commands.json")
        commands = rows.get(runtime_id) if isinstance(rows.get(runtime_id), list) else []
        command_id = len(commands) + 1
        row = {"id": command_id, "runtime_id": runtime_id, "command": dict(command), "created_at": utc_now_iso(), "delivered": False}
        commands.append(row)
        rows[runtime_id] = commands
        self._write("runtime_commands.json", rows)
        return row

    async def next_runtime_command(self, runtime_id: str, *, after_id: int = 0) -> dict[str, Any] | None:
        rows = self._load_map("runtime_commands.json")
        commands = rows.get(runtime_id) if isinstance(rows.get(runtime_id), list) else []
        for row in commands:
            if isinstance(row, dict) and int(row.get("id") or 0) > after_id:
                return dict(row)
        return None

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        rows = self._load_list("proxy_audit_events.json")
        rows.append(dict(event))
        self._write("proxy_audit_events.json", rows)
