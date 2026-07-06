from __future__ import annotations

import asyncio
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, WebSocket

from .store.postgres import PgStore
from .store.redis import RedisStore

from .podium_shared import (
    bearer_token,
    dispatch_public,
    hash_secret,
    sanitize_codex_profile,
    utc_now_iso,
    _datetime_from_json,
)

class PodiumDispatchMixin:
    async def queue_dispatches(self, event: dict[str, Any]) -> int:
        queued = 0
        groups = await self._runtime_groups_for_dispatch_event(event)
        for group in groups:
            if not group.get("project_binding_id") and self.project_bindings:
                continue
            if group.get("linear_workspace_id") and group.get("linear_workspace_id") != event.get("workspace_id"):
                continue
            if group.get("project_slug") and group.get("project_slug") != event.get("project_slug"):
                continue
            expected_agent = str(group.get("linear_agent_app_user_id") or "")
            if expected_agent and expected_agent not in {
                str(event.get("agent_app_user_id") or ""),
                str(event.get("issue_delegate_id") or ""),
            }:
                continue
            project_binding_id = str(group.get("project_binding_id") or group["id"])
            if self.pg_store is None:
                if any(
                    str(dispatch.get("project_binding_id") or "") == project_binding_id
                    and str(dispatch.get("agent_session_id") or "") == str(event.get("agent_session_id") or "")
                    for dispatch in self.dispatches.values()
                ):
                    continue
            dispatch_id = f"dispatch_{secrets.token_urlsafe(18)}"
            agent_session_id = str(event.get("agent_session_id") or "")
            dispatch = {
                "dispatch_id": dispatch_id,
                "runtime_group_id": group["id"],
                "project_binding_id": project_binding_id,
                "user_id": str(group.get("linear_workspace_id") or event["workspace_id"]),
                "issue_id": event["issue_id"],
                "issue_identifier": event["issue_identifier"],
                "linear_workspace_id": event["workspace_id"],
                "project_slug": event["project_slug"],
                "agent_session_id": agent_session_id,
                "agent_app_user_id": event.get("agent_app_user_id") or "",
                "routing_rule_id": group["id"],
                "workflow_profile": group.get("workflow_profile") or "task",
                "codex_profile": sanitize_codex_profile(group.get("codex_profile")),
                "blocked_by": list(event.get("blocked_by") or []),
                "parent_issue_id": event.get("parent_issue_id") or "",
                "status": "queued",
                "reason": "",
                "runtime_phase": "",
                "leased_runtime_id": None,
                "leased_until": None,
                "fencing_token": 0,
                "created_at": utc_now_iso(),
                "updated_at": utc_now_iso(),
            }
            if self.pg_store is not None:
                inserted = await self.pg_store.upsert_dispatch(dispatch)
                if not inserted:
                    continue
            self.dispatches[dispatch_id] = dispatch
            self.persist()
            binding_id = str(group.get("project_binding_id") or "")
            if binding_id:
                binding = self.project_bindings.get(binding_id) or {}
                conductor_id = str(binding.get("conductor_id") or "")
                if conductor_id:
                    await self.enqueue_runtime_command(
                        conductor_id,
                        {
                            "type": "dispatch.available",
                            "project_binding_id": binding_id,
                            "instance_id": binding.get("instance_id"),
                        },
                    )
            queued += 1
        return queued

    async def _runtime_groups_for_dispatch_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        if self.pg_store is None:
            return list(self.runtime_groups.values())
        agent_ids = [
            str(event.get("agent_app_user_id") or ""),
            str(event.get("issue_delegate_id") or ""),
        ]
        loaded = await self.pg_store.list_project_bindings_for_route(
            user_id=str(event.get("workspace_id") or ""),
            project_slug=str(event.get("project_slug") or ""),
            agent_app_user_ids=[agent_id for agent_id in agent_ids if agent_id],
        )
        for binding in loaded:
            binding_id = str(binding.get("id") or "")
            if not binding_id:
                continue
            self.project_bindings[binding_id] = binding
            self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
        return [self._runtime_group_from_project_binding(binding) for binding in loaded]

    def _runtime_group_from_project_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        binding_id = str(binding.get("id") or "")
        return {
            "id": binding_id,
            "linear_workspace_id": str(binding.get("user_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "workflow_profile": str(binding.get("workflow_profile") or "task"),
            "codex_profile": sanitize_codex_profile(binding.get("codex_profile")),
            "project_binding_id": binding_id,
        }

    async def lease_dispatch(self, runtime_id: str) -> dict[str, Any] | None:
        runtime = self.runtimes.get(runtime_id)
        if runtime is None and self.pg_store is not None:
            runtime = await self.pg_store.get_runtime(runtime_id)
            if runtime is not None:
                self.runtimes[runtime_id] = runtime
        if runtime is None:
            return None
        binding_ids = {
            binding_id
            for binding_id, binding in self.project_bindings.items()
            if str(binding.get("conductor_id") or "") == runtime_id
        }
        if self.pg_store is not None:
            binding_ids = set()
            for binding in await self.pg_store.list_project_bindings_for_conductor(runtime_id):
                binding_id = str(binding.get("id") or "")
                if not binding_id:
                    continue
                self.project_bindings[binding_id] = binding
                self.runtime_groups[binding_id] = self._runtime_group_from_project_binding(binding)
                binding_ids.add(binding_id)
        now = datetime.now(timezone.utc)
        if self.pg_store is not None:
            leased = await self.pg_store.lease_dispatch(
                runtime_id,
                binding_ids=sorted(binding_ids),
                lease_until=(now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
            )
            if leased is not None:
                group = self.runtime_groups.get(str(leased.get("project_binding_id") or "")) or {}
                leased.update(
                    {
                        "runtime_group_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                        "routing_rule_id": str(group.get("id") or leased.get("project_binding_id") or ""),
                        "workflow_profile": str(group.get("workflow_profile") or "task"),
                        "codex_profile": sanitize_codex_profile(group.get("codex_profile")),
                        "blocked_by": [],
                        "parent_issue_id": "",
                    }
                )
            return leased
        for dispatch in self.dispatches.values():
            if binding_ids:
                if dispatch.get("project_binding_id") not in binding_ids:
                    continue
            elif dispatch["runtime_group_id"] != runtime["runtime_group_id"]:
                continue
            leased_until = dispatch.get("leased_until")
            retryable = isinstance(leased_until, datetime) and leased_until < now
            if dispatch["status"] not in {"queued", "leased"}:
                continue
            if dispatch["status"] == "leased" and not retryable:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = runtime_id
            dispatch["leased_until"] = now + timedelta(minutes=5)
            dispatch["fencing_token"] = int(dispatch.get("fencing_token") or 0) + 1
            dispatch["updated_at"] = utc_now_iso()
            self.persist()
            return dispatch
        return None

    async def reap_expired_dispatch_leases(self) -> int:
        if self.pg_store is not None:
            return int(await self.pg_store.reap_expired_dispatch_leases())
        now = datetime.now(timezone.utc)
        reaped = 0
        for dispatch in self.dispatches.values():
            leased_until = dispatch.get("leased_until")
            if isinstance(leased_until, str):
                leased_until = _datetime_from_json(leased_until)
            if dispatch.get("status") == "leased" and isinstance(leased_until, datetime) and leased_until < now:
                dispatch["status"] = "queued"
                dispatch["leased_runtime_id"] = None
                dispatch["leased_until"] = None
                dispatch["updated_at"] = utc_now_iso()
                reaped += 1
        if reaped:
            self.persist()
        return reaped

    async def ack_dispatch(
        self,
        runtime_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None = None,
        reason: str | None = None,
        runtime_phase: str | None = None,
    ) -> dict[str, Any] | None:
        if self.pg_store is not None:
            if fencing_token is None:
                return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
            ack_status = status
            ack_reason = reason or ""
            ack_runtime_phase = runtime_phase or ""
            if status in {"completed", "failed"} and runtime_phase not in {"done", "failed"}:
                ack_status = "ack_drift"
                ack_reason = "dispatch ack missing conductor terminal run event"
            completed_at = utc_now_iso() if ack_status in {"completed", "failed", "cancelled", "canceled"} else None
            saved = await self.pg_store.ack_dispatch(
                runtime_id,
                dispatch_id,
                ack_status,
                fencing_token=fencing_token,
                reason=ack_reason,
                runtime_phase=ack_runtime_phase,
                completed_at=completed_at,
            )
            if saved is None:
                return {"dispatch_id": dispatch_id, "_ack_error": "stale_dispatch_lease"}
            self.dispatches[str(saved.get("dispatch_id") or dispatch_id)] = saved
            return saved

        dispatch = self.dispatches.get(dispatch_id)
        if dispatch is None or dispatch.get("leased_runtime_id") != runtime_id:
            return None
        if fencing_token is not None and fencing_token != int(dispatch.get("fencing_token") or 0):
            return {**dispatch, "_ack_error": "stale_dispatch_lease"}
        if status in {"completed", "failed"} and runtime_phase not in {"done", "failed"}:
            dispatch["status"] = "ack_drift"
            dispatch["reason"] = "dispatch ack missing conductor terminal run event"
            if runtime_phase is not None:
                dispatch["runtime_phase"] = runtime_phase
            dispatch["updated_at"] = utc_now_iso()
            self.persist()
            return dispatch
        dispatch["status"] = status
        if reason is not None:
            dispatch["reason"] = reason
        if runtime_phase is not None:
            dispatch["runtime_phase"] = runtime_phase
        dispatch["updated_at"] = utc_now_iso()
        if status in {"completed", "failed", "cancelled", "canceled"}:
            dispatch["completed_at"] = dispatch["updated_at"]
        if self.pg_store is not None:
            saved = await self.pg_store.ack_dispatch(
                runtime_id,
                dispatch_id,
                dispatch["status"],
                fencing_token=fencing_token,
                reason=str(dispatch.get("reason") or ""),
                runtime_phase=str(dispatch.get("runtime_phase") or ""),
                completed_at=dispatch.get("completed_at"),
            )
            if saved is None:
                return {**dispatch, "_ack_error": "stale_dispatch_lease"} if fencing_token is not None else None
        self.persist()
        return dispatch

    def reconcile_dispatch_acks(self) -> list[dict[str, Any]]:
        findings: list[dict[str, Any]] = []
        for dispatch in self.dispatches.values():
            status = str(dispatch.get("status") or "")
            runtime_phase = str(dispatch.get("runtime_phase") or "")
            if status not in {"completed", "failed"}:
                continue
            if runtime_phase in {"done", "failed"}:
                continue
            findings.append(
                {
                    "code": "dispatch_ack_without_terminal_run_event",
                    "dispatch_id": str(dispatch.get("dispatch_id") or ""),
                    "issue_id": str(dispatch.get("issue_id") or ""),
                    "runtime_phase": runtime_phase,
                    "status": status,
                }
            )
        return findings

