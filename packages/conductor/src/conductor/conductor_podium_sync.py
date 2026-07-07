from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .conductor_pipeline import PipelineLinearProjector, _append_instance_log, _sanitize_error
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403
from performer_api.pipeline import RuntimeConfigEnvelope


class ConductorPodiumSyncMixin:
    async def dispatch_podium_event(self, event: dict[str, Any]) -> dict[str, Any]:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        if not issue_id and not issue_identifier:
            raise ConductorServiceError("missing_issue_id", "Podium dispatch event requires issue_id or issue_identifier")
        project_slug = str(event.get("project_slug") or "").strip()
        agent_app_user_id = str(event.get("agent_app_user_id") or event.get("app_user_id") or "").strip()
        if not agent_app_user_id:
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

    def build_podium_report(self, *, log_tail_lines: int = 200) -> dict[str, Any]:
        settings = self.store.get_settings()
        bindings: list[dict[str, Any]] = []
        metrics: dict[str, dict[str, Any]] = {}
        queue: dict[str, dict[str, Any]] = {}
        log_tail: dict[str, dict[str, Any]] = {}
        pipeline_view = self.pipeline_store.pipeline_view().to_dict()
        pipeline_metrics = _pipeline_report_metrics(pipeline_view)
        pipeline_queue = _pipeline_report_queue(pipeline_view)
        instances = self.store.list_instances()
        for instance in instances:
            agent_app_user_id = _linear_agent_app_user_id(instance.linear_filters)
            bindings.append(
                {
                    "instance_id": instance.id,
                    "name": instance.name,
                    "linear_project": instance.linear_project,
                    "project_slug": instance.linear_project,
                    "agent_app_user_id": agent_app_user_id,
                    "process_status": instance.process_status,
                    "constraint_labels": _desired_project_labels(instance),
                    "repo_source": {"type": instance.repo_source_type, "value": instance.repo_source_value},
                }
            )
            metrics[instance.id] = {
                **pipeline_metrics,
                "running": bool(instance.process_status == "running"),
            }
            queue[instance.id] = {
                "queued": pipeline_queue["queued"],
                "leased": pipeline_queue["leased"],
                "running": 1 if instance.process_status == "running" else 0,
            }
            logs = self.query_instance_logs(instance.id, tail=log_tail_lines, order="desc")
            log_tail[instance.id] = {
                "generation": logs.get("generation"),
                "offset_end": logs.get("offset_end", 0),
                "lines": logs.get("lines") or [],
            }
        return {
            "conductor_id": settings.conductor_id,
            "hostname": _hostname(),
            "label": "",
            "version": "",
            "bindings": bindings,
            "metrics": metrics,
            "queue": queue,
            "log_tail": log_tail,
            "pipeline": pipeline_view,
        }

    async def post_podium_report(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        log_tail_lines: int = 200,
    ) -> dict[str, Any]:
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            response = await client.post(
                f"{podium_url}/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {runtime_token}"},
                json=self.build_podium_report(log_tail_lines=log_tail_lines),
            )
        if response.status_code == 401:
            return {"status": "skipped", "reason": "runtime_unauthorized"}
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict):
            self._apply_runtime_config_payload(payload.get("config"))
        return payload if isinstance(payload, dict) else {"status": "ok"}

    def _apply_runtime_config_payload(self, payload: Any) -> bool:
        if not isinstance(payload, dict) or not payload:
            return False
        try:
            envelope = RuntimeConfigEnvelope.from_dict(payload)
            envelope.validate()
        except Exception as exc:
            self._record_pipeline_sync_failure(
                "runtime_config_apply_failed",
                None,
                exc,
                action_required="fix_runtime_config",
                extra={
                    "runtime_group_id": payload.get("runtime_group_id"),
                    "version": payload.get("version"),
                },
            )
            return False
        return self.pipeline_store.apply_runtime_config(envelope)

    async def handle_podium_ws_command(
        self,
        command: dict[str, Any],
        *,
        post_log_chunk: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "dispatch.available":
            dispatch = command.get("dispatch") if isinstance(command.get("dispatch"), dict) else command
            queued_dispatch = dict(dispatch)
            if not (queued_dispatch.get("issue_id") or queued_dispatch.get("issue_identifier")):
                queued_dispatch["_lease_dispatch"] = True
            self._podium_dispatch_queue.put_nowait(queued_dispatch)
            return {
                "status": "queued",
                "issue_id": dispatch.get("issue_id") or None,
                "issue_identifier": dispatch.get("issue_identifier") or None,
                "agent_session_id": dispatch.get("agent_session_id") or None,
            }
        if kind == "human.answered":
            return self._handle_podium_human_answered(command)
        if kind == "log.fetch":
            instance_id = str(command.get("instance_id") or "")
            logs = self.query_instance_logs(
                instance_id,
                tail=_optional_int(command.get("tail"), 200),
                previous=bool(command.get("previous")),
                order=str(command.get("order") or "desc"),
            )
            payload = {
                "request_id": str(command.get("request_id") or ""),
                "instance_id": instance_id,
                "generation": logs.get("generation"),
                "offset_start": logs.get("offset_start", 0),
                "offset_end": logs.get("offset_end", 0),
                "order": logs.get("order") or "desc",
                "lines": logs.get("lines") or [],
            }
            if post_log_chunk is not None:
                await post_log_chunk(payload)
                return {"status": "posted", "request_id": payload["request_id"]}
            return {"status": "log_chunk_ready", "chunk": payload}
        return {"status": "ignored", "reason": "unsupported_command"}

    def _handle_podium_human_answered(self, command: dict[str, Any]) -> dict[str, Any]:
        child_issue_id = str(command.get("child_issue_id") or "").strip()
        human_response = str(command.get("human_response") or command.get("response") or "Human action completed.").strip()
        if not human_response:
            human_response = "Human action completed."
        wait_id = str(command.get("wait_id") or "").strip()
        wait = None
        for candidate in self.pipeline_store.list_human_waits():
            if wait_id and candidate.get("wait_id") == wait_id:
                wait = candidate
                break
            if child_issue_id and candidate.get("child_issue_id") == child_issue_id:
                wait = candidate
                break
        if wait is None:
            return {"status": "ignored", "reason": "human_wait_not_found"}
        resumed = self.pipeline_store.resume_human_wait(str(wait["wait_id"]), resolution=human_response)
        return {"status": "accepted", "wait_id": resumed["wait_id"], "node_id": resumed["node_id"]}

    async def coordinate_background_once(self) -> CoordinationResult:
        self._pipeline_reconcile_findings: list[dict[str, Any]] = []
        closeout = {"closed_out": 0, "failed": 0, "skipped": 0}
        dispatches_drained = await self._drain_podium_dispatch_queue()
        remediations: dict[str, Any] = {}
        pipeline_results_applied = 0
        pipeline_integrations_processed = 0
        pipeline_leases_reclaimed = 0
        pipeline_lease_heartbeats = 0
        pipeline_runtime_waits_observed = 0
        linear_pipeline_ingestions = 0
        linear_pipeline_projections = 0
        pipeline_attempts_started = 0
        pipeline_results_applied = self._collect_pipeline_result_files()
        pipeline_crash_failures = self._fail_exited_pipeline_attempts()
        pipeline_runtime_waits_observed = self._collect_pipeline_runtime_waits()
        pipeline_integrations_processed = self._process_pipeline_integrations()
        pipeline_human_actions_created = await self.reconcile_pipeline_human_actions_once()
        pipeline_human_actions_created += await self.reconcile_pipeline_runtime_wait_actions_once()
        pipeline_human_actions_completed = await self.reconcile_completed_pipeline_human_actions_once()
        pipeline_lease_heartbeats = self._heartbeat_running_pipeline_leases()
        pipeline_leases_reclaimed = self.pipeline_store.reclaim_expired_leases(datetime.now(timezone.utc))
        linear_pipeline_ingestions = await self.ingest_linear_pipeline_changes_once()
        linear_pipeline_projections = await self.reconcile_linear_pipeline_projections_once()
        pipeline_attempts_started = await self._start_due_pipeline_attempts()
        dispatch_acks = dispatches_drained
        project_labels_synced = 0
        crash_restarts = 0
        crash_loops = 0
        return CoordinationResult(
            repository_handoff=closeout,
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
            pipeline_attempts_started=pipeline_attempts_started,
            pipeline_results_applied=pipeline_results_applied,
            pipeline_integrations_processed=pipeline_integrations_processed,
            pipeline_leases_reclaimed=pipeline_leases_reclaimed,
            pipeline_timeouts=0,
            pipeline_crash_retries=0,
            pipeline_crash_failures=pipeline_crash_failures,
            pipeline_human_actions_created=pipeline_human_actions_created,
            pipeline_human_actions_completed=pipeline_human_actions_completed,
            pipeline_human_actions_missing_response=0,
            pipeline_human_actions_failed=0,
            pipeline_runtime_waits_observed=pipeline_runtime_waits_observed,
            linear_pipeline_ingestions=linear_pipeline_ingestions,
            linear_pipeline_projections=linear_pipeline_projections,
            dispatchable=0,
            blocked_waiting=0,
            reconcile_findings=getattr(self, "_pipeline_reconcile_findings", []),
            remediations=remediations,
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    def _fail_exited_pipeline_attempts(self) -> int:
        failed = 0
        for instance in self.store.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            drain_exited_attempts = getattr(self.runtime_manager, "drain_exited_attempts", None)
            if callable(drain_exited_attempts):
                for snapshot in drain_exited_attempts(refreshed):
                    failed += self.pipeline_coordinator.fail_exited_attempt_snapshot(refreshed, snapshot)
            failed += self.pipeline_coordinator.fail_running_attempts_for_exited_process(refreshed)
        return failed

    async def _start_due_pipeline_attempts(self) -> int:
        started = 0
        for instance in self.store.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            started += await self.pipeline_coordinator.start_due_attempts(refreshed)
        return started

    def _collect_pipeline_result_files(self) -> int:
        applied = 0
        for instance in self.store.list_instances():
            applied += self.pipeline_coordinator.collect_result_files(instance)
        return applied

    def _collect_pipeline_runtime_waits(self) -> int:
        observed = 0
        for instance in self.store.list_instances():
            observed += self.pipeline_coordinator.observe_runtime_waits_from_logs(instance)
        return observed

    def _heartbeat_running_pipeline_leases(self) -> int:
        heartbeats = 0
        for instance in self.store.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            if refreshed.process_status in {"running", "starting"}:
                heartbeats += self.pipeline_coordinator.heartbeat_active_leases()
        return heartbeats

    def _process_pipeline_integrations(self) -> int:
        processed = 0
        for instance in self.store.list_instances():
            repo_path = str(getattr(instance, "resolved_repo_path", "") or "").strip()
            if not repo_path:
                continue
            processed += self.pipeline_store.process_queued_integrations(Path(repo_path), instance=instance)
        return processed

    async def reconcile_linear_pipeline_projections_once(self) -> int:
        revision = self.pipeline_store.current_graph_revision_record()
        if revision is None:
            return 0
        root_issue_id = revision.root_node_id
        try:
            root_node = self.pipeline_store.get_node(revision.root_node_id)
            root_issue_id = str(root_node.issue_id or root_node.node_id)
        except KeyError:
            root_issue_id = revision.root_node_id
        if not root_issue_id:
            return 0
        projected = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                projector = PipelineLinearProjector(
                    store=self.pipeline_store,
                    tracker=tracker,
                    root_issue_id=root_issue_id,
                    delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                )
                projected += await projector.reconcile_once()
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "linear_pipeline_projection_failed",
                    instance,
                    exc,
                    action_required="retry_projection",
                )
                continue
        return projected

    async def ingest_linear_pipeline_changes_once(self) -> int:
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        ingested = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                projector = PipelineLinearProjector(
                    store=self.pipeline_store,
                    tracker=tracker,
                    root_issue_id=root_issue_id,
                    delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                )
                ingested += await projector.ingest_human_linear_changes_once()
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "linear_pipeline_ingestion_failed",
                    instance,
                    exc,
                    action_required="retry_ingestion",
                )
                continue
        return ingested

    async def reconcile_pipeline_human_actions_once(self) -> int:
        waits = [
            wait
            for wait in self.pipeline_store.list_human_waits()
            if wait.get("status") == "waiting" and not str(wait.get("child_issue_id") or "").strip()
        ]
        if not waits:
            return 0
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        created = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                delegate_id = _linear_agent_app_user_id(instance.linear_filters) or None
                for wait in waits:
                    issue = await tracker.create_child_issue_for(
                        parent_issue_id=root_issue_id,
                        title=f"[Human Action] {wait.get('reason') or 'Pipeline input required'}",
                        description=self._pipeline_human_action_description(wait),
                        label_names=["performer:type/human-action"],
                        delegate_id=delegate_id,
                    )
                    issue_id = str(issue.get("id") or "").strip()
                    if not issue_id:
                        continue
                    self.pipeline_store.attach_human_wait_child_issue(str(wait["wait_id"]), child_issue_id=issue_id)
                    created += 1
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "pipeline_human_wait_projection_failed",
                    instance,
                    exc,
                    action_required="retry_human_wait_projection",
                )
                continue
        return created

    async def reconcile_pipeline_runtime_wait_actions_once(self) -> int:
        waits = [
            wait
            for wait in self.pipeline_store.list_runtime_waits(status="waiting")
            if not str(wait.get("child_issue_id") or "").strip()
        ]
        if not waits:
            return 0
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        created = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                delegate_id = _linear_agent_app_user_id(instance.linear_filters) or None
                for wait in waits:
                    wait_kind = str(wait.get("wait_kind") or "runtime_wait").strip() or "runtime_wait"
                    issue = await tracker.create_child_issue_for(
                        parent_issue_id=root_issue_id,
                        title=f"[Human Action] Runtime wait: {wait_kind}",
                        description=self._pipeline_runtime_wait_action_description(wait),
                        label_names=[HUMAN_ACTION_LABEL],
                        delegate_id=delegate_id,
                    )
                    issue_id = str(issue.get("id") or "").strip()
                    if not issue_id:
                        continue
                    self.pipeline_store.attach_runtime_wait_child_issue(str(wait["wait_id"]), child_issue_id=issue_id)
                    created += 1
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "pipeline_runtime_wait_projection_failed",
                    instance,
                    exc,
                    action_required="retry_runtime_wait_projection",
                )
                continue
        return created

    async def reconcile_completed_pipeline_human_actions_once(self) -> int:
        waits = [
            wait
            for wait in self.pipeline_store.list_human_waits()
            if wait.get("status") == "waiting" and str(wait.get("child_issue_id") or "").strip()
        ]
        if not waits:
            return 0
        root_issue_id = self._pipeline_root_issue_id()
        if not root_issue_id:
            return 0
        waits_by_child = {str(wait.get("child_issue_id") or ""): wait for wait in waits}
        completed = 0
        for instance in self.store.list_instances():
            try:
                tracker = self.repository_handoff_tracker_factory(instance)
                children = await tracker.fetch_child_issues(root_issue_id, label_name="performer:type/human-action")
                for child in children:
                    child_id = str(child.get("id") or "").strip()
                    wait = waits_by_child.get(child_id)
                    if wait is None or not _linear_issue_completed(child):
                        continue
                    self.pipeline_store.resume_human_wait(
                        str(wait["wait_id"]),
                        resolution=f"Linear human action {child_id} completed.",
                    )
                    completed += 1
                break
            except Exception as exc:
                self._record_pipeline_sync_failure(
                    "pipeline_human_wait_completion_reconcile_failed",
                    instance,
                    exc,
                    action_required="retry_human_wait_completion_reconcile",
                )
                continue
        return completed

    def _pipeline_root_issue_id(self) -> str:
        revision = self.pipeline_store.current_graph_revision_record()
        if revision is None:
            return ""
        try:
            root_node = self.pipeline_store.get_node(revision.root_node_id)
        except KeyError:
            return revision.root_node_id
        return str(root_node.issue_id or root_node.node_id)

    def _pipeline_human_action_description(self, wait: dict[str, Any]) -> str:
        details = wait.get("details") if isinstance(wait.get("details"), dict) else {}
        lines = [
            "Pipeline human action required.",
            "",
            "```yaml",
            "symphony_human_wait:",
            f"  wait_id: {wait.get('wait_id') or ''}",
            f"  node_id: {wait.get('node_id') or ''}",
            f"  reason: {wait.get('reason') or ''}",
            f"  integration_id: {details.get('integration_id') or ''}",
            f"  verify_attempt_id: {details.get('verify_attempt_id') or ''}",
            f"  status: {details.get('status') or ''}",
            "```",
        ]
        error = str(details.get("error") or "").strip()
        if error:
            lines.extend(["", "Sanitized error:", error])
        return "\n".join(lines)

    def _pipeline_runtime_wait_action_description(self, wait: dict[str, Any]) -> str:
        lines = [
            "Pipeline runtime wait requires operator attention.",
            "",
            "```yaml",
            "symphony_runtime_wait:",
            f"  wait_id: {wait.get('wait_id') or ''}",
            f"  node_id: {wait.get('node_id') or ''}",
            f"  mode: {wait.get('mode') or ''}",
            f"  attempt_id: {wait.get('attempt_id') or ''}",
            f"  lease_id: {wait.get('lease_id') or ''}",
            f"  wait_kind: {wait.get('wait_kind') or ''}",
            f"  status: {wait.get('status') or ''}",
            "```",
        ]
        message = str(wait.get("message") or "").strip()
        if message:
            lines.extend(["", "Sanitized message:", _safe_multiline_linear_value(message)])
        command = str(wait.get("command") or "").strip()
        if command:
            lines.extend(["", "Sanitized command:", _safe_multiline_linear_value(command)])
        log_path = str(wait.get("log_path") or "").strip()
        if log_path:
            lines.extend(["", f"Log path: `{_safe_linear_value(log_path)}`"])
        lines.extend(
            [
                "",
                "Human response:",
                "(Record the approval, answer, or operator action here.)",
                "",
                "When finished, move this child issue to Done.",
            ]
        )
        return "\n".join(lines)

    async def sync_project_labels_once(self) -> int:
        """Sync project labels for instances whose scope changed since last run.

        Best-effort: a Linear failure for one instance is swallowed so it retries
        next tick without blocking the rest of the background loop.
        """
        synced = 0
        for instance in self.store.list_instances():
            signature = "\0".join([instance.linear_project, *_desired_project_labels(instance)])
            if self._project_label_signatures.get(instance.id) == signature:
                continue
            try:
                result = await self.sync_instance_project_labels(instance)
            except Exception:
                continue
            if result.get("status") in {"synced", "unchanged"}:
                self._project_label_signatures[instance.id] = signature
            if result.get("status") == "synced":
                synced += 1
        return synced

    async def _run_repository_handoff_closeouts_if_due(self, now: datetime) -> dict[str, Any]:
        if not self.coordination_cadence.repository_handoff_due(now):
            return {"closed_out": 0, "failed": 0, "skipped": 1}
        self.coordination_cadence.mark_repository_handoff(now)
        return await self.coordinate_repository_handoff_closeouts()

    async def _sync_project_labels_if_due(self, now: datetime) -> int:
        if not self.coordination_cadence.project_labels_due(now):
            return 0
        self.coordination_cadence.mark_project_labels(now)
        return await self.sync_project_labels_once()

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

    def _record_pipeline_sync_failure(
        self,
        event: str,
        instance: Any | None,
        exc: Exception,
        *,
        action_required: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        reason = _sanitize_error(exc)
        finding: dict[str, Any] = {
            "event": event,
            "severity": "warning",
            "error_type": exc.__class__.__name__,
            "sanitized_reason": reason,
            "action_required": action_required,
            "retryable": True,
        }
        if instance is not None:
            finding["instance_id"] = getattr(instance, "id", "")
            finding["issue_project"] = getattr(instance, "linear_project", "")
        if extra:
            finding.update({key: value for key, value in extra.items() if value is not None})
        findings = getattr(self, "_pipeline_reconcile_findings", None)
        if findings is None:
            findings = []
            self._pipeline_reconcile_findings = findings
        findings.append(finding)
        if instance is not None:
            _append_instance_log(
                instance,
                "event="
                f"{event} severity=warning instance_id={getattr(instance, 'id', '')} "
                f"error_type={exc.__class__.__name__} sanitized_reason={reason} "
                f"action_required={action_required} retryable=true",
            )

    async def ack_completed_podium_dispatches(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        return {"acked": 0, "failed": 0, "skipped": 0}


def _pipeline_report_metrics(pipeline: dict[str, Any]) -> dict[str, Any]:
    nodes = pipeline.get("nodes") if isinstance(pipeline.get("nodes"), list) else []
    attempts = pipeline.get("attempts") if isinstance(pipeline.get("attempts"), list) else []
    human_waits = pipeline.get("human_waits") if isinstance(pipeline.get("human_waits"), list) else []
    runtime_waits = pipeline.get("runtime_waits") if isinstance(pipeline.get("runtime_waits"), list) else []
    predicted = pipeline.get("predicted_call_order") if isinstance(pipeline.get("predicted_call_order"), list) else []

    failed_attempts = sum(
        1
        for attempt in attempts
        if isinstance(attempt, dict) and str(attempt.get("state") or "") in {"failed", "timed_out", "cancelled"}
    )
    failed_nodes = sum(
        1
        for node in nodes
        if isinstance(node, dict) and str(node.get("state") or "") in {"failed", "execute_failed", "verify_failed"}
    )
    blocked_predictions = sum(
        1
        for call in predicted
        if isinstance(call, dict) and isinstance(call.get("blocked_by"), list) and len(call["blocked_by"]) > 0
    )
    active_human_waits = sum(
        1 for wait in human_waits if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
    )
    active_runtime_waits = sum(
        1 for wait in runtime_waits if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
    )
    rework_attempts = sum(
        1
        for node in nodes
        if isinstance(node, dict) and int(node.get("rework_count") or 0) > 0
    )
    return {
        "tokens": 0,
        "runtime_seconds": 0.0,
        "retries": rework_attempts,
        "continuations": 0,
        "blocked": blocked_predictions,
        "pending_human": active_human_waits + active_runtime_waits,
        "failures": failed_attempts + failed_nodes,
    }


def _pipeline_report_queue(pipeline: dict[str, Any]) -> dict[str, int]:
    modes = pipeline.get("modes") if isinstance(pipeline.get("modes"), list) else []
    leases = pipeline.get("leases") if isinstance(pipeline.get("leases"), list) else []
    queued = 0
    for mode in modes:
        if isinstance(mode, dict):
            queued += int(mode.get("queued") or 0)
    return {"queued": queued, "leased": len(leases)}


def _linear_issue_completed(issue: dict[str, Any]) -> bool:
    state_type = str(issue.get("state_type") or "").strip().lower()
    if state_type == "completed":
        return True
    state_name = str(issue.get("state") or "").strip().lower()
    return state_name in {"done", "closed", "completed"}
