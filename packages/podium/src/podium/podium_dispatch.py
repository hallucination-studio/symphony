from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from .podium_shared import utc_now_iso


class PodiumDispatchMixin:
    async def queue_dispatches(self, event: dict[str, Any]) -> int:
        queued = 0
        groups = await self._runtime_groups_for_dispatch_event(event)
        for group in groups:
            project_binding_id = str(group.get("project_binding_id") or group["id"])
            dispatch_id = f"dispatch_{secrets.token_urlsafe(18)}"
            dispatch = {
                "dispatch_id": dispatch_id,
                "runtime_group_id": group["id"],
                "project_binding_id": project_binding_id,
                "user_id": str(group.get("linear_workspace_id") or event["workspace_id"]),
                "issue_id": event["issue_id"],
                "issue_identifier": event["issue_identifier"],
                "issue_title": event.get("issue_title") or "",
                "issue_description": event.get("issue_description") or "",
                "linear_workspace_id": event["workspace_id"],
                "project_slug": event["project_slug"],
                "agent_session_id": str(event.get("agent_session_id") or ""),
                "agent_app_user_id": event.get("agent_app_user_id") or "",
                "routing_rule_id": group["id"],
                "managed_run_profile": group.get("managed_run_profile") or "default",
                "blocked_by": list(event.get("blocked_by") or []),
                "parent_issue_id": event.get("parent_issue_id") or "",
                "managed_run_intent": dict(event.get("managed_run_intent") or {}),
                "status": "queued",
                "reason": "",
                "run_id": "",
                "parent_issue_id": event.get("parent_issue_id") or "",
                "active_work_item_id": "",
                "managed_run_state": "",
                "plan_version": 0,
                "backend_session_id": "",
                "leased_runtime_id": None,
                "leased_until": None,
                "fencing_token": 0,
                "created_at": utc_now_iso(),
                "updated_at": utc_now_iso(),
            }
            inserted = await self.store.upsert_dispatch(dispatch)
            if not inserted:
                continue
            binding = await self._binding_for_group(group)
            conductor_id = str((binding or {}).get("conductor_id") or "")
            if conductor_id:
                await self.enqueue_runtime_command(
                    conductor_id,
                    {"type": "dispatch.available", "project_binding_id": project_binding_id, "instance_id": (binding or {}).get("instance_id")},
                )
            queued += 1
        return queued

    async def _runtime_groups_for_dispatch_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        agent_ids = [str(event.get("agent_app_user_id") or ""), str(event.get("issue_delegate_id") or "")]
        loaded = await self.store.list_project_bindings_for_route(
            user_id=str(event.get("workspace_id") or ""),
            project_slug=str(event.get("project_slug") or ""),
            agent_app_user_ids=[agent_id for agent_id in agent_ids if agent_id],
        )
        return [self._runtime_group_from_project_binding(binding) for binding in loaded]

    def _runtime_group_from_project_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        binding_id = str(binding.get("id") or "")
        return {
            "id": binding_id,
            "linear_workspace_id": str(binding.get("user_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "managed_run_profile": str(binding.get("managed_run_profile") or "default"),
            "project_binding_id": binding_id,
        }

    async def _binding_for_group(self, group: dict[str, Any]) -> dict[str, Any] | None:
        binding_id = str(group.get("project_binding_id") or "")
        if not binding_id:
            return None
        conductor_id = binding_id.split(":", 1)[0] if ":" in binding_id else ""
        for binding in await self.store.list_project_bindings_for_conductor(conductor_id):
            if str(binding.get("id") or "") == binding_id:
                return binding
        return None

    async def lease_dispatch(self, runtime_id: str) -> dict[str, Any] | None:
        runtime = await self.store.get_runtime(runtime_id)
        if runtime is None:
            return None
        binding_ids = [
            str(binding.get("id") or "")
            for binding in await self.store.list_project_bindings_for_conductor(runtime_id)
            if str(binding.get("id") or "")
        ]
        leased = await self.store.lease_dispatch(
            runtime_id,
            binding_ids=sorted(binding_ids),
            lease_until=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        )
        if leased is not None:
            group = await self.store.get_runtime_group(str(leased.get("project_binding_id") or "")) or {}
            leased.update(
                {
                    "runtime_group_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                    "routing_rule_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                    "managed_run_profile": str(group.get("managed_run_profile") or "default"),
                    "blocked_by": list(leased.get("blocked_by") or []),
                    "parent_issue_id": str(leased.get("parent_issue_id") or ""),
                }
            )
        return leased

    async def reap_expired_dispatch_leases(self) -> int:
        return int(await self.store.reap_expired_dispatch_leases())

    async def ack_dispatch(
        self,
        runtime_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None = None,
        reason: str | None = None,
        managed_run: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if fencing_token is None:
            return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
        managed_run = _sanitize_managed_run_ack(managed_run or {})
        completed_at = utc_now_iso() if status in {"completed", "failed", "cancelled", "canceled"} else None
        saved = await self.store.ack_dispatch(
            runtime_id,
            dispatch_id,
            status,
            fencing_token=fencing_token,
            reason=reason or "",
            managed_run=managed_run,
            completed_at=completed_at,
        )
        if saved is None:
            return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
        return saved

    def reconcile_dispatch_acks(self) -> list[dict[str, Any]]:
        return []


def _sanitize_managed_run_ack(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key in ("run_id", "parent_issue_id", "active_work_item_id", "managed_run_state", "backend_session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            sanitized[key] = value[:256]
    for key in ("plan_version",):
        try:
            sanitized[key] = int(payload.get(key) or 0)
        except (TypeError, ValueError):
            sanitized[key] = 0
    return sanitized
