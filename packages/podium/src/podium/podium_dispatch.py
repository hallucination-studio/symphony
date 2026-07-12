from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from .podium_shared import utc_now_iso


class PodiumDispatchMixin:
    def reconciliation_dispatch(self, event: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
        return self._dispatch_from_event(event, self._runtime_group_from_project_binding(binding))

    def _dispatch_from_event(self, event: dict[str, Any], group: dict[str, Any]) -> dict[str, Any]:
        project_binding_id = str(group.get("project_binding_id") or group["id"])
        now = utc_now_iso()
        return {
            "dispatch_id": f"dispatch_{secrets.token_urlsafe(18)}",
            "runtime_group_id": group["id"],
            "project_binding_id": project_binding_id,
            "user_id": str(group.get("linear_workspace_id") or event["workspace_id"]),
            "issue_id": event["issue_id"],
            "issue_identifier": event["issue_identifier"],
            "issue_title": event.get("issue_title") or "",
            "issue_description": event.get("issue_description") or "",
            "linear_workspace_id": event["workspace_id"],
            "project_slug": event["project_slug"],
            "agent_app_user_id": event.get("agent_app_user_id") or "",
            "routing_rule_id": group["id"],
            "blocked_by": list(event.get("blocked_by") or []),
            "parent_issue_id": event.get("parent_issue_id") or "",
            "managed_run_intent": dict(event.get("managed_run_intent") or {}),
            "intake_key": str(event.get("intake_key") or f"linear-issue:{event['issue_id']}"),
            "status": "queued",
            "reason": "",
            "run_id": "",
            "active_work_item_id": "",
            "managed_run_state": "",
            "plan_version": 0,
            "backend_session_id": "",
            "leased_runtime_id": None,
            "leased_until": None,
            "fencing_token": 0,
            "created_at": now,
            "updated_at": now,
        }

    def _runtime_group_from_project_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        binding_id = str(binding.get("id") or "")
        return {
            "id": binding_id,
            "linear_workspace_id": str(binding.get("user_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "project_binding_id": binding_id,
            "instance_id": str(binding.get("instance_id") or ""),
        }

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
            binding = await self.store.get_project_binding(str(leased.get("project_binding_id") or ""))
            leased.update(
                {
                    "runtime_group_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                    "routing_rule_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                    "blocked_by": list(leased.get("blocked_by") or []),
                    "parent_issue_id": str(leased.get("parent_issue_id") or ""),
                    "instance_id": str((binding or {}).get("instance_id") or ""),
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
