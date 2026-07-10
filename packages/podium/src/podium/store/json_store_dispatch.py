from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..podium_shared import _datetime_from_json, utc_now_iso


class JsonStoreDispatchMixin:
    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        rows = self._load_map("project_bindings.json")
        rows[str(binding["id"])] = dict(binding)
        self._write("project_bindings.json", rows)
        conductor = self._load_map("conductors.json").get(str(binding.get("conductor_id") or ""))
        runtime_group_id = str((conductor or {}).get("runtime_group_id") or "")
        await self.upsert_runtime_group(
            {
                "id": runtime_group_id or str(binding["id"]),
                "linear_workspace_id": str(binding.get("user_id") or ""),
                "project_slug": str(binding.get("project_slug") or ""),
                "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
                "managed_run_profile": str(binding.get("managed_run_profile") or "default"),
                "project_binding_id": str(binding["id"]),
            }
        )

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._load_map("project_bindings.json").values()
            if isinstance(row, dict) and str(row.get("conductor_id") or "") == conductor_id
        ]
        return sorted(rows, key=lambda row: str(row.get("id") or ""))

    async def get_project_binding(self, binding_id: str) -> dict[str, Any] | None:
        row = self._load_map("project_bindings.json").get(binding_id)
        return dict(row) if isinstance(row, dict) else None

    async def list_project_bindings_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self._load_map("project_bindings.json").values()
            if isinstance(row, dict) and str(row.get("user_id") or "") == user_id and bool(row.get("active", True))
        ]

    async def count_open_dispatches_for_user(self, user_id: str) -> int:
        terminal = {"completed", "failed", "cancelled", "canceled"}
        return sum(
            1
            for row in self._load_map("dispatches.json").values()
            if isinstance(row, dict)
            and str(row.get("user_id") or "") == user_id
            and str(row.get("status") or "") not in terminal
        )

    async def count_open_dispatches_for_binding(self, binding_id: str) -> int:
        terminal = {"completed", "failed", "cancelled", "canceled"}
        return sum(
            1
            for row in self._load_map("dispatches.json").values()
            if isinstance(row, dict)
            and str(row.get("project_binding_id") or "") == binding_id
            and str(row.get("status") or "") not in terminal
        )

    async def get_active_project_binding_for_project(
        self,
        user_id: str,
        linear_project_id: str,
    ) -> dict[str, Any] | None:
        for row in self._load_map("project_bindings.json").values():
            if not isinstance(row, dict):
                continue
            if (
                str(row.get("user_id") or "") == user_id
                and str(row.get("linear_project_id") or "") == linear_project_id
                and bool(row.get("active", True))
            ):
                return dict(row)
        return None

    async def list_project_bindings_for_route(self, *, user_id: str, project_slug: str, agent_app_user_ids: list[str]) -> list[dict[str, Any]]:
        expected_agents = {str(agent_id) for agent_id in agent_app_user_ids if str(agent_id)}
        return [
            dict(row)
            for row in self._load_map("project_bindings.json").values()
            if isinstance(row, dict)
            and str(row.get("user_id") or "") == user_id
            and str(row.get("project_slug") or "") == project_slug
            and bool(row.get("active", True))
            and str(row.get("state") or "ready") == "ready"
            and (not str(row.get("agent_app_user_id") or "") or str(row.get("agent_app_user_id") or "") in expected_agents)
        ]

    async def upsert_dispatch(self, dispatch: dict[str, Any]) -> bool:
        rows = self._load_map("dispatches.json")
        for existing in rows.values():
            if not isinstance(existing, dict):
                continue
            same_binding = existing.get("project_binding_id") == dispatch.get("project_binding_id")
            if same_binding and str(dispatch.get("intake_key") or ""):
                if existing.get("intake_key") == dispatch.get("intake_key"):
                    return False
            if same_binding and str(dispatch.get("agent_session_id") or ""):
                if existing.get("agent_session_id") == dispatch.get("agent_session_id"):
                    return False
            elif same_binding and existing.get("issue_id") == dispatch.get("issue_id") and not str(existing.get("agent_session_id") or ""):
                return False
        rows[str(dispatch["dispatch_id"])] = dict(dispatch)
        self._write("dispatches.json", rows)
        return True

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        rows = self._load_map("dispatches.json")
        now = datetime.now(timezone.utc)
        for dispatch_id, dispatch in sorted(rows.items(), key=lambda item: str((item[1] or {}).get("created_at") or "")):
            if not isinstance(dispatch, dict) or dispatch.get("project_binding_id") not in binding_ids:
                continue
            leased_until = _datetime_from_json(str(dispatch.get("leased_until") or ""))
            retryable = dispatch.get("status") == "leased" and leased_until is not None and leased_until < now
            if dispatch.get("status") != "queued" and not retryable:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = conductor_id
            dispatch["leased_conductor_id"] = conductor_id
            dispatch["leased_until"] = lease_until
            dispatch["fencing_token"] = int(dispatch.get("fencing_token") or 0) + 1
            dispatch["updated_at"] = utc_now_iso()
            rows[dispatch_id] = dispatch
            self._write("dispatches.json", rows)
            return dict(dispatch)
        return None

    async def ack_dispatch(
        self,
        conductor_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None,
        reason: str = "",
        managed_run: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        rows = self._load_map("dispatches.json")
        dispatch = rows.get(dispatch_id)
        if not isinstance(dispatch, dict) or fencing_token is None:
            return None
        if (dispatch.get("leased_runtime_id") or dispatch.get("leased_conductor_id")) != conductor_id:
            return None
        if int(dispatch.get("fencing_token") or 0) != int(fencing_token):
            return None
        dispatch["status"] = status
        dispatch["reason"] = reason
        if managed_run:
            dispatch.update(managed_run)
        dispatch["updated_at"] = utc_now_iso()
        if completed_at is not None:
            dispatch["completed_at"] = completed_at
        elif status in {"completed", "failed", "cancelled", "canceled"}:
            dispatch["completed_at"] = dispatch["updated_at"]
        rows[dispatch_id] = dispatch
        self._write("dispatches.json", rows)
        return dict(dispatch)

    async def reap_expired_dispatch_leases(self) -> int:
        rows = self._load_map("dispatches.json")
        now = datetime.now(timezone.utc)
        reaped = 0
        for dispatch_id, dispatch in rows.items():
            if not isinstance(dispatch, dict) or dispatch.get("status") != "leased":
                continue
            leased_until = _datetime_from_json(str(dispatch.get("leased_until") or ""))
            if leased_until is not None and leased_until < now:
                dispatch["status"] = "queued"
                dispatch["leased_runtime_id"] = None
                dispatch["leased_conductor_id"] = None
                dispatch["leased_until"] = None
                dispatch["updated_at"] = utc_now_iso()
                rows[dispatch_id] = dispatch
                reaped += 1
        if reaped:
            self._write("dispatches.json", rows)
        return reaped
