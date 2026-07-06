from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
import shutil
import subprocess
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import httpx

from .conductor_models import (
    ConductorSettings,
    InstanceCreateRequest,
    InstancePatchRequest,
    InstanceRecord,
    WorkflowValidationResult,
)
from .conductor_runtime import ConductorRuntimeManager
from .conductor_runtime import LogQuery
from .conductor_scheduler import OrchestrationScheduler, phase_file_paths
from .conductor_store import ConductorStore
from .conductor_ingress import DirectIngress
from .conductor_linear_direct import ProjectLabelLinearProxy, RepositoryHandoffLinearProxy
from .conductor_phase import PhaseReducer, PhaseTransitionError
from .conductor_linear_projector import LinearProjector
from .conductor_performer_supervisor import PerformerSupervisor
from .conductor_phase_human_actions import (
    PhaseHumanActionCoordinator,
    comment_missing_phase_human_response,
    find_phase_human_child,
    human_response_from_child,
    linear_issue_is_done,
    phase_human_action_requires_response,
    write_phase_human_response_to_parent,
)
from .conductor_reconcile import reconcile_orchestration_health
from .conductor_remediation import OrchestrationRemediator
from .conductor_repository_handoff import (
    REPOSITORY_HANDOFF_MARKER_NAME,
    REPOSITORY_INTEGRATION_LABEL,
    RepositoryHandoffCoordinator,
    comment_repository_handoff,
    find_repository_integration_child,
    repository_handoff_closeout_event,
    repository_handoff_comment,
    repository_handoff_marker,
    repository_integration_description,
)
from .conductor_workflow import (
    ConductorValidationError,
    generate_workflow_content,
    validate_instance_workflow,
    workflow_profiles,
)
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer_api.ops_projection import build_issue_detail, build_issue_list, build_run_detail, build_trace_stream
from performer_api.ops_retention import RetentionPolicy
from performer_api.ops_store import OpsStore
from performer_api.phase import PhaseAdvanceResult, RunPhase
from performer_api.persistence import PersistenceStore, PersistedSession, PersistedState
from performer_api.models import normalize_state_key, utc_now
from performer_api.workflow import load_workflow


WORKSPACE_INIT_EXCLUDES = {
    ".conductor",
    "conductor-data",
    ".venv",
    "workspaces",
    ".codex-runtime",
    ".test-real-flow",
    ".tmp-real-linear-flow",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "target",
}
HUMAN_ACTION_LABEL = "performer:type/human-action"
HUMAN_RESPONSE_MARKER_NAME = "SYMPHONY HUMAN RESPONSE"
PROJECT_LABEL_PREFIX = "symphony:"


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


class CoordinationResult(dict[str, Any]):
    def __init__(
        self,
        *,
        repository_handoff: dict[str, Any],
        dispatch_acks: dict[str, Any],
        project_labels_synced: int,
        direct_dispatches_received: int,
        phase_runs_started: int,
        phase_results_applied: int,
        phase_timeouts: int,
        phase_crash_retries: int,
        phase_crash_failures: int,
        phase_failure_human_actions_created: int,
        phase_human_actions_completed: int,
        phase_human_actions_missing_response: int,
        phase_human_actions_failed: int,
        linear_phase_projections: int,
        dispatchable: int = 0,
        blocked_waiting: int = 0,
        reconcile_findings: list[dict[str, Any]] | None = None,
        remediations: dict[str, Any] | None = None,
        crash_restarts: int = 0,
        crash_loops: int = 0,
    ):
        super().__init__(
            repository_handoff=repository_handoff,
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
            direct_dispatches_received=direct_dispatches_received,
            phase_runs_started=phase_runs_started,
            phase_results_applied=phase_results_applied,
            phase_timeouts=phase_timeouts,
            phase_crash_retries=phase_crash_retries,
            phase_crash_failures=phase_crash_failures,
            phase_failure_human_actions_created=phase_failure_human_actions_created,
            phase_human_actions_completed=phase_human_actions_completed,
            phase_human_actions_missing_response=phase_human_actions_missing_response,
            phase_human_actions_failed=phase_human_actions_failed,
            linear_phase_projections=linear_phase_projections,
            dispatchable=dispatchable,
            blocked_waiting=blocked_waiting,
            reconcile_findings=list(reconcile_findings or []),
            remediations=dict(remediations or {}),
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    def to_dict(self) -> dict[str, Any]:
        return dict(self)

    def __getattr__(self, key: str) -> Any:
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc


@dataclass
class CoordinationCadence:
    repository_handoff_seconds: float = 30
    project_labels_seconds: float = 300
    last_repository_handoff_at: datetime | None = None
    last_project_labels_at: datetime | None = None

    def repository_handoff_due(self, now: datetime) -> bool:
        return self._due(self.last_repository_handoff_at, self.repository_handoff_seconds, now)

    def project_labels_due(self, now: datetime) -> bool:
        return self._due(self.last_project_labels_at, self.project_labels_seconds, now)

    def mark_repository_handoff(self, now: datetime) -> None:
        self.last_repository_handoff_at = now

    def mark_project_labels(self, now: datetime) -> None:
        self.last_project_labels_at = now

    @staticmethod
    def _due(last_at: datetime | None, interval_seconds: float, now: datetime) -> bool:
        if last_at is None:
            return True
        return (now - last_at).total_seconds() >= interval_seconds


class ConductorService:
    def __init__(
        self,
        *,
        store: ConductorStore,
        data_root: Path,
        runtime_manager: ConductorRuntimeManager | None = None,
    ):
        self.store = store
        self.data_root = data_root
        self.runtime_manager = runtime_manager or ConductorRuntimeManager()
        self._startup_locks: dict[str, asyncio.Lock] = {}
        self.phase_reducer = PhaseReducer(store)
        self.repository_handoff_tracker_factory = self._repository_handoff_tracker
        self.project_label_proxy_factory = self._project_label_proxy
        self.linear_projector = LinearProjector(
            store=self.store,
            get_instance=self.store.get_instance,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.direct_ingress = DirectIngress(
            store=self.store,
            phase_reducer=self.phase_reducer,
            list_instances=self.store.list_instances,
            get_instance=self.get_instance,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.scheduler = OrchestrationScheduler(
            store=self.store,
            phase_reducer=self.phase_reducer,
            runtime_manager=self.runtime_manager,
            runtime_env=self._runtime_env,
            get_instance=self.get_instance,
            start_lock_for_instance=self._startup_lock_for_instance,
        )
        self.performer_supervisor = PerformerSupervisor(
            store=self.store,
            phase_reducer=self.phase_reducer,
            comment_result_diagnostic=self._comment_phase_result_diagnostic,
        )
        self.phase_human_actions = PhaseHumanActionCoordinator(
            store=self.store,
            phase_reducer=self.phase_reducer,
            managed_mode_enabled=self._managed_mode_enabled,
            tracker_factory=lambda instance: self.repository_handoff_tracker_factory(instance),
        )
        self.orchestration_remediator = OrchestrationRemediator(self.store)
        self.coordination_cadence = CoordinationCadence()
        self._podium_connection: dict[str, Any] = {
            "poll": {"status": "idle", "last_error": None, "updated_at": None},
            "ws": {"status": "idle", "last_error": None, "updated_at": None},
        }
        # instance_id -> last-synced desired-label signature, so the background
        # loop only calls Linear when an instance's scope actually changes.
        self._project_label_signatures: dict[str, str] = {}
        self.data_root.mkdir(parents=True, exist_ok=True)
        self._normalize_stale_runtime_state()

    def list_instances(self) -> list[InstanceRecord]:
        return self.store.list_instances()

    def settings(self) -> ConductorSettings:
        return self.store.get_settings()

    def update_settings(self, settings: ConductorSettings) -> ConductorSettings:
        self.store.save_settings(settings)
        return settings

    def update_settings_json(self, payload: dict[str, Any]) -> ConductorSettings:
        merged = self.store.get_settings().to_dict()
        merged.update(payload)
        return self.update_settings(ConductorSettings.from_dict(merged))

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
        instance = self._apply_codex_profile_from_dispatch(instance, event.get("codex_profile"))
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

    def _apply_codex_profile_from_dispatch(self, instance: InstanceRecord, profile: Any) -> InstanceRecord:
        normalized = _sanitize_codex_profile(profile)
        if not normalized:
            return instance
        workflow_inputs = dict(instance.workflow_inputs)
        if workflow_inputs.get("codex_profile") == normalized:
            return instance
        workflow_inputs["codex_profile"] = normalized
        updated = instance.with_updates(workflow_inputs=workflow_inputs)
        updated = updated.with_updates(workflow_content=self._generate_workflow(updated))
        self.store.update_instance(updated)
        Path(updated.workflow_path).write_text(updated.workflow_content, encoding="utf-8")
        return updated

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
            return await self.dispatch_podium_event(dispatch)
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
        direct_dispatches_received = 0 if managed_mode else await self._poll_direct_dispatches()
        phase_runs_started = await self._start_due_orchestration_runs()
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
            if isinstance(response, Exception) or response.status_code >= 400:
                failed += 1
                continue
            self.phase_reducer.acked(run.run_id)
            acked += 1
        return {"acked": acked, "failed": failed, "skipped": skipped}

    async def _start_due_orchestration_runs(self) -> int:
        return await self.scheduler.start_due_runs()

    async def _start_orchestration_run(self, run, instance: InstanceRecord) -> InstanceRecord:
        return await self.scheduler.start_run(run, instance)

    def _startup_lock_for_instance(self, instance_id: str) -> asyncio.Lock:
        return self._startup_locks.setdefault(instance_id, asyncio.Lock())

    async def _start_direct_phase_issue(
        self,
        instance: InstanceRecord,
        *,
        issue_id: str,
        issue_identifier: str | None = None,
        attempt: int | None = None,
    ) -> InstanceRecord:
        run = self.phase_reducer.dispatch_received(
            instance_id=instance.id,
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            workflow_profile=instance.workflow_profile,
            dispatch_id=None,
            blocked_by=[],
            parent_issue_id=None,
        )
        if attempt is not None and attempt > run.attempt:
            run = self.store.apply_event(
                run.run_id,
                {
                    "event_type": "run.attempt_adjusted",
                    "to_phase": run.phase,
                    "payload": {"attempt": attempt},
                },
            )
        return await self._start_orchestration_run(run, instance)

    async def _apply_phase_result_files(self) -> int:
        return await self.performer_supervisor.apply_result_files()

    async def _record_phase_crashes(self) -> tuple[int, int]:
        retries = 0
        failures = 0
        runs = self.store.list_orchestration_runs(phases={RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING})
        for run in runs:
            instance = self.store.get_instance(run.instance_id)
            if instance is None:
                continue
            refreshed = self.get_instance(instance.id) or instance
            if refreshed.process_status != "exited" or refreshed.last_exit_code in {0, None}:
                continue
            if run.result_path and Path(run.result_path).exists():
                continue
            try:
                updated = self.phase_reducer.performer_crashed(run.run_id, exit_code=refreshed.last_exit_code)
            except PhaseTransitionError:
                continue
            await self._comment_phase_crash_diagnostic(updated, exit_code=refreshed.last_exit_code)
            if updated.phase is RunPhase.FAILED:
                failures += 1
                self.store.update_instance(
                    refreshed.with_updates(
                        process_status="crash_loop",
                        pid=None,
                        last_error=updated.last_error,
                        restart_count=updated.crash_count,
                    )
                )
            else:
                retries += 1
        return retries, failures

    async def _record_phase_timeouts(self) -> int:
        timed_out = 0
        runs = self.store.list_orchestration_runs(phases={RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING})
        now = datetime.now(timezone.utc)
        for run in runs:
            if run.process_pid is None:
                continue
            instance = self.store.get_instance(run.instance_id)
            if instance is None:
                continue
            started_at = self._phase_started_at(run.run_id)
            if started_at is None:
                continue
            timeout_seconds = self._phase_timeout_seconds(instance)
            if timeout_seconds is None:
                continue
            if (now - started_at).total_seconds() <= timeout_seconds:
                continue
            refreshed = self.get_instance(instance.id) or instance
            if refreshed.pid != run.process_pid:
                continue
            await self.runtime_manager.stop(refreshed.with_updates(process_status="running", pid=run.process_pid))
            try:
                result = PhaseAdvanceResult(
                    run_id=run.run_id,
                    issue_id=run.issue_id,
                    next_phase=RunPhase.QUEUED,
                    status="retry",
                    reason="turn_timeout",
                    retry_delay_seconds=5,
                )
                self.phase_reducer.performer_result(result)
            except PhaseTransitionError:
                continue
            await self._comment_phase_timeout_diagnostic(run.run_id)
            timed_out += 1
        return timed_out

    def _phase_started_at(self, run_id: str) -> datetime | None:
        for event in reversed(self.store.list_orchestration_events(run_id)):
            if event.event_type != "performer.started":
                continue
            return _parse_iso(event.created_at)
        return None

    def _phase_timeout_seconds(self, instance: InstanceRecord) -> float | None:
        try:
            raw = load_workflow(Path(instance.workflow_path)).config
            codex = raw.get("codex") if isinstance(raw.get("codex"), dict) else {}
        except Exception:
            return 3_665
        turn_timeout_ms = _config_int(codex.get("turn_timeout_ms"), 3_600_000)
        hard_turn_timeout_ms = _config_int(codex.get("hard_turn_timeout_ms"), turn_timeout_ms)
        read_timeout_ms = _config_int(codex.get("read_timeout_ms"), 5_000)
        hard_turn_timeout_ms = max(0, hard_turn_timeout_ms)
        read_timeout_ms = max(0, read_timeout_ms)
        if hard_turn_timeout_ms <= 0 and read_timeout_ms <= 0:
            return None
        return (hard_turn_timeout_ms + read_timeout_ms + 5_000) / 1000

    async def _comment_phase_result_diagnostic(self, run_id: str, result: PhaseAdvanceResult) -> None:
        updated = self.store.get_orchestration_run(run_id)
        if updated is None:
            return
        reason = result.reason or updated.last_reason
        if result.status not in {"retry", "init_failed", "failed", "upstream_overloaded"}:
            return
        title = f"Performer phase reported {result.status}"
        await self._comment_phase_diagnostic(
            updated,
            kind="result",
            dedupe_key=(
                f"result:{updated.attempt}:{updated.retry_count}:{updated.init_failure_count}:"
                f"{updated.overload_count}:{result.status}:{reason or ''}"
            ),
            title=title,
            reason=reason,
            extra={
                "next_phase": result.next_phase.value,
                "retry_delay_seconds": result.retry_delay_seconds,
                "detail": result.detail,
                "http_status": result.http_status,
            },
        )

    async def _comment_phase_timeout_diagnostic(self, run_id: str) -> None:
        updated = self.store.get_orchestration_run(run_id)
        if updated is None:
            return
        await self._comment_phase_diagnostic(
            updated,
            kind="timeout",
            dedupe_key=f"timeout:{updated.attempt}:{updated.retry_count}:turn_timeout",
            title="Performer phase timed out",
            reason="turn_timeout",
            extra={"timeout_accounting": "retry_count incremented; crash_count and init_failure_count unchanged"},
        )

    async def _comment_phase_crash_diagnostic(self, run, *, exit_code: int | None) -> None:
        await self._comment_phase_diagnostic(
            run,
            kind="crash",
            dedupe_key=f"crash:{run.attempt}:{run.crash_count}:{exit_code}",
            title="Performer phase process exited",
            reason=run.last_reason or "performer_crashed",
            extra={"exit_code": exit_code},
        )

    async def _comment_phase_diagnostic(
        self,
        run,
        *,
        kind: str,
        dedupe_key: str,
        title: str,
        reason: str | None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if self._phase_diagnostic_event_recorded(run.run_id, dedupe_key):
            return
        instance = self.store.get_instance(run.instance_id)
        if instance is None:
            return
        tracker = self.repository_handoff_tracker_factory(instance)
        comment_issue = getattr(tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _phase_diagnostic_comment(title, run, reason=reason, instance=instance, extra=extra or {})
        try:
            result = await comment_issue(run.issue_id, body)
        except Exception as exc:
            self.store.apply_event(
                run.run_id,
                {
                    "event_type": "linear.diagnostic_comment_failed",
                    "to_phase": run.phase,
                    "reason": kind,
                    "payload": {"dedupe_key": dedupe_key, "error": _safe_linear_value(exc)},
                },
            )
            return
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "linear.diagnostic_commented",
                "to_phase": run.phase,
                "reason": kind,
                "payload": {"dedupe_key": dedupe_key, "comment_result": result},
            },
        )

    def _phase_diagnostic_event_recorded(self, run_id: str, dedupe_key: str) -> bool:
        for event in self.store.list_orchestration_events(run_id):
            if event.event_type != "linear.diagnostic_commented":
                continue
            if event.payload.get("dedupe_key") == dedupe_key:
                return True
        return False

    async def _coordinate_phase_human_actions(self) -> dict[str, int]:
        return await self.phase_human_actions.coordinate()

    async def _comment_missing_phase_human_response(self, tracker: Any, child_issue_id: str) -> None:
        await comment_missing_phase_human_response(tracker, child_issue_id)

    async def _write_phase_human_response_to_parent(
        self,
        tracker: Any,
        run,
        *,
        child: dict[str, Any],
        human_response: str,
    ) -> None:
        await write_phase_human_response_to_parent(tracker, run, child=child, human_response=human_response)

    def _phase_human_event_recorded(self, run_id: str, event_type: str, *, child_issue_id: str) -> bool:
        for event in self.store.list_orchestration_events(run_id):
            if event.event_type != event_type:
                continue
            if not child_issue_id or str(event.payload.get("child_issue_id") or "") == child_issue_id:
                return True
        return False

    def _phase_file_paths(self, instance: InstanceRecord, run_id: str) -> dict[str, Path]:
        return phase_file_paths(instance, run_id)

    async def get_instance_coordinated(self, instance_id: str) -> InstanceRecord | None:
        instance = self.get_instance(instance_id)
        if instance is None:
            return None
        await self.coordinate_repository_handoff_closeouts(instance_id=instance_id)
        if not self._managed_mode_enabled():
            human_actions = await self._coordinate_phase_human_actions()
            if human_actions["completed"]:
                await self._start_due_orchestration_runs()
        return self.get_instance(instance_id)

    async def coordinate_repository_handoff_closeouts(self, *, instance_id: str | None = None) -> dict[str, Any]:
        return await RepositoryHandoffCoordinator(
            ops_rows=self._ops_stores,
            tracker_factory=self.repository_handoff_tracker_factory,
        ).coordinate(instance_id=instance_id)

    async def _closeout_repository_handoff(self, instance: InstanceRecord, event: TraceEvent) -> dict[str, Any]:
        report = dict(event.payload)
        issue_id = str(report.get("issue_id") or event.issue_id or "").strip()
        issue_identifier = str(report.get("issue_identifier") or issue_id).strip()
        if not issue_id:
            raise ConductorServiceError("repository_handoff_missing_issue_id", "Repository handoff report missing issue_id")
        return await RepositoryHandoffCoordinator(
            ops_rows=self._ops_stores,
            tracker_factory=self.repository_handoff_tracker_factory,
        ).closeout(instance, event)

    async def _find_repository_integration_child(self, tracker: Any, source_issue_id: str) -> dict[str, Any] | None:
        return await find_repository_integration_child(tracker, source_issue_id)

    async def _comment_repository_handoff(
        self,
        tracker: Any,
        issue_id: str,
        report: dict[str, Any],
        child: dict[str, Any],
        instance: InstanceRecord,
    ) -> dict[str, Any] | None:
        return await comment_repository_handoff(tracker, issue_id, report, child, instance)

    def _repository_handoff_tracker(
        self,
        instance: InstanceRecord,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/")
        endpoint = (
            f"{endpoint_base}/api/v1/linear/graphql"
            if endpoint_base
            else "https://api.linear.app/graphql"
        )
        api_key = settings.podium_proxy_token.strip()
        if not api_key and not self._managed_mode_enabled():
            api_key = os.environ.get("LINEAR_API_KEY", "").strip()
        return RepositoryHandoffLinearProxy(
            endpoint=endpoint,
            api_key=api_key,
            project_slug=instance.linear_project,
            active_states=list(instance.linear_filters.get("active_states") or ["Todo", "In Progress"]),
            required_delegate_id=_linear_agent_app_user_id(instance.linear_filters) or None,
            transport=transport,
        )

    def _project_label_proxy(self, instance: InstanceRecord) -> Any:
        settings = self.store.get_settings()
        endpoint_base = settings.podium_url.strip().rstrip("/") or "https://podium.example"
        return ProjectLabelLinearProxy(
            endpoint=f"{endpoint_base}/api/v1/linear/graphql",
            api_key=settings.podium_proxy_token.strip(),
        )

    async def sync_instance_project_labels(self, instance: InstanceRecord) -> dict[str, Any]:
        """Mirror an instance's routing scope onto its Linear project as labels.

        Best-effort and idempotent: only the `symphony:` label namespace is
        touched, user-owned project labels are preserved. Skipped when the proxy
        is unconfigured or the project can't be resolved by slug.
        """
        settings = self.store.get_settings()
        if not settings.podium_proxy_token.strip():
            return {"status": "skipped", "reason": "proxy_not_configured"}
        project_slug = str(instance.linear_project or "").strip()
        if not project_slug:
            return {"status": "skipped", "reason": "missing_project_slug"}
        proxy = self.project_label_proxy_factory(instance)
        project_id = await proxy.find_project_id(project_slug)
        if not project_id:
            return {"status": "skipped", "reason": "project_not_found", "project_slug": project_slug}
        existing = await proxy.fetch_project_labels(project_id)
        existing_names = [row["name"] for row in existing]
        desired = _merge_project_labels(existing_names, _desired_project_labels(instance))
        if set(desired) == set(existing_names):
            return {"status": "unchanged", "project_id": project_id, "labels": desired}
        label_ids = [await proxy.ensure_project_label_id(name) for name in desired]
        await proxy.set_project_labels(project_id, label_ids)
        return {"status": "synced", "project_id": project_id, "labels": desired}

    async def _restart_crashed_performer(self, instance: InstanceRecord) -> InstanceRecord | None:
        if self._managed_mode_enabled():
            return None
        if instance.process_status != "exited" or instance.last_exit_code in {0, None}:
            return None
        persisted = PersistenceStore(Path(instance.persistence_path)).load()
        if not _has_pending_performer_work(persisted):
            return None
        now = datetime.now(timezone.utc)
        next_at = _parse_iso(instance.restart_next_at)
        if next_at is not None and now < next_at:
            return None
        window_started = _parse_iso(instance.restart_window_started_at)
        if window_started is None or now - window_started > timedelta(minutes=10):
            window_started = now
            restart_count = 0
        else:
            restart_count = instance.restart_count
        restart_count += 1
        if restart_count > 3:
            return instance.with_updates(
                process_status="crash_loop",
                pid=None,
                restart_count=restart_count,
                restart_window_started_at=_iso(window_started),
                restart_next_at=None,
                last_error="performer crashed more than 3 times within 10 minutes",
            )
        delay_seconds = min(5 * (2 ** (restart_count - 1)), 60)
        pending = _first_pending_performer_issue(persisted)
        if pending is None:
            return None
        restarted = await self._start_direct_phase_issue(
            instance.with_updates(
                process_status="starting",
                restart_count=restart_count,
                restart_window_started_at=_iso(window_started),
                restart_next_at=_iso(now + timedelta(seconds=delay_seconds)),
                last_error=None,
            ),
            issue_id=pending["issue_id"],
            issue_identifier=pending.get("issue_identifier"),
            attempt=pending.get("attempt"),
        )
        return restarted.with_updates(
            restart_count=restart_count,
            restart_window_started_at=_iso(window_started),
            restart_next_at=_iso(now + timedelta(seconds=delay_seconds)),
            last_error=None,
        )

    def dashboard(self) -> dict[str, Any]:
        instances = self.store.list_instances()
        phase_runs = self.store.list_orchestration_runs()
        process_statuses: dict[str, int] = {}
        workflow_statuses: dict[str, int] = {}
        linear_views: dict[str, dict[str, Any]] = {}
        total_tokens = 0
        runtime_seconds = 0
        retry_count = 0
        continuation_count = 0
        blocked_count = 0
        pending_human_count = 0
        persisted_failures = 0
        for instance in instances:
            process_statuses[instance.process_status] = process_statuses.get(instance.process_status, 0) + 1
            workflow_statuses[instance.workflow_generation_status] = workflow_statuses.get(instance.workflow_generation_status, 0) + 1
            filters_key = json_stable(instance.linear_filters)
            linear_key = f"{instance.linear_project}\0{filters_key}"
            if linear_key not in linear_views:
                linear_views[linear_key] = {
                    "project": instance.linear_project,
                    "filters": instance.linear_filters,
                    "instances": 0,
                }
            linear_views[linear_key]["instances"] += 1
            persisted = PersistenceStore(Path(instance.persistence_path)).load()
            instance_phase_runs = [run for run in phase_runs if run.instance_id == instance.id]
            if instance_phase_runs:
                retry_count += sum(run.retry_count for run in instance_phase_runs)
                blocked_count += sum(1 for run in instance_phase_runs if run.phase is RunPhase.AWAITING_HUMAN)
                pending_human_count += sum(1 for run in instance_phase_runs if run.phase is RunPhase.AWAITING_HUMAN)
                persisted_failures += sum(1 for run in instance_phase_runs if run.phase is RunPhase.FAILED)
            else:
                retry_count += len(persisted.retry_attempts)
                continuation_count += len(persisted.continuations)
                blocked_count += len(persisted.blocked)
                pending_human_count += len(persisted.human_interventions)
                persisted_failures += sum(1 for retry in persisted.retry_attempts if retry.error)
            now = datetime.now(timezone.utc)
            for session in persisted.sessions:
                total_tokens += session.tokens.total_tokens
                runtime_seconds += max(int((now - session.started_at).total_seconds()), 0)
        return {
            "counts": {
                "instances": len(instances),
                "running": process_statuses.get("running", 0),
                "workflow_draft": workflow_statuses.get("draft", 0),
                "workflow_invalid": workflow_statuses.get("invalid", 0),
            },
            "process_statuses": process_statuses,
            "workflow_statuses": workflow_statuses,
            "linear_views": list(linear_views.values()),
            "totals": {
                "tokens": total_tokens,
                "runtime_seconds": runtime_seconds,
                "failures": sum(1 for instance in instances if instance.last_error) + persisted_failures,
                "retries": retry_count,
                "continuations": continuation_count,
                "blocked": blocked_count,
                "pending_human": pending_human_count,
            },
            "podium_connection": self._podium_connection,
        }

    def update_podium_connection(self, channel: str, *, status: str, error: str | None = None) -> None:
        sanitized = _sanitize_connection_error(error)
        self._podium_connection[channel] = {
            "status": status,
            "last_error": sanitized,
            "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
        }

    def list_issues(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for issue in build_issue_list(snapshot):
                row = issue.to_dict()
                row["instance_id"] = instance.id
                rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_issue(self, issue_id: str) -> dict[str, Any]:
        for instance, snapshot in self._ops_snapshots():
            if issue_id in snapshot.issues:
                detail = build_issue_detail(snapshot, issue_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")

    def list_runs(self) -> list[dict[str, Any]]:
        phase_runs = self.store.list_orchestration_runs()
        if phase_runs:
            rows = [self._phase_run_row(run) for run in phase_runs]
        else:
            rows = []
            for instance, snapshot in self._ops_snapshots():
                for run in snapshot.runs.values():
                    row = run.to_dict()
                    row["instance_id"] = instance.id
                    rows.append(row)
        return sorted(rows, key=lambda row: str(row.get("last_activity_at") or ""), reverse=True)

    def get_run(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_orchestration_run(run_id)
        if run is not None:
            return self._phase_run_detail(run)
        for instance, snapshot in self._ops_snapshots():
            if run_id in snapshot.runs:
                detail = build_run_detail(snapshot, run_id)
                detail["instance_id"] = instance.id
                return detail
        raise ConductorServiceError("run_not_found", f"Run not found: {run_id}")

    def list_trace_events(
        self, *, issue_id: str | None, run_id: str | None, limit: int = 200
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for instance, snapshot in self._ops_snapshots():
            for event in build_trace_stream(snapshot, issue_id=issue_id, run_id=run_id, limit=limit):
                row = event.to_dict()
                row["instance_id"] = instance.id
                events.append(row)
        return sorted(events, key=lambda row: str(row.get("timestamp") or ""))[-limit:]

    def retention_status(self) -> dict[str, Any]:
        pinned_issue_ids: set[str] = set()
        pinned_run_ids: set[str] = set()
        event_counts = {"summary": 0, "trace": 0, "raw": 0}
        for _instance, snapshot in self._ops_snapshots():
            pinned_issue_ids.update(snapshot.retention.pinned_issue_ids)
            pinned_run_ids.update(snapshot.retention.pinned_run_ids)
            for event in snapshot.events:
                if event.retention_tier in event_counts:
                    event_counts[event.retention_tier] += 1
        return {
            "pinned_issue_count": len(pinned_issue_ids),
            "pinned_run_count": len(pinned_run_ids),
            "pinned_issue_ids": sorted(pinned_issue_ids),
            "pinned_run_ids": sorted(pinned_run_ids),
            "event_counts": event_counts,
        }

    def pin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=True)
        return self.retention_status()

    def unpin_issue(self, issue_id: str) -> dict[str, Any]:
        self._update_issue_pin(issue_id, pinned=False)
        return self.retention_status()

    def collect_retention(self, policy: RetentionPolicy | None = None) -> dict[str, Any]:
        policy = policy or RetentionPolicy()
        for _instance, store, snapshot in self._ops_stores():
            store.save(policy.apply(snapshot))
        return self.retention_status()

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        instance = self.store.get_instance(instance_id)
        if instance is None:
            return None
        refresh = getattr(self.runtime_manager, "refresh", None)
        if not callable(refresh):
            return instance
        refreshed = refresh(instance)
        if refreshed != instance:
            self.store.update_instance(refreshed)
        return refreshed

    def create_instance(self, request: InstanceCreateRequest) -> InstanceRecord:
        instance, validation = self._build_instance_candidate(request, persist_workflow=True)
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)

        instance = instance.with_updates(workflow_generation_status="valid")
        self._materialize_instance(instance)
        self._initialize_workspace(instance)
        self.store.create_instance(instance)
        return instance

    def preview_instance(self, request: InstanceCreateRequest) -> tuple[InstanceRecord, WorkflowValidationResult]:
        return self._build_instance_candidate(request, persist_workflow=False)

    def _build_instance_candidate(
        self, request: InstanceCreateRequest, *, persist_workflow: bool
    ) -> tuple[InstanceRecord, WorkflowValidationResult]:
        resolved_repo_path = self._resolve_repo(request.repo_source_type, request.repo_source_value)
        instance_id = self._allocate_instance_id()
        instance_dir = request.instance_dir or str((self.data_root / "instances" / instance_id).resolve())
        workspace_root = request.workspace_root or str((Path(instance_dir) / "workspace" / "repo").resolve())
        persistence_path = request.persistence_path or str((Path(instance_dir) / "state" / "performer.json").resolve())
        log_path = request.log_path or str((Path(instance_dir) / "logs" / "performer.log").resolve())
        workflow_path = str((Path(instance_dir) / "WORKFLOW.md").resolve())
        http_port = request.http_port or self.store.allocate_port()

        instance = InstanceRecord.create(
            id=instance_id,
            name=request.name,
            repo_source_type=request.repo_source_type,
            repo_source_value=request.repo_source_value,
            resolved_repo_path=resolved_repo_path,
            instance_dir=instance_dir,
            workflow_path=workflow_path,
            workspace_root=workspace_root,
            persistence_path=persistence_path,
            log_path=log_path,
            http_port=http_port,
            linear_project=request.linear_project,
            linear_filters=request.linear_filters,
            workflow_profile=request.workflow_profile,
            workflow_inputs=request.workflow_inputs,
        )
        instance = instance.with_updates(workflow_content=self._generate_workflow(instance))
        validation = validate_instance_workflow(instance, self.store.list_instances(), persist=persist_workflow)
        if validation.ok:
            instance = instance.with_updates(workflow_generation_status="valid")
        else:
            instance = instance.with_updates(workflow_generation_status="invalid")
        return instance, validation

    def update_instance(self, instance_id: str, patch: InstancePatchRequest) -> InstanceRecord:
        current = self._require_instance(instance_id)
        updated = current.with_updates(
            name=patch.name if patch.name is not None else current.name,
            linear_project=patch.linear_project if patch.linear_project is not None else current.linear_project,
            linear_filters=patch.linear_filters if patch.linear_filters is not None else current.linear_filters,
            workflow_profile=patch.workflow_profile if patch.workflow_profile is not None else current.workflow_profile,
            workflow_inputs=patch.workflow_inputs if patch.workflow_inputs is not None else current.workflow_inputs,
        )
        workflow_content = patch.workflow_content
        if workflow_content is None and (
            patch.linear_project is not None or patch.linear_filters is not None or patch.workflow_profile is not None or patch.workflow_inputs is not None
        ):
            workflow_content = self._generate_workflow(updated)
        if workflow_content is not None:
            updated = updated.with_updates(workflow_content=workflow_content)
            validation = validate_instance_workflow(updated, self._other_instances(instance_id))
            if not validation.ok:
                raise ConductorServiceError(
                    validation.error_code or "invalid_workflow",
                    "Workflow validation failed",
                    diagnostics=validation.diagnostics,
                )
            updated = updated.with_updates(
                workflow_content=workflow_content,
                workflow_generation_status="valid",
            )
            Path(updated.workflow_path).write_text(updated.workflow_content, encoding="utf-8")
        self.store.update_instance(updated)
        return updated

    def delete_instance(self, instance_id: str) -> None:
        instance = self._require_instance(instance_id)
        if instance.process_status in {"running", "starting"}:
            raise ConductorServiceError("instance_running", "Stop the instance before deleting it")
        instance_root = Path(instance.instance_dir)
        self.store.delete_instance(instance_id)
        if instance_root.exists():
            shutil.rmtree(instance_root, ignore_errors=True)

    def validate_workflow(self, instance_id: str, workflow_content: str) -> WorkflowValidationResult:
        current = self._require_instance(instance_id)
        candidate = current.with_updates(workflow_content=workflow_content)
        return validate_instance_workflow(candidate, self._other_instances(instance_id))

    def generate_workflow(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        workflow_content = self._generate_workflow(current)
        return self.update_instance(instance_id, InstancePatchRequest(workflow_content=workflow_content))

    async def start_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        started = await self.runtime_manager.start(
            current.with_updates(process_status="starting"),
            env=self._runtime_env(),
        )
        self.store.update_instance(started)
        return started

    async def stop_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        stopped = await self.runtime_manager.stop(current)
        self.store.update_instance(stopped)
        return stopped

    async def restart_instance(self, instance_id: str) -> InstanceRecord:
        current = self._require_instance(instance_id)
        validation = validate_instance_workflow(current, self._other_instances(instance_id))
        if not validation.ok:
            raise ConductorServiceError(validation.error_code or "invalid_workflow", "Workflow validation failed", diagnostics=validation.diagnostics)
        restarted = await self.runtime_manager.restart(current, env=self._runtime_env())
        self.store.update_instance(restarted)
        return restarted

    async def approve_runtime_error(self, instance_id: str, *, issue_id: str | None = None) -> dict[str, Any]:
        _ = self._require_instance(instance_id), issue_id
        raise ConductorServiceError(
            "runtime_error_approval_removed",
            "Runtime approvals must be completed through the Linear [Human Action] child issue.",
        )

    def instance_runtime(self, instance_id: str) -> dict[str, object]:
        current = self._require_instance(instance_id)
        runtime = dict(self.runtime_manager.runtime_snapshot(current))
        performer = self._performer_runtime_from_phase_runs(current)
        runtime["workspace"] = {
            "root": current.workspace_root,
            "strategy": "instance_repo_workspace",
            "description": (
                "Conductor initializes an instance-level repository workspace once, then reuses the "
                "prepared repository workspace for Performer and Codex runs."
            ),
        }
        runtime["performer"] = performer
        runtime["metrics"] = _runtime_metrics(performer)
        return runtime

    def query_instance_logs(
        self,
        instance_id: str,
        *,
        tail: int | None = 200,
        limit_bytes: int = 1_048_576,
        previous: bool = False,
        order: str = "desc",
        timestamps: bool = False,
        prefix: bool = False,
    ) -> dict[str, Any]:
        current = self._require_instance(instance_id)
        result = self.runtime_manager.query_logs(
            current,
            LogQuery(
                tail=tail,
                limit_bytes=limit_bytes,
                previous=previous,
                order=order,
                timestamps=timestamps,
                prefix=prefix,
            ),
        )
        return {
            "instance_id": result.instance_id,
            "generation": result.generation,
            "path": result.path,
            "order": result.order,
            "lines": result.lines,
            "logs": result.text(),
            "offset_start": result.offset_start,
            "offset_end": result.offset_end,
            "warnings": result.warnings,
        }

    def instance_logs(self, instance_id: str) -> str:
        current = self._require_instance(instance_id)
        return self.runtime_manager.read_logs(current)

    def inspect_repo(self, repo_source_type: str, repo_source_value: str) -> dict[str, Any]:
        resolved = self._resolve_repo(repo_source_type, repo_source_value)
        repo_path = Path(resolved)
        files = sorted(path.name for path in repo_path.iterdir())[:20]
        return {
            "repo_source_type": repo_source_type,
            "repo_source_value": repo_source_value,
            "resolved_path": resolved,
            "exists": repo_path.exists(),
            "git": (repo_path / ".git").exists(),
            "files": files,
        }

    def clone_repo(self, repo_url: str, target_path: str) -> dict[str, Any]:
        target = Path(target_path)
        if target.exists() and any(target.iterdir()):
            return {"repo_url": repo_url, "target_path": str(target), "cloned": False}
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["git", "clone", "--", repo_url, str(target)], check=True)
        except subprocess.CalledProcessError as exc:
            raise ConductorServiceError("git_clone_failed", f"Git clone failed: {exc}") from exc
        return {"repo_url": repo_url, "target_path": str(target), "cloned": True}

    def available_workflow_profiles(self) -> list[dict[str, str]]:
        return workflow_profiles()

    def _resolve_repo(self, repo_source_type: str, repo_source_value: str) -> str:
        if repo_source_type == "git":
            if not repo_source_value.strip():
                raise ConductorServiceError("missing_git_url", "Git repository URL is required")
            return repo_source_value
        if repo_source_type != "local_path":
            raise ConductorServiceError("unsupported_repo_source", f"Unsupported repo source type: {repo_source_type}")
        candidate = Path(repo_source_value).expanduser().resolve()
        if not candidate.exists() or not candidate.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {candidate}")
        return str(candidate)

    def _materialize_instance(self, instance: InstanceRecord) -> None:
        instance_dir = Path(instance.instance_dir)
        (instance_dir / "logs").mkdir(parents=True, exist_ok=True)
        (instance_dir / "state").mkdir(parents=True, exist_ok=True)
        Path(instance.workspace_root).mkdir(parents=True, exist_ok=True)
        Path(instance.workflow_path).write_text(instance.workflow_content, encoding="utf-8")
        Path(instance.log_path).touch()

    def _initialize_workspace(self, instance: InstanceRecord) -> None:
        workspace = Path(instance.workspace_root)
        workspace.mkdir(parents=True, exist_ok=True)
        if any(workspace.iterdir()):
            return
        if instance.repo_source_type == "git":
            self.clone_repo(instance.resolved_repo_path, instance.workspace_root)
            return
        if instance.repo_source_type != "local_path":
            return
        source = Path(instance.resolved_repo_path)
        if not source.exists() or not source.is_dir():
            raise ConductorServiceError("missing_local_path", f"Local path does not exist: {source}")
        for item in source.iterdir():
            if item.name in WORKSPACE_INIT_EXCLUDES:
                continue
            try:
                if item.resolve() == self.data_root.resolve():
                    continue
            except OSError:
                pass
            target = workspace / item.name
            if item.is_dir():
                shutil.copytree(item, target, symlinks=True)
            else:
                shutil.copy2(item, target)

    def _generate_workflow(self, instance: InstanceRecord) -> str:
        try:
            settings = self.store.get_settings()
            podium_url = settings.podium_url.strip() or "https://podium.example"
            return generate_workflow_content(instance, podium_url=podium_url)
        except ConductorValidationError as exc:
            raise ConductorServiceError(exc.code, str(exc)) from exc

    def _other_instances(self, instance_id: str) -> list[InstanceRecord]:
        return [instance for instance in self.store.list_instances() if instance.id != instance_id]

    def _require_instance(self, instance_id: str) -> InstanceRecord:
        current = self.store.get_instance(instance_id)
        if current is None:
            raise ConductorServiceError("instance_not_found", f"Instance not found: {instance_id}")
        return current

    def _instance_for_podium_event(
        self,
        *,
        project_slug: str,
        agent_app_user_id: str,
        instance_id: str = "",
    ) -> InstanceRecord | None:
        candidates = self.store.list_instances()
        if instance_id:
            candidates = [instance for instance in candidates if instance.id == instance_id]
        if project_slug:
            candidates = [instance for instance in candidates if instance.linear_project == project_slug]
        filtered = []
        for instance in candidates:
            configured_agent = _linear_agent_app_user_id(instance.linear_filters)
            if configured_agent and configured_agent != agent_app_user_id:
                continue
            filtered.append(instance)
        candidates = filtered
        if not candidates:
            return None
        return candidates[0]

    def _allocate_instance_id(self) -> str:
        existing = {instance.id for instance in self.store.list_instances()}
        index = 1
        while True:
            candidate = f"inst-{index}"
            if candidate not in existing:
                return candidate
            index += 1

    def _runtime_env(self) -> dict[str, str]:
        settings = self.store.get_settings()
        env: dict[str, str] = {}
        proxy_token = settings.podium_proxy_token.strip()
        if proxy_token:
            env["PODIUM_PROXY_TOKEN"] = proxy_token
        runtime_token = settings.podium_runtime_token.strip()
        if runtime_token:
            env["PODIUM_RUNTIME_TOKEN"] = runtime_token
        runtime_id = settings.podium_runtime_id.strip()
        if runtime_id:
            env["PODIUM_RUNTIME_ID"] = runtime_id
        runtime_group_id = settings.runtime_group_id.strip()
        if runtime_group_id:
            env["PODIUM_RUNTIME_GROUP_ID"] = runtime_group_id
        if not self._managed_mode_enabled():
            linear_api_key = os.environ.get("LINEAR_API_KEY", "").strip()
            if linear_api_key:
                env["LINEAR_API_KEY"] = linear_api_key
        return env

    def _managed_mode_enabled(self) -> bool:
        return self.store.get_settings().managed_mode

    def _normalize_stale_runtime_state(self) -> None:
        for instance in self.store.list_instances():
            if instance.process_status in {"starting", "running", "unhealthy", "crash_loop"}:
                active_runs = self.store.list_orchestration_runs(
                    instance_id=instance.id,
                    phases={RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING},
                )
                candidate_pids = [
                    pid
                    for pid in [instance.pid, *(run.process_pid for run in active_runs)]
                    if pid is not None
                ]
                recovered_by_pid: dict[int, InstanceRecord] = {}
                for pid in dict.fromkeys(candidate_pids):
                    recovered = self.runtime_manager.recover(instance.with_updates(process_status="running", pid=pid))
                    if recovered is not None and recovered.pid is not None:
                        recovered_by_pid[recovered.pid] = recovered
                if instance.pid in recovered_by_pid:
                    self.store.update_instance(recovered_by_pid[instance.pid])
                elif recovered_by_pid:
                    self.store.update_instance(next(iter(recovered_by_pid.values())))
                else:
                    self.store.update_instance(instance.with_updates(process_status="stopped", pid=None))
                for run in active_runs:
                    if run.process_pid not in recovered_by_pid:
                        self._clear_orphaned_active_runs(
                            instance.id,
                            "orphaned performer process was not recoverable",
                            process_pid=run.process_pid,
                        )

    def _clear_orphaned_active_runs(self, instance_id: str, reason: str, *, process_pid: int | None = None) -> None:
        runs = self.store.list_orchestration_runs(
            instance_id=instance_id,
            phases={RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING},
        )
        for run in runs:
            if process_pid is not None and run.process_pid != process_pid:
                continue
            try:
                self.phase_reducer.performer_start_failed(run.run_id, error=reason)
            except PhaseTransitionError:
                continue

    def _phase_run_row(self, run) -> dict[str, Any]:
        telemetry = self._telemetry_for_phase_run(run)
        telemetry_run = telemetry.get("run") if isinstance(telemetry.get("run"), dict) else {}
        return {
            "run_id": run.run_id,
            "issue_id": run.issue_id,
            "issue_identifier": run.issue_identifier,
            "instance_id": run.instance_id,
            "phase": run.phase.value,
            "status": run.status,
            "attempt": run.attempt,
            "workflow_profile": run.workflow_profile,
            "dispatch_id": run.dispatch_id,
            "workspace_path": run.workspace_path,
            "ops_snapshot_path": run.ops_snapshot_path,
            "human_action": dict(run.human_action),
            "human_response": run.human_response,
            "last_reason": run.last_reason,
            "last_error": run.last_error,
            "process_pid": run.process_pid,
            "ack_status": run.ack_status,
            "retry_count": run.retry_count,
            "crash_count": run.crash_count,
            "init_failure_count": run.init_failure_count,
            "overload_count": run.overload_count,
            "next_run_at": run.next_run_at,
            "turn_count": _int(telemetry_run.get("turn_count")),
            "total_tokens": _int(telemetry_run.get("total_tokens")),
            "estimated_cost_usd": float(telemetry_run.get("estimated_cost_usd") or 0.0),
            "last_activity_at": telemetry_run.get("last_activity_at"),
        }

    def _phase_run_detail(self, run) -> dict[str, Any]:
        telemetry = self._telemetry_for_phase_run(run)
        events = [event.to_dict() for event in self.store.list_orchestration_events(run.run_id)]
        return {
            "run": self._phase_run_row(run),
            "issue": telemetry.get("issue"),
            "attempts": telemetry.get("attempts", []),
            "turns": telemetry.get("turns", []),
            "events": events,
            "metrics": telemetry.get("metrics", {}),
            "telemetry": telemetry,
            "instance_id": run.instance_id,
        }

    def _telemetry_for_phase_run(self, run) -> dict[str, Any]:
        instance = self.store.get_instance(run.instance_id)
        if instance is None:
            return {"source": "missing_instance"}
        snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
        telemetry_run_id = _latest_ops_run_id_for_issue(snapshot, run.issue_id)
        if telemetry_run_id is None:
            return {"source": "none"}
        detail = build_run_detail(snapshot, telemetry_run_id)
        detail["source"] = "ops"
        return detail

    def _performer_runtime_from_phase_runs(self, instance: InstanceRecord) -> dict[str, Any]:
        phase_runs = self.store.list_orchestration_runs(instance_id=instance.id)
        telemetry = self._performer_runtime_from_persistence(instance)
        if not phase_runs:
            return telemetry
        running: list[dict[str, Any]] = []
        retrying: list[dict[str, Any]] = []
        continuing: list[dict[str, Any]] = []
        blocked: list[dict[str, Any]] = []
        human_interventions: list[dict[str, Any]] = []
        completed: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for run in phase_runs:
            row = _phase_runtime_row(run)
            if run.phase in {RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING}:
                running.append(row)
            elif run.phase is RunPhase.QUEUED:
                retrying.append(row) if run.retry_count or run.next_run_at else continuing.append(row)
            elif run.phase is RunPhase.AWAITING_HUMAN:
                blocked.append(row)
                human_interventions.append(row)
            elif run.phase is RunPhase.DONE:
                completed.append(row)
            elif run.phase is RunPhase.FAILED:
                failed.append(row)
        return {
            "source": "conductor_phase",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": len(continuing),
                "blocked": len(blocked),
                "pending_human": len(human_interventions),
                "completed": len(completed),
                "failed": len(failed),
            },
            "running": running,
            "retrying": retrying,
            "continuing": continuing,
            "blocked": blocked,
            "human_interventions": human_interventions,
            "completed": completed,
            "failed": failed,
            "issues": running + retrying + continuing + blocked + human_interventions + completed + failed,
            "telemetry": telemetry,
        }

    def _performer_runtime_from_persistence(self, instance: InstanceRecord) -> dict[str, Any]:
        persisted = PersistenceStore(Path(instance.persistence_path)).load()
        running = [_persisted_session_row(session) for session in persisted.sessions]
        retrying = [_persisted_retry_row(entry) for entry in persisted.retry_attempts]
        continuing = [_persisted_continuation_row(entry) for entry in persisted.continuations]
        blocked = [_persisted_blocked_row(entry) for entry in persisted.blocked]
        human_interventions = [_persisted_human_intervention_row(entry) for entry in persisted.human_interventions]
        return {
            "source": "persistence",
            "persistence_path": instance.persistence_path,
            "counts": {
                "running": len(running),
                "retrying": len(retrying),
                "continuing": len(continuing),
                "blocked": len(blocked),
                "pending_human": len(human_interventions),
            },
            "running": running,
            "retrying": retrying,
            "continuing": continuing,
            "blocked": blocked,
            "human_interventions": human_interventions,
            "issues": running + retrying + continuing + blocked + human_interventions,
        }

    def _ops_snapshots(self) -> list[tuple[InstanceRecord, OpsSnapshot]]:
        return [(instance, snapshot) for instance, _store, snapshot in self._ops_stores()]

    def _ops_stores(self) -> list[tuple[InstanceRecord, OpsStore, OpsSnapshot]]:
        rows: list[tuple[InstanceRecord, OpsStore, OpsSnapshot]] = []
        for instance in self.store.list_instances():
            store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
            snapshot = store.load()
            rows.append((instance, store, snapshot))
        return rows

    def _update_issue_pin(self, issue_id: str, *, pinned: bool) -> None:
        found = False
        for _instance, store, snapshot in self._ops_stores():
            if issue_id not in snapshot.issues and issue_id not in snapshot.retention.pinned_issue_ids:
                continue
            found = True
            pinned_ids = list(snapshot.retention.pinned_issue_ids)
            if pinned and issue_id not in pinned_ids:
                pinned_ids.append(issue_id)
            if not pinned:
                pinned_ids = [item for item in pinned_ids if item != issue_id]
            snapshot.retention = snapshot.retention.__class__(
                pinned_issue_ids=sorted(pinned_ids),
                pinned_run_ids=list(snapshot.retention.pinned_run_ids),
                last_collected_at=snapshot.retention.last_collected_at,
            )
            store.save(snapshot)
        if not found:
            raise ConductorServiceError("issue_not_found", f"Issue not found: {issue_id}")


def json_stable(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _normalize_linear_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    state = node.get("state") if isinstance(node.get("state"), dict) else {}
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "description": node.get("description") or "",
        "url": node.get("url"),
        "state": state.get("name") if isinstance(state, dict) else node.get("state"),
        "state_type": state.get("type") if isinstance(state, dict) else None,
        "delegate_id": delegate.get("id") if delegate else None,
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
    }


def _replace_marker_block(current: str, marker_name: str, block: str) -> str:
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    replacement = f"{start}\n{block.strip()}\n{end}"
    if start in current and end in current:
        prefix, rest = current.split(start, 1)
        _old, suffix = rest.split(end, 1)
        return f"{prefix.rstrip()}\n\n{replacement}\n\n{suffix.lstrip()}".strip()
    base = current.strip()
    return f"{base}\n\n{replacement}".strip() if base else replacement


def _find_phase_human_child(human_action: dict[str, Any], children: list[dict[str, Any]]) -> dict[str, Any] | None:
    return find_phase_human_child(human_action, children)


def _linear_issue_is_done(issue: dict[str, Any]) -> bool:
    return linear_issue_is_done(issue)


def _human_response_from_child(child: dict[str, Any]) -> str | None:
    return human_response_from_child(child)


def _phase_human_action_requires_response(human_action: dict[str, Any]) -> bool:
    return phase_human_action_requires_response(human_action)


def _persisted_session_row(session: PersistedSession) -> dict[str, Any]:
    return {
        "issue_id": session.issue_id,
        "issue_identifier": session.issue_identifier,
        "issue_url": session.issue_url,
        "session_id": session.session_id,
        "turn_id": session.turn_id,
        "worker_host": session.worker_host,
        "phase": session.phase,
        "status_label": session.status_label,
        "workspace_path": session.workspace_path,
        "started_at": session.started_at.isoformat().replace("+00:00", "Z"),
        "last_event": session.last_event,
        "last_message": session.last_message,
        "last_raw_message": session.last_raw_message,
        "recent_events": session.recent_events,
        "turn_count": session.turn_count,
        "tokens": {
            "input_tokens": session.tokens.input_tokens,
            "output_tokens": session.tokens.output_tokens,
            "cached_tokens": session.tokens.cached_tokens,
            "total_tokens": session.tokens.total_tokens,
        },
    }


def _persisted_retry_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_continuation_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": entry.due_at.isoformat().replace("+00:00", "Z"),
        "due_at_ms": entry.due_at_ms,
        "error": None,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_blocked_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "blocked_at": entry.blocked_at.isoformat().replace("+00:00", "Z"),
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _persisted_human_intervention_row(entry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "created_at": entry.created_at.isoformat().replace("+00:00", "Z"),
        "kind": entry.kind,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "child_issue_id": entry.child_issue_id,
        "child_identifier": entry.child_identifier,
        "child_url": entry.child_url,
        "questions": entry.questions,
        "resume_strategy": entry.resume_strategy,
        "recent_events": entry.recent_events,
    }


def _phase_runtime_row(run) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "issue_id": run.issue_id,
        "issue_identifier": run.issue_identifier,
        "phase": run.phase.value,
        "status": run.status,
        "attempt": run.attempt,
        "workflow_profile": run.workflow_profile,
        "dispatch_id": run.dispatch_id,
        "workspace_path": run.workspace_path,
        "ops_snapshot_path": run.ops_snapshot_path,
        "human_action": dict(run.human_action),
        "human_response": run.human_response,
        "last_reason": run.last_reason,
        "last_error": run.last_error,
        "retry_count": run.retry_count,
        "crash_count": run.crash_count,
        "init_failure_count": run.init_failure_count,
        "overload_count": run.overload_count,
        "next_run_at": run.next_run_at,
        "ack_status": run.ack_status,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


def _run_due(run) -> bool:
    next_run_at = _parse_iso(run.next_run_at)
    return next_run_at is None or datetime.now(timezone.utc) >= next_run_at


def _latest_ops_run_id_for_issue(snapshot: OpsSnapshot, issue_id: str) -> str | None:
    candidates = [run for run in snapshot.runs.values() if run.issue_id == issue_id]
    if not candidates:
        return None
    candidates.sort(key=lambda run: run.last_activity_at or run.completed_at or run.started_at or "", reverse=True)
    return candidates[0].run_id


def _runtime_metrics(performer: dict[str, Any]) -> dict[str, Any]:
    running = performer.get("running") if isinstance(performer.get("running"), list) else []
    retrying = performer.get("retrying") if isinstance(performer.get("retrying"), list) else []
    continuing = performer.get("continuing") if isinstance(performer.get("continuing"), list) else []
    blocked = performer.get("blocked") if isinstance(performer.get("blocked"), list) else []
    human_interventions = (
        performer.get("human_interventions") if isinstance(performer.get("human_interventions"), list) else []
    )
    tokens = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "total_tokens": 0}
    turns = 0
    for row in running:
        if not isinstance(row, dict):
            continue
        row_tokens = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        tokens["input_tokens"] += _int(row_tokens.get("input_tokens"))
        tokens["output_tokens"] += _int(row_tokens.get("output_tokens"))
        tokens["cached_tokens"] += _int(row_tokens.get("cached_tokens"))
        tokens["total_tokens"] += _int(row_tokens.get("total_tokens"))
        turns += _int(row.get("turn_count"))
    return {
        "tokens": tokens,
        "turns": turns,
        "running": len(running),
        "retrying": len(retrying),
        "continuing": len(continuing),
        "blocked": len(blocked),
        "pending_human": len(human_interventions),
    }


def _performer_retry_metric(performer: dict[str, Any]) -> int:
    if performer.get("source") == "conductor_phase":
        rows = performer.get("issues") if isinstance(performer.get("issues"), list) else []
        return sum(_int(row.get("retry_count")) for row in rows if isinstance(row, dict))
    counts = performer.get("counts") if isinstance(performer.get("counts"), dict) else {}
    return _int(counts.get("retrying"))


def _performer_failure_metric(performer: dict[str, Any]) -> int:
    if performer.get("source") == "conductor_phase":
        rows = performer.get("failed") if isinstance(performer.get("failed"), list) else []
        return len(rows)
    return 0


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    return 0


def _config_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return ""


def _linear_agent_app_user_id(filters: dict[str, Any]) -> str:
    return str(filters.get("linear_agent_app_user_id") or filters.get("agent_app_user_id") or "").strip()


def _desired_project_labels(instance: InstanceRecord) -> list[str]:
    """The `symphony:` project labels that mirror an instance's routing scope.

    Human-readable and keyed on the instance name (unique per Conductor) so the
    Linear project shows exactly which Performers and profiles target it.
    """
    labels = [f"{PROJECT_LABEL_PREFIX}performer/{instance.name}"]
    profile = str(instance.workflow_profile or "").strip()
    if profile:
        labels.append(f"{PROJECT_LABEL_PREFIX}profile/{profile}")
    return labels


def _merge_project_labels(existing: list[str], desired: list[str]) -> list[str]:
    """Replace only the `symphony:` namespace, preserving user-owned labels.

    Linear's `projectUpdate.labelIds` is a full replacement, so the caller must
    send the complete set: every non-`symphony:` label kept as-is plus the
    desired managed labels.
    """
    kept = [label for label in existing if not label.startswith(PROJECT_LABEL_PREFIX)]
    merged = list(kept)
    for label in desired:
        if label not in merged:
            merged.append(label)
    return merged


def _first_pending_performer_issue(persisted: PersistedState) -> dict[str, Any] | None:
    for collection in (persisted.retry_attempts, persisted.continuations, persisted.blocked, persisted.human_interventions):
        for entry in collection:
            issue_id = str(getattr(entry, "issue_id", "") or "").strip()
            if issue_id:
                return {
                    "issue_id": issue_id,
                    "issue_identifier": str(getattr(entry, "identifier", "") or "").strip() or None,
                    "attempt": _optional_positive_int(getattr(entry, "attempt", None)),
                }
    return None


def _first_pending_performer_issue_id(persisted: PersistedState) -> str | None:
    pending = _first_pending_performer_issue(persisted)
    return str(pending["issue_id"]) if pending is not None else None


def _has_pending_performer_work(persisted: PersistedState) -> bool:
    return _first_pending_performer_issue_id(persisted) is not None


def _optional_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _sanitize_connection_error(error: str | None) -> str | None:
    if error is None:
        return None
    text = str(error)
    for marker in ("Bearer ", "token=", "access_token="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:500]


def _repository_handoff_marker(source_issue_id: str) -> str:
    return repository_handoff_marker(source_issue_id)


def _repository_handoff_closeout_event(
    snapshot: OpsSnapshot,
    *,
    source_event: TraceEvent,
    status: str,
    payload: dict[str, Any],
) -> TraceEvent:
    return repository_handoff_closeout_event(snapshot, source_event=source_event, status=status, payload=payload)


def _repository_integration_description(report: dict[str, Any], *, instance: InstanceRecord) -> str:
    return repository_integration_description(report, instance=instance)


def _repository_handoff_comment(report: dict[str, Any], *, child: dict[str, Any], mention: str) -> str:
    return repository_handoff_comment(report, child=child, mention=mention)


def _phase_diagnostic_comment(
    title: str,
    run,
    *,
    reason: str | None,
    instance: InstanceRecord,
    extra: dict[str, Any],
) -> str:
    issue_ref = run.issue_identifier or run.issue_id
    lines = [
        f"{title} for {issue_ref}.",
        "",
        f"run_id: `{run.run_id}`",
        f"phase: `{run.phase.value}`",
        f"status: `{run.status}`",
        f"reason: {_safe_linear_value(reason or run.last_reason or 'unknown')}",
        f"attempt: {run.attempt}",
        f"retry_count: {run.retry_count}",
        f"crash_count: {run.crash_count}",
        f"init_failure_count: {run.init_failure_count}",
        f"overload_count: {run.overload_count}",
    ]
    for key, value in extra.items():
        if value is None:
            continue
        lines.append(f"{key}: {_safe_linear_value(value)}")
    lines.extend(
        [
            "",
            f"Local log: `{instance.log_path}`",
            "No secret values were included in this diagnostic.",
        ]
    )
    return "\n".join(lines)


def _phase_failure_needs_human_action(run, detail: dict[str, Any]) -> bool:
    text = " ".join(
        str(value or "")
        for value in (
            run.last_reason,
            run.last_error,
            detail.get("reason"),
            detail.get("error"),
        )
    ).lower()
    return any(
        marker in text
        for marker in (
            "upstream_overloaded",
            "upstream overload",
            "server overloaded",
            "codex_bad_request",
            "invalid request",
            "invalid params",
            "json-rpc error",
            "scenario_timeout_unresolved",
            "linear_phase_projection_failed",
            "gate_parent_relationship_drift",
            "orchestration_event_rebuild_failed",
        )
    )


def _phase_failure_human_action_description(run, detail: dict[str, Any]) -> str:
    issue_ref = run.issue_identifier or run.issue_id
    reason = detail.get("reason") or run.last_reason or "runtime_error"
    error = detail.get("error") or run.last_error or reason
    lines = [
        "The managed Performer phase hit an execution failure that needs human review.",
        "",
        f"Parent issue: {issue_ref}",
    ]
    http_status = detail.get("http_status")
    if http_status is not None:
        lines.extend(["", f"Upstream HTTP status: {http_status}"])
    lines.extend(
        [
            "",
            "Last error:",
            _safe_multiline_linear_value(error),
            "",
            f"Reason: {_safe_linear_value(reason)}",
            f"Run ID: `{run.run_id}`",
            f"attempt: {run.attempt}",
            f"retry_count: {run.retry_count}",
            f"crash_count: {run.crash_count}",
            f"init_failure_count: {run.init_failure_count}",
            f"overload_count: {run.overload_count}",
            "",
            "Human response:",
            "(Add the answer or decision here when information is required.)",
            "",
            "When finished, move this child issue to Done.",
        ]
    )
    return "\n".join(lines)


def _phase_failure_error_is_summary(value: str) -> bool:
    return value in {"upstream overload exhausted repeatedly", "codex init failed repeatedly"} or not value


def _safe_linear_value(value: Any) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    for marker in ("Bearer ", "token=", "access_token=", "refresh_token=", "api_key="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:500]


def _safe_multiline_linear_value(value: Any) -> str:
    text = str(value).replace("\r", " ").strip()
    for marker in ("Bearer ", "token=", "access_token=", "refresh_token=", "api_key="):
        if marker in text:
            text = text.split(marker, 1)[0] + marker + "[redacted]"
    return text[:1000]


def _optional_dispatch_ref(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    text = str(value or "").strip()
    return text or None


def _blocked_by_issue_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    blocked_by: list[str] = []
    seen: set[str] = set()
    for blocker in value:
        candidate = blocker.get("id") if isinstance(blocker, dict) else getattr(blocker, "id", blocker)
        text = str(candidate or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        blocked_by.append(text)
    return blocked_by


def _sanitize_codex_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    profile: dict[str, Any] = {}
    model = str(value.get("model") or "").strip()
    sandbox = str(value.get("sandbox") or "").strip()
    if model:
        profile["model"] = model
    if sandbox:
        profile["sandbox"] = sandbox
    overrides = value.get("config_overrides")
    if isinstance(overrides, list):
        safe_overrides: list[str] = []
        for item in overrides:
            text = str(item).strip()
            if not text or "=" not in text:
                continue
            key, raw_value = text.split("=", 1)
            lowered_key = key.lower()
            if any(marker in lowered_key for marker in ("api_key", "apikey", "token", "secret", "password")) and not raw_value.strip().startswith("$"):
                continue
            safe_overrides.append(text)
        if safe_overrides:
            profile["config_overrides"] = safe_overrides
    return profile
