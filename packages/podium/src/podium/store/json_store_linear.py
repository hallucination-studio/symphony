from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from ..podium_shared import _datetime_from_json


class JsonStoreLinearMixin:
    @asynccontextmanager
    async def linear_installation_token_lock(self, installation_id: str):
        locks = getattr(self, "_linear_installation_token_locks", None)
        if locks is None:
            locks = {}
            self._linear_installation_token_locks = locks
        lock = locks.setdefault(installation_id, asyncio.Lock())
        async with lock:
            yield

    async def save_linear_application_config(self, config: dict[str, Any]) -> None:
        rows = self._load_map("linear_application_configs.json")
        rows[str(config["id"])] = dict(config)
        self._write("linear_application_configs.json", rows)

    async def get_linear_application_config(self, config_id: str) -> dict[str, Any] | None:
        row = self._load_map("linear_application_configs.json").get(config_id)
        return dict(row) if isinstance(row, dict) else None

    async def list_linear_application_configs(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._load_map("linear_application_configs.json").values()
        return [dict(row) for row in rows if isinstance(row, dict) and str(row.get("user_id") or "") == user_id]

    async def set_linear_application_preference(self, user_id: str, config_id: str) -> None:
        rows = self._load_map("linear_application_preferences.json")
        rows[user_id] = {"user_id": user_id, "config_id": config_id}
        self._write("linear_application_preferences.json", rows)

    async def get_linear_application_preference(self, user_id: str) -> str | None:
        row = self._load_map("linear_application_preferences.json").get(user_id)
        if not isinstance(row, dict):
            return None
        return str(row.get("config_id") or "") or None

    async def save_oauth_state(self, state: str, record: dict[str, Any]) -> None:
        rows = self._load_map("oauth_states.json")
        rows[state] = {"state": state, **dict(record)}
        self._write("oauth_states.json", rows)

    async def consume_oauth_state(self, state: str) -> dict[str, Any] | None:
        rows = self._load_map("oauth_states.json")
        row = rows.pop(state, None)
        self._write("oauth_states.json", rows)
        if not isinstance(row, dict):
            return None
        expires_at = _datetime_from_json(str(row.get("expires_at") or ""))
        if expires_at is None or expires_at < datetime.now(timezone.utc):
            return None
        return dict(row)

    async def save_workspace_installation(self, installation: dict[str, Any]) -> None:
        rows = self._load_map("linear_workspace_installations.json")
        rows[str(installation["id"])] = dict(installation)
        self._write("linear_workspace_installations.json", rows)

    async def update_workspace_installation_reconciliation(
        self,
        user_id: str,
        installation_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any] | None:
        rows = self._load_map("linear_workspace_installations.json")
        current = rows.get(installation_id)
        if not isinstance(current, dict) or current.get("user_id") != user_id or not current.get("active"):
            return None
        updated = {**current, **changes}
        rows[installation_id] = updated
        self._write("linear_workspace_installations.json", rows)
        return dict(updated)

    async def list_workspace_installations(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._load_map("linear_workspace_installations.json").values()
        result = [dict(row) for row in rows if isinstance(row, dict) and str(row.get("user_id") or "") == user_id]
        return sorted(result, key=lambda row: str(row.get("created_at") or ""))

    async def activate_workspace_installation(self, user_id: str, installation_id: str) -> None:
        rows = self._load_map("linear_workspace_installations.json")
        for key, raw in rows.items():
            if not isinstance(raw, dict) or str(raw.get("user_id") or "") != user_id:
                continue
            row = dict(raw)
            if key == installation_id:
                row["state"] = "ready"
                row["active"] = True
            elif row.get("active"):
                row["state"] = "retired"
                row["active"] = False
            rows[key] = row
        self._write("linear_workspace_installations.json", rows)

    async def get_active_workspace_installation(self, user_id: str) -> dict[str, Any] | None:
        rows = await self.list_workspace_installations(user_id)
        return next((row for row in reversed(rows) if bool(row.get("active"))), None)

    async def get_candidate_workspace_installation(self, user_id: str) -> dict[str, Any] | None:
        rows = await self.list_workspace_installations(user_id)
        candidate_states = {"accepted", "draining", "preparing", "failed"}
        return next(
            (row for row in reversed(rows) if not bool(row.get("active")) and row.get("state") in candidate_states),
            None,
        )

    async def disconnect_workspace_installation(self, user_id: str, installation_id: str) -> None:
        rows = self._load_map("linear_workspace_installations.json")
        row = rows.get(installation_id)
        if isinstance(row, dict) and str(row.get("user_id") or "") == user_id:
            rows[installation_id] = {**row, "active": False, "state": "disconnected"}
            self._write("linear_workspace_installations.json", rows)

    async def find_active_workspace_installation(
        self,
        linear_organization_id: str,
    ) -> dict[str, Any] | None:
        for row in self._load_map("linear_workspace_installations.json").values():
            if not isinstance(row, dict):
                continue
            if bool(row.get("active")) and str(row.get("linear_organization_id") or "") == linear_organization_id:
                return dict(row)
        return None

    async def list_active_workspace_installations(self) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self._load_map("linear_workspace_installations.json").values()
            if isinstance(row, dict) and bool(row.get("active"))
        ]

    async def save_linear_reconciliation_state(self, binding_id: str, state: dict[str, Any]) -> None:
        rows = self._load_map("linear_reconciliation_state.json")
        rows[binding_id] = dict(state)
        self._write("linear_reconciliation_state.json", rows)

    async def get_linear_reconciliation_state(self, binding_id: str) -> dict[str, Any] | None:
        row = self._load_map("linear_reconciliation_state.json").get(binding_id)
        return dict(row) if isinstance(row, dict) else None

    async def get_linear_issue_observation(self, binding_id: str, issue_id: str) -> dict[str, Any] | None:
        key = f"{binding_id}:{issue_id}"
        row = self._load_map("linear_issue_observations.json").get(key)
        return dict(row) if isinstance(row, dict) else None

    async def get_linear_issue_observations(
        self,
        binding_id: str,
        issue_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        rows = self._load_map("linear_issue_observations.json")
        return {
            issue_id: dict(row)
            for issue_id in issue_ids
            if isinstance((row := rows.get(f"{binding_id}:{issue_id}")), dict)
        }

    async def commit_linear_reconciliation_page(
        self,
        binding_id: str,
        *,
        state: dict[str, Any],
        observations: list[dict[str, Any]],
        dispatches: list[dict[str, Any]],
    ) -> int:
        observation_rows = self._load_map("linear_issue_observations.json")
        dispatch_rows = self._load_map("dispatches.json")
        inserted = 0
        for observation in observations:
            key = f"{binding_id}:{observation['issue_id']}"
            observation_rows[key] = dict(observation)
        for dispatch in dispatches:
            if _dispatch_exists(dispatch_rows, dispatch):
                continue
            dispatch_rows[str(dispatch["dispatch_id"])] = dict(dispatch)
            inserted += 1
        states = self._load_map("linear_reconciliation_state.json")
        states[binding_id] = {**state, "binding_id": binding_id}
        self._write("linear_issue_observations.json", observation_rows)
        self._write("dispatches.json", dispatch_rows)
        self._write("linear_reconciliation_state.json", states)
        return inserted

    async def switch_workspace_installation(
        self,
        user_id: str,
        installation_id: str,
        app_user_id: str,
    ) -> None:
        installations = self._load_map("linear_workspace_installations.json")
        for key, raw in installations.items():
            if not isinstance(raw, dict) or str(raw.get("user_id") or "") != user_id:
                continue
            row = dict(raw)
            if key == installation_id:
                row.update({"active": True, "state": "ready", "action_required": "", "next_action": ""})
            elif row.get("active"):
                row.update({"active": False, "state": "retired"})
            installations[key] = row
        bindings = self._load_map("project_bindings.json")
        for key, raw in bindings.items():
            if not isinstance(raw, dict) or str(raw.get("user_id") or "") != user_id or not raw.get("active", True):
                continue
            row = dict(raw)
            row.update(
                {
                    "installation_id": installation_id,
                    "agent_app_user_id": app_user_id,
                    "config_version": int(row.get("candidate_config_version") or 0),
                    "state": "switching",
                    "candidate_installation_id": "",
                    "candidate_agent_app_user_id": "",
                    "candidate_config_version": 0,
                    "candidate_acknowledged_config_version": 0,
                }
            )
            bindings[key] = row
        self._write("linear_workspace_installations.json", installations)
        self._write("project_bindings.json", bindings)

    async def replace_selected_linear_projects(self, user_id: str, projects: list[dict[str, Any]]) -> None:
        rows = self._load_map("linear_selected_projects.json")
        rows = {
            key: value
            for key, value in rows.items()
            if not isinstance(value, dict) or str(value.get("user_id") or "") != user_id
        }
        for project in projects:
            key = f"{user_id}:{project['linear_project_id']}"
            rows[key] = dict(project)
        self._write("linear_selected_projects.json", rows)

    async def list_selected_linear_projects(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._load_map("linear_selected_projects.json").values()
        selected = [
            dict(row)
            for row in rows
            if isinstance(row, dict) and str(row.get("user_id") or "") == user_id
        ]
        return sorted(selected, key=lambda row: str(row.get("linear_project_id") or ""))


def _dispatch_exists(rows: dict[str, Any], dispatch: dict[str, Any]) -> bool:
    return any(
        isinstance(row, dict)
        and row.get("project_binding_id") == dispatch.get("project_binding_id")
        and row.get("intake_key") == dispatch.get("intake_key")
        for row in rows.values()
    )
