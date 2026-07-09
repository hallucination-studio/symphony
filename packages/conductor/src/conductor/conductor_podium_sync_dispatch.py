from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .conductor_podium_sync_failure import _sanitize_error
from .conductor_service_types import ConductorServiceError


class PodiumDispatchMixin:
    async def dispatch_podium_event(self, event: dict[str, Any]) -> dict[str, Any]:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        if not issue_id and not issue_identifier:
            raise ConductorServiceError("missing_issue_id", "Podium dispatch event requires issue_id or issue_identifier")
        project_slug = str(event.get("project_slug") or "").strip()
        agent_app_user_id = str(event.get("agent_app_user_id") or event.get("app_user_id") or "").strip()
        if not agent_app_user_id:
            self._record_dispatch_skip_finding(
                reason="missing_linear_agent_app_user",
                issue_id=issue_id,
                issue_identifier=issue_identifier,
                project_slug=project_slug,
            )
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "missing_linear_agent_app_user",
            }
        instance = self._instance_for_podium_event(
            project_slug=project_slug,
            agent_app_user_id=agent_app_user_id,
            instance_id=str(event.get("instance_id") or "").strip(),
        )
        if instance is None:
            self._record_dispatch_skip_finding(
                reason="no_matching_instance",
                issue_id=issue_id,
                issue_identifier=issue_identifier,
                project_slug=project_slug,
            )
            return {
                "status": "skipped",
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "reason": "no_matching_instance",
            }
        accepted = self.managed_run_coordinator.accept_dispatch(event, instance_id=instance.id)
        run = self.managed_run_store.get_run(accepted.run_id) or {}
        return {
            "status": "accepted",
            "issue_id": issue_id or None,
            "issue_identifier": issue_identifier or None,
            "instance_id": instance.id,
            "agent_session_id": event.get("agent_session_id") or None,
            "agent_app_user_id": agent_app_user_id,
            "run_id": accepted.run_id,
            "parent_issue_id": accepted.parent_issue_id,
            "active_work_item_id": run.get("active_work_item_id") or "",
            "managed_run_state": run.get("state") or "planning",
            "plan_version": run.get("plan_version") or 0,
            "backend_session_id": run.get("backend_session_id") or "",
        }

    def _record_dispatch_skip_finding(
        self,
        *,
        reason: str,
        issue_id: str,
        issue_identifier: str,
        project_slug: str,
    ) -> None:
        findings = getattr(self, "_managed_run_reconcile_findings", None)
        if findings is None:
            findings = []
            self._managed_run_reconcile_findings = findings
        findings.append(
            {
                "event": "podium_dispatch_skipped",
                "severity": "warning",
                "error_type": "RuntimeError",
                "sanitized_reason": reason,
                "action_required": "fix_dispatch_routing",
                "retryable": True,
                "issue_id": issue_id or None,
                "issue_identifier": issue_identifier or None,
                "project_slug": project_slug or None,
            }
        )

    async def poll_podium_dispatch_once(self) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/dispatches/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            leased = lease_response.json().get("dispatch")
            if not leased:
                return {"status": "idle"}
            result = await self.dispatch_podium_event(leased)
            await client.post(
                f"{podium_url}/api/v1/runtime/dispatches/ack",
                headers=headers,
                json={
                    "dispatch_id": leased.get("dispatch_id"),
                    "fencing_token": leased.get("fencing_token"),
                    "status": result.get("status", "accepted"),
                    "reason": result.get("reason"),
                    "run_id": result.get("run_id"),
                    "parent_issue_id": result.get("parent_issue_id"),
                    "active_work_item_id": result.get("active_work_item_id"),
                    "managed_run_state": result.get("managed_run_state"),
                    "plan_version": result.get("plan_version"),
                    "backend_session_id": result.get("backend_session_id"),
                },
            )
            return {"status": "leased", "dispatch": leased, "result": result}

    async def _drain_podium_dispatch_queue(self) -> dict[str, int]:
        received = 0
        failed = 0
        skipped = 0
        while True:
            try:
                event = self._podium_dispatch_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            try:
                if event.get("_lease_dispatch"):
                    result = await self.poll_podium_dispatch_once()
                else:
                    result = await self.dispatch_podium_event(event)
            except Exception as exc:
                self._record_managed_run_sync_failure(
                    "podium_dispatch_drain_failed",
                    None,
                    exc,
                    action_required="retry_dispatch_drain",
                    extra={"issue_id": event.get("issue_id"), "issue_identifier": event.get("issue_identifier")},
                )
                result = {"status": "failed", "reason": _sanitize_error(exc)}
            if result.get("status") in {"accepted", "leased"}:
                received += 1
            elif result.get("status") == "failed":
                failed += 1
            elif result.get("status") == "skipped":
                skipped += 1
        return {"acked": received, "failed": failed, "skipped": skipped}
