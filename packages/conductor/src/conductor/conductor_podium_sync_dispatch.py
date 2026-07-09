from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .conductor_pipeline import _sanitize_error
from .conductor_service_types import ConductorServiceError
from performer_api.pipeline import HumanEscalationReason


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
        accepted = self.pipeline_coordinator.accept_dispatch(event, instance_id=instance.id)
        refreshed = self.get_instance(instance.id) or instance
        runtime_mode = None
        if not self._pipeline_configured():
            await self.post_podium_report()
        if self._pipeline_configured():
            started_count = await self.pipeline_coordinator.start_due_attempts(refreshed)
            runtime_mode = "plan" if started_count else None
        else:
            if not any(
                str(wait.get("node_id") or "") == accepted.node_id and str(wait.get("status") or "waiting") == "waiting"
                for wait in self.pipeline_store.list_human_waits()
            ):
                self.pipeline_store.create_human_wait(
                    accepted.node_id,
                    reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
                    details={
                        "error": "pipeline runtime profiles are not configured",
                        "action_required": "configure_runtime_profiles",
                        "issue_id": issue_id or None,
                        "issue_identifier": issue_identifier or None,
                    },
                )
        attempt_ack = self._pipeline_dispatch_attempt_ack(accepted.node_id)
        return {
            "status": "accepted",
            "issue_id": issue_id or None,
            "issue_identifier": issue_identifier or None,
            "instance_id": instance.id,
            "agent_session_id": event.get("agent_session_id") or None,
            "agent_app_user_id": agent_app_user_id,
            "graph_node_id": accepted.node_id,
            "graph_id": accepted.graph_id,
            "plan_attempt_id": accepted.plan_attempt_id,
            "runtime_mode": runtime_mode,
            **attempt_ack,
        }

    def _record_dispatch_skip_finding(
        self,
        *,
        reason: str,
        issue_id: str,
        issue_identifier: str,
        project_slug: str,
    ) -> None:
        findings = getattr(self, "_pipeline_reconcile_findings", None)
        if findings is None:
            findings = []
            self._pipeline_reconcile_findings = findings
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

    def _pipeline_dispatch_attempt_ack(self, node_id: str) -> dict[str, Any]:
        attempts = [attempt for attempt in self.pipeline_store.list_attempts() if attempt.node_id == node_id]
        if not attempts:
            return {
                "node_id": node_id,
                "attempt_id": "",
                "mode": "",
                "attempt_status": "",
                "graph_revision": self.pipeline_store.current_graph_revision(),
                "policy_revision": self.pipeline_store.active_runtime_config().scheduler_policy.version,
                "lease_id": "",
            }
        attempt = attempts[-1]
        lease = self.pipeline_store.active_lease(attempt.node_id, attempt.mode)
        return {
            "node_id": attempt.node_id,
            "attempt_id": attempt.attempt_id,
            "mode": attempt.mode.value,
            "attempt_status": attempt.state.value,
            "graph_revision": self.pipeline_store.current_graph_revision(),
            "policy_revision": self.pipeline_store.active_runtime_config().scheduler_policy.version,
            "lease_id": lease.lease_id if lease is not None and lease.attempt_id == attempt.attempt_id else "",
        }

    def _pipeline_configured(self) -> bool:
        try:
            envelope = self.pipeline_store.active_runtime_config()
        except Exception:
            return False
        return bool(envelope.profiles)

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
                    "graph_id": result.get("graph_id"),
                    "node_id": result.get("node_id"),
                    "attempt_id": result.get("attempt_id"),
                    "mode": result.get("mode"),
                    "attempt_status": result.get("attempt_status"),
                    "graph_revision": result.get("graph_revision"),
                    "policy_revision": result.get("policy_revision"),
                    "lease_id": result.get("lease_id"),
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
                self._record_pipeline_sync_failure(
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
