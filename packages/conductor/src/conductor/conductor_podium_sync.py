from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .conductor_reconcile import reconcile_orchestration_health
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403
from performer_api.phase import RunPhase


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
        codex_profile = _sanitize_codex_profile(event.get("codex_profile"))
        dispatch_id = str(event.get("dispatch_id") or "").strip()
        run = self.phase_reducer.dispatch_received(
            instance_id=instance.id,
            issue_id=issue_id or issue_identifier,
            issue_identifier=issue_identifier or None,
            workflow_profile=instance.workflow_profile,
            dispatch_id=dispatch_id or None,
            fencing_token=_optional_int(event.get("fencing_token"), None),
            blocked_by=_blocked_by_issue_ids(event.get("blocked_by")),
            parent_issue_id=_optional_dispatch_ref(event.get("parent_issue_id") or event.get("parent")),
            codex_profile=codex_profile,
        )
        if run.phase is RunPhase.QUEUED:
            refreshed = self.get_instance(instance.id) or instance
            if (
                refreshed.process_status not in {"running", "starting"}
                and _run_due(run)
                and self.scheduler.is_dispatchable(run)
            ):
                started = await self._start_orchestration_run(run, refreshed)
                self.store.update_instance(started)
        return {
            "status": "accepted",
            "issue_id": issue_id or None,
            "issue_identifier": issue_identifier or None,
            "instance_id": instance.id,
            "agent_session_id": event.get("agent_session_id") or None,
            "agent_app_user_id": agent_app_user_id,
        }

    def _codex_profile_for_run(self, run_id: str) -> dict[str, Any]:
        for event in reversed(self.store.list_orchestration_events(run_id)):
            profile = _sanitize_codex_profile(event.payload.get("codex_profile"))
            if profile:
                return profile
        return {}

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
                    "runtime_phase": result.get("runtime_phase"),
                },
            )
            return {"status": "leased", "dispatch": leased, "result": result}

    def build_podium_report(self, *, log_tail_lines: int = 200) -> dict[str, Any]:
        settings = self.store.get_settings()
        dashboard = self.dashboard()
        bindings: list[dict[str, Any]] = []
        metrics: dict[str, dict[str, Any]] = {}
        queue: dict[str, dict[str, Any]] = {}
        log_tail: dict[str, dict[str, Any]] = {}
        totals = dashboard.get("totals") if isinstance(dashboard.get("totals"), dict) else {}
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
                    "workflow_profile": instance.workflow_profile,
                    "process_status": instance.process_status,
                    "constraint_labels": _desired_project_labels(instance),
                    "repo_source": {"type": instance.repo_source_type, "value": instance.repo_source_value},
                }
            )
            performer = self._performer_runtime_from_phase_runs(instance)
            metrics[instance.id] = {
                "tokens": int(totals.get("tokens") or 0),
                "runtime_seconds": float(totals.get("runtime_seconds") or 0),
                "retries": _performer_retry_metric(performer),
                "continuations": int((performer.get("counts") or {}).get("continuing") or 0),
                "blocked": int((performer.get("counts") or {}).get("blocked") or 0),
                "pending_human": int((performer.get("counts") or {}).get("pending_human") or 0),
                "failures": _performer_failure_metric(performer),
            }
            queue[instance.id] = {
                "queued": 0,
                "leased": 0,
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
        return payload if isinstance(payload, dict) else {"status": "ok"}

    async def handle_podium_ws_command(
        self,
        command: dict[str, Any],
        *,
        post_log_chunk: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "dispatch.available":
            dispatch = command.get("dispatch") if isinstance(command.get("dispatch"), dict) else command
            self._podium_dispatch_queue.put_nowait(dict(dispatch))
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
        run_id = str(command.get("run_id") or "").strip()
        child_issue_id = str(command.get("child_issue_id") or "").strip()
        human_response = str(command.get("human_response") or command.get("response") or "Human action completed.").strip()
        if not human_response:
            human_response = "Human action completed."
        run = self.store.get_orchestration_run(run_id) if run_id else None
        if run is None:
            for candidate in self.store.list_orchestration_runs(phases={RunPhase.AWAITING_HUMAN}):
                action_child_id = str(candidate.human_action.get("child_issue_id") or "").strip()
                if child_issue_id and action_child_id == child_issue_id:
                    run = candidate
                    break
        if run is None:
            return {"status": "ignored", "reason": "human_run_not_found"}
        try:
            updated = self.phase_reducer.human_completed(run.run_id, human_response=human_response)
        except PhaseTransitionError:
            return {"status": "ignored", "reason": "human_run_not_waiting", "run_id": run.run_id}
        return {"status": "accepted", "run_id": updated.run_id, "issue_id": updated.issue_id}

    async def coordinate_background_once(self) -> CoordinationResult:
        managed_mode = self._managed_mode_enabled()
        if managed_mode:
            self._require_managed_proxy_token_for_background_linear_projection()
        now = datetime.now(timezone.utc)
        closeout = (
            {"closed_out": 0, "failed": 0, "skipped": 0}
            if managed_mode
            else await self._run_repository_handoff_closeouts_if_due(now)
        )
        ws_dispatches_received = await self._drain_podium_dispatch_queue()
        direct_dispatches_received = 0 if managed_mode else await self._poll_direct_dispatches()
        phase_runs_started = ws_dispatches_received + await self._start_due_orchestration_runs()
        phase_results_applied = await self._apply_phase_result_files()
        phase_timeouts = await self._record_phase_timeouts()
        phase_crash_retries, phase_crash_failures = await self._record_phase_crashes()
        reconcile_findings = reconcile_orchestration_health(store=self.store)
        scheduler_readiness = self.scheduler.readiness_counts()
        remediations = self.orchestration_remediator.remediate(reconcile_findings)
        phase_failure_human_actions_created = await self._create_phase_failure_human_actions()
        phase_human_actions = await self._coordinate_phase_human_actions()
        if phase_human_actions["completed"]:
            phase_runs_started += await self._start_due_orchestration_runs()
        dispatch_acks = await self.ack_completed_podium_dispatches()
        linear_phase_projections = await self.reconcile_linear_phase_projections_once()
        project_labels_synced = 0 if managed_mode else await self._sync_project_labels_if_due(now)
        crash_restarts = 0
        crash_loops = 0
        for instance in self.store.list_instances():
            current = self.get_instance(instance.id)
            if current is None:
                continue
            crash_recovery = await self._restart_crashed_performer(current)
            if crash_recovery is not None:
                self.store.update_instance(crash_recovery)
                if crash_recovery.process_status == "crash_loop":
                    crash_loops += 1
                else:
                    crash_restarts += 1
                continue
        return CoordinationResult(
            repository_handoff=closeout,
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
            direct_dispatches_received=direct_dispatches_received,
            phase_runs_started=phase_runs_started,
            phase_results_applied=phase_results_applied,
            phase_timeouts=phase_timeouts,
            phase_crash_retries=phase_crash_retries,
            phase_crash_failures=phase_crash_failures,
            phase_failure_human_actions_created=phase_failure_human_actions_created,
            phase_human_actions_completed=phase_human_actions["completed"],
            phase_human_actions_missing_response=phase_human_actions["missing_response"],
            phase_human_actions_failed=phase_human_actions["failed"],
            linear_phase_projections=linear_phase_projections,
            dispatchable=scheduler_readiness["dispatchable"],
            blocked_waiting=scheduler_readiness["blocked_waiting"],
            reconcile_findings=[finding.to_dict() for finding in reconcile_findings],
            remediations=remediations,
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    async def reconcile_linear_phase_projections_once(self, *, now: str | None = None) -> int:
        return await self.linear_projector.reconcile_once(now=now)

    def _require_managed_proxy_token_for_background_linear_projection(self) -> None:
        if self.store.get_settings().podium_proxy_token.strip():
            return
        if not self.store.list_orchestration_runs():
            return
        raise ConductorServiceError(
            "managed_podium_proxy_token_required",
            "Managed mode requires a Podium Linear proxy token before projecting orchestration phase state.",
        )

    async def _create_phase_failure_human_actions(self) -> int:
        created = 0
        for run in self.store.list_orchestration_runs(phases={RunPhase.FAILED}):
            if run.human_action.get("child_issue_id"):
                continue
            failure_detail = self._phase_failure_detail(run)
            if not _phase_failure_needs_human_action(run, failure_detail):
                continue
            instance = self.store.get_instance(run.instance_id)
            if instance is None:
                continue
            tracker = self.repository_handoff_tracker_factory(instance)
            create_child = getattr(tracker, "create_child_issue_for", None)
            if not callable(create_child):
                continue
            issue_ref = run.issue_identifier or run.issue_id
            description = _phase_failure_human_action_description(run, failure_detail)
            try:
                child = await create_child(
                    parent_issue_id=run.issue_id,
                    title=f"[Human Action] {issue_ref}: Runtime error needs review",
                    description=description,
                    label_names=[HUMAN_ACTION_LABEL],
                    delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
                )
            except Exception as exc:
                self.store.apply_event(
                    run.run_id,
                    {
                        "event_type": "human.failure_child_create_failed",
                        "to_phase": run.phase,
                        "reason": "phase_failure_human_action",
                        "payload": {"error": _safe_linear_value(exc)},
                    },
                    expected_current_phases={run.phase},
                )
                continue
            human_action = {
                "child_issue_id": child.get("id"),
                "child_identifier": child.get("identifier"),
                "child_url": child.get("url"),
                "kind": "runtime_error",
                "source": "phase_failure",
            }
            self.store.apply_event(
                run.run_id,
                {
                    "event_type": "human.failure_child_created",
                    "to_phase": run.phase,
                    "reason": "phase_failure_human_action",
                    "payload": {"human_action": human_action},
                },
                expected_current_phases={run.phase},
            )
            created += 1
        return created

    def _phase_failure_detail(self, run) -> dict[str, Any]:
        detail: dict[str, Any] = {
            "reason": run.last_reason,
            "error": run.last_error,
            "http_status": None,
        }
        for event in reversed(self.store.list_orchestration_events(run.run_id)):
            payload = event.payload if isinstance(event.payload, dict) else {}
            if payload.get("detail") and not detail.get("error"):
                detail["error"] = payload.get("detail")
            elif payload.get("detail") and _phase_failure_error_is_summary(str(detail.get("error") or "")):
                detail["error"] = payload.get("detail")
            if payload.get("http_status") is not None:
                detail["http_status"] = payload.get("http_status")
            if payload.get("reason") and not detail.get("reason"):
                detail["reason"] = payload.get("reason")
            if detail.get("error") and detail.get("http_status") is not None:
                break
        return detail

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

    async def _poll_direct_dispatches(self) -> int:
        return await self.direct_ingress.poll()

    async def _drain_podium_dispatch_queue(self) -> int:
        received = 0
        while True:
            try:
                event = self._podium_dispatch_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            try:
                result = await self.dispatch_podium_event(event)
            except Exception:
                result = {"status": "failed"}
            if result.get("status") == "accepted":
                received += 1
        return received

    async def ack_completed_podium_dispatches(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        await self._apply_phase_result_files()
        pending_runs = [
            run
            for run in self.store.list_orchestration_runs(ack_status="pending")
            if run.dispatch_id and run.phase in {RunPhase.DONE, RunPhase.FAILED}
        ]
        if not pending_runs:
            return {"acked": 0, "failed": 0, "skipped": 0}
        settings = self.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"acked": 0, "failed": 0, "skipped": len(pending_runs)}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            async def post_ack(run: Any) -> tuple[Any, httpx.Response | Exception]:
                status = "completed" if run.phase is RunPhase.DONE else "failed"
                reason = run.last_reason or ("completed_by_runtime" if status == "completed" else "failed_by_runtime")
                payload = {
                    "dispatch_id": run.dispatch_id,
                    "status": status,
                    "reason": reason,
                    "runtime_phase": run.phase.value,
                }
                if run.fencing_token is not None:
                    payload["fencing_token"] = run.fencing_token
                try:
                    response = await client.post(
                        f"{podium_url}/api/v1/runtime/dispatches/ack",
                        headers={"Authorization": f"Bearer {runtime_token}"},
                        json=payload,
                    )
                except Exception as exc:
                    return run, exc
                return run, response

            results = await asyncio.gather(*(post_ack(run) for run in pending_runs))
        acked = 0
        failed = 0
        skipped = 0
        for run, response in results:
            if isinstance(response, Exception):
                failed += 1
                continue
            if response.status_code in {404, 409}:
                self.phase_reducer.acked(run.run_id)
                acked += 1
                continue
            if response.status_code >= 400:
                failed += 1
                continue
            self.phase_reducer.acked(run.run_id)
            acked += 1
        return {"acked": acked, "failed": failed, "skipped": skipped}

    async def _start_due_orchestration_runs(self) -> int:
        return await self.scheduler.start_due_runs()

    async def _start_orchestration_run(self, run, instance: InstanceRecord) -> InstanceRecord:
        return await self.scheduler.start_run(run, instance)

