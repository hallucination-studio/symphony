from __future__ import annotations

import asyncio
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from .phase_executor import PhaseExecutor
from .phase_runtime import PhaseRuntime
from .acceptance import (
    AcceptanceReport,
    CodexGatePlanner,
    GatePlan,
    GatePlanReport,
    SmokeGatePlanner,
    parse_acceptance_report,
    parse_gate_plan_report,
)
from performer_api.config import ConfigError, ServiceConfig
from performer_api.phase import PhaseAdvanceRequest, PhaseAdvanceResult, RunPhase
from .completion_verifier import CompletionVerifier
from performer_api.models import (
    HUMAN_INTERVENTION_LABELS,
    PHASE_LABELS,
    BlockedEntry,
    ContinuationEntry,
    HumanInterventionEntry,
    Issue,
    RetryEntry,
    RunningEntry,
    RuntimeTokens,
    monotonic_ms,
    normalize_state_key,
    parse_datetime,
    sort_for_dispatch,
    utc_now,
)
from performer_api.persistence import CodexThreadEntry, PersistedState, PersistenceStore
from performer_api.persistence import ops_snapshot_path_from_persistence_path
from performer_api.ops_store import OpsStore
from .linear import format_linear_milestone_comment
from .ops_telemetry import ExecutionTelemetryRecorder
from .repository_handoff import build_repository_handoff_report
from .workspace import WorkspaceManager


logger = logging.getLogger(__name__)

HUMAN_RESPONSE_MARKER_NAME = "SYMPHONY HUMAN RESPONSE"


class TrackerProtocol(Protocol):
    async def fetch_candidate_issues(self) -> list[Issue]: ...

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]: ...

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]: ...

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]: ...

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]: ...

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]: ...


class RunnerProtocol(Protocol):
    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> Any: ...


class AcceptanceRunnerProtocol(Protocol):
    async def run_acceptance(self, **kwargs: Any) -> str: ...


class GatePlannerProtocol(Protocol):
    async def plan_gates(self, **kwargs: Any) -> str: ...


@dataclass
class OrchestratorState:
    running: dict[str, RunningEntry] = field(default_factory=dict)
    claimed: set[str] = field(default_factory=set)
    retry_attempts: dict[str, RetryEntry] = field(default_factory=dict)
    continuations: dict[str, ContinuationEntry] = field(default_factory=dict)
    blocked: dict[str, BlockedEntry] = field(default_factory=dict)
    human_interventions: dict[str, HumanInterventionEntry] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)
    codex_totals: RuntimeTokens = field(default_factory=RuntimeTokens)
    codex_rate_limits: dict[str, Any] | None = None
    ended_runtime_seconds: float = 0
    codex_threads: dict[str, CodexThreadEntry] = field(default_factory=dict)


class Orchestrator:
    def __init__(
        self,
        config: ServiceConfig,
        tracker: TrackerProtocol,
        runner: RunnerProtocol,
        *,
        workspace_manager: WorkspaceManager | None = None,
        persistence_store: PersistenceStore | None = None,
        acceptance_runner: AcceptanceRunnerProtocol | None = None,
        gate_planner: GatePlannerProtocol | None = None,
    ):
        self.config = config
        self.tracker = tracker
        self.runner = runner
        self.acceptance_runner = acceptance_runner
        self.gate_planner = gate_planner
        self.workspace_manager = workspace_manager
        self.persistence_store = persistence_store
        self.completion_verifier = CompletionVerifier(config.completion_verification, tracker)
        self.state = OrchestratorState()
        self._worker_tasks: set[asyncio.Task[Any]] = set()
        self._background_label_tasks: set[asyncio.Task[Any]] = set()
        self._desired_lifecycle_labels: dict[str, str] = {}
        self.phase_runtime = PhaseRuntime(self)

    def load_persisted_state(self) -> None:
        if self.persistence_store is None:
            return
        persisted = self.persistence_store.load()
        for retry in persisted.retry_attempts:
            self.state.retry_attempts[retry.issue_id] = retry
            self.state.claimed.add(retry.issue_id)
        for continuation in persisted.continuations:
            self.state.continuations[continuation.issue_id] = continuation
            self.state.claimed.add(continuation.issue_id)
        for blocked in persisted.blocked:
            self.state.blocked[blocked.issue_id] = blocked
            self.state.claimed.add(blocked.issue_id)
        for intervention in persisted.human_interventions:
            self.state.human_interventions[intervention.issue_id] = intervention
            self.state.claimed.add(intervention.issue_id)
        for thread in persisted.codex_threads:
            status = "resume_pending" if thread.status == "active" else thread.status
            restored = CodexThreadEntry(
                issue_id=thread.issue_id,
                thread_id=thread.thread_id,
                backend=thread.backend,
                workspace_path=thread.workspace_path,
                last_turn_id=thread.last_turn_id,
                status=status,
                last_final_response=thread.last_final_response,
                updated_at=utc_now() if status != thread.status else thread.updated_at,
            )
            self.state.codex_threads[restored.issue_id] = restored

    async def tick(self) -> None:
        await self.reconcile_running()
        try:
            self.config.validate_for_dispatch()
        except ConfigError as exc:
            logger.warning("performer_dispatch_validation failed code=%s reason=%s", exc.code, exc)
            return
        await self.process_human_interventions()
        await self.process_due_continuations()
        await self.process_due_retries()
        try:
            candidates = await self.tracker.fetch_candidate_issues()
        except Exception as exc:
            logger.warning("performer_dispatch failed reason=%s", exc)
            return
        logger.info(
            "performer_dispatch_scan candidate_count=%s available_slots=%s running=%s claimed=%s",
            len(candidates),
            self.available_slots(),
            len(self.state.running),
            len(self.state.claimed),
        )
        dispatched = 0
        skipped = 0
        for candidate in sort_for_dispatch(candidates):
            if self.available_slots() <= 0:
                logger.info(
                    "performer_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=no_available_slots",
                    candidate.id,
                    candidate.identifier,
                )
                skipped += 1
                break
            if await self._process_acceptance_state_candidate(candidate):
                skipped += 1
                continue
            reason = self.dispatch_skip_reason(candidate)
            if reason is not None:
                logger.info(
                    "performer_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=%s",
                    candidate.id,
                    candidate.identifier,
                    reason,
                )
                skipped += 1
                continue
            worker_host = self._select_worker_host()
            if self.config.worker.ssh_hosts and worker_host is None:
                logger.info(
                    "performer_dispatch_candidate outcome=skip issue_id=%s issue_identifier=%s reason=no_available_worker_host",
                    candidate.id,
                    candidate.identifier,
                )
                skipped += 1
                continue
            logger.info(
                "performer_dispatch_candidate outcome=dispatch issue_id=%s issue_identifier=%s worker_host=%s",
                candidate.id,
                candidate.identifier,
                worker_host or "local",
            )
            self.dispatch_issue(candidate, attempt=None, worker_host=worker_host)
            dispatched += 1
        logger.info(
            "performer_dispatch_summary dispatched=%s skipped=%s running=%s claimed=%s",
            dispatched,
            skipped,
            len(self.state.running),
            len(self.state.claimed),
        )
        await asyncio.sleep(0)

    async def advance(self, request: PhaseAdvanceRequest) -> PhaseAdvanceResult:
        return await PhaseExecutor(self).advance(request)

    async def process_human_interventions(self) -> None:
        if not self.state.human_interventions:
            return
        fetch_children = getattr(self.tracker, "fetch_child_issues", None)
        if not callable(fetch_children):
            return
        for intervention in list(self.state.human_interventions.values()):
            try:
                children = await fetch_children(intervention.issue_id, label_name=HUMAN_INTERVENTION_LABELS["type"])
            except Exception as exc:
                logger.warning(
                    "performer_human_intervention_poll failed issue_id=%s issue_identifier=%s reason=%s",
                    intervention.issue_id,
                    intervention.identifier,
                    exc,
                )
                continue
            child = _find_human_child(intervention, children)
            if child is None or normalize_state_key(str(child.get("state") or "")) != "done":
                continue
            response = _human_response_from_child(child)
            if _human_intervention_requires_response(intervention) and not response:
                await self._comment_missing_human_response(intervention)
                continue
            await self._resolve_human_intervention(intervention, response=response)
            logger.info(
                "performer_human_intervention outcome=resolved issue_id=%s issue_identifier=%s child_issue_id=%s",
                intervention.issue_id,
                intervention.identifier,
                intervention.child_issue_id,
            )
        await asyncio.sleep(0)

    async def process_blocked_approvals(self) -> None:
        await self.process_human_interventions()

    async def process_managed_human_response(self, issue_id: str, human_response: str) -> None:
        intervention = self.state.human_interventions.get(issue_id)
        if intervention is None:
            return
        await self._resolve_human_intervention(intervention, response=human_response)
        self.state.retry_attempts.pop(issue_id, None)
        self.state.claimed.discard(issue_id)
        self._persist_state()
        await asyncio.sleep(0)

    async def startup_terminal_workspace_cleanup(self, workspace_manager: WorkspaceManager) -> None:
        try:
            issues = await self.tracker.fetch_issues_by_states(self.config.tracker.terminal_states)
        except Exception as exc:
            logger.warning("performer_startup_cleanup failed reason=%s", exc)
            return
        for issue in issues:
            await workspace_manager.remove_for_issue(issue.identifier)

    def _release_due_retry_for_phase(self, issue_id: str) -> None:
        retry = self.state.retry_attempts.get(issue_id)
        if retry is None or retry.due_at_ms > monotonic_ms():
            return
        self.state.retry_attempts.pop(issue_id, None)
        self.state.claimed.discard(issue_id)
        self._persist_state()

    async def process_due_retries(self) -> None:
        now_ms = monotonic_ms()
        due = [entry for entry in self.state.retry_attempts.values() if entry.due_at_ms <= now_ms]
        if not due:
            return
        try:
            candidates = await self.tracker.fetch_candidate_issues()
        except Exception as exc:
            logger.warning("performer_retry failed reason=%s", exc)
            for retry in due:
                issue = Issue(
                    id=retry.issue_id,
                    identifier=retry.identifier,
                    title=retry.identifier,
                    state=self.config.tracker.active_states[0] if self.config.tracker.active_states else "",
                    url=retry.issue_url,
                    project_slug=self.config.tracker.project_slug,
                )
                self._schedule_retry(
                    issue,
                    retry.attempt + 1,
                    error="retry poll failed",
                    delay_ms=None,
                )
            return
        by_id = {issue.id: issue for issue in candidates}
        for retry in due:
            self.state.retry_attempts.pop(retry.issue_id, None)
            self.state.claimed.discard(retry.issue_id)
            issue = by_id.get(retry.issue_id)
            if issue is None:
                self._persist_state()
                continue
            if self.available_slots() <= 0 or not self.should_dispatch(issue):
                if self.available_slots() <= 0:
                    self._schedule_retry(
                        issue,
                        retry.attempt + 1,
                        error="no available orchestrator slots",
                        delay_ms=None,
                    )
                continue
            worker_host = self._select_worker_host()
            if self.config.worker.ssh_hosts and worker_host is None:
                self._schedule_retry(
                    issue,
                    retry.attempt + 1,
                    error="no available worker host",
                    delay_ms=None,
                )
                continue
            self.dispatch_issue(_issue_with_retry_context(issue, retry), attempt=retry.attempt, worker_host=worker_host)
        await asyncio.sleep(0)

    async def process_due_continuations(self) -> None:
        now_ms = monotonic_ms()
        due = [entry for entry in self.state.continuations.values() if entry.due_at_ms <= now_ms]
        if not due:
            return
        try:
            candidates = await self.tracker.fetch_candidate_issues()
        except Exception as exc:
            logger.warning("performer_continuation failed reason=%s", exc)
            for continuation in due:
                issue = Issue(
                    id=continuation.issue_id,
                    identifier=continuation.identifier,
                    title=continuation.identifier,
                    state=self.config.tracker.active_states[0] if self.config.tracker.active_states else "",
                    url=continuation.issue_url,
                    project_slug=self.config.tracker.project_slug,
                )
                self._schedule_continuation(
                    issue,
                    continuation.attempt,
                    delay_ms=self.config.polling.interval_ms,
                    last_message=f"continuation poll failed: {exc}",
                )
            return
        by_id = {issue.id: issue for issue in candidates}
        for continuation in due:
            self.state.continuations.pop(continuation.issue_id, None)
            self.state.claimed.discard(continuation.issue_id)
            issue = by_id.get(continuation.issue_id)
            if issue is None:
                self._persist_state()
                continue
            if self.available_slots() <= 0 or not self.should_dispatch(issue):
                if self.available_slots() <= 0:
                    self._schedule_continuation(
                        issue,
                        continuation.attempt,
                        delay_ms=self.config.polling.interval_ms,
                        last_message="no available orchestrator slots",
                    )
                continue
            worker_host = self._select_worker_host()
            if self.config.worker.ssh_hosts and worker_host is None:
                self._schedule_continuation(
                    issue,
                    continuation.attempt,
                    delay_ms=self.config.polling.interval_ms,
                    last_message="no available worker host",
                )
                continue
            self.dispatch_issue(issue, attempt=continuation.attempt, worker_host=worker_host)
        await asyncio.sleep(0)

    def should_dispatch(self, issue: Issue) -> bool:
        return self.dispatch_skip_reason(issue) is None

    def dispatch_skip_reason(self, issue: Issue) -> str | None:
        if not issue.id or not issue.identifier or not issue.title or not issue.state:
            return "missing_required_issue_fields"
        if issue.id in self.state.running or issue.id in self.state.claimed:
            return "already_running_or_claimed"
        if not self._is_active(issue):
            return "inactive_state"
        if self.config.acceptance.enabled:
            acceptance = self.config.acceptance
            if issue.state_key() == normalize_state_key(acceptance.review_state):
                return "acceptance_review_state"
            if issue.state_key() == normalize_state_key(acceptance.done_state):
                return "acceptance_done_state"
            if issue.state_key() == normalize_state_key(acceptance.todo_state):
                return "acceptance_preflight_required"
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return "project_mismatch"
        if not self._matches_required_delegate(issue):
            return "delegate_mismatch"
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return "blocked_by_non_terminal_dependency"
        if self.available_slots() <= 0:
            return "no_available_slots"
        if self._available_state_slots(issue.state) <= 0:
            return "no_available_state_slots"
        return None

    def dispatch_skip_reason_for_event(self, issue: Issue) -> str | None:
        if not issue.id or not issue.identifier or not issue.title or not issue.state:
            return "missing_required_issue_fields"
        if issue.id in self.state.running or issue.id in self.state.claimed:
            return "already_running_or_claimed"
        if not self._is_active(issue):
            return "inactive_state"
        if self.config.acceptance.enabled:
            acceptance = self.config.acceptance
            if issue.state_key() == normalize_state_key(acceptance.review_state):
                return "acceptance_review_state"
            if issue.state_key() == normalize_state_key(acceptance.done_state):
                return "acceptance_done_state"
            if issue.state_key() == normalize_state_key(acceptance.todo_state):
                return "acceptance_preflight_required"
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return "project_mismatch"
        if not self._matches_required_delegate(issue):
            return "delegate_mismatch"
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return "blocked_by_non_terminal_dependency"
        if self.available_slots() <= 0:
            return "no_available_slots"
        if self._available_state_slots(issue.state) <= 0:
            return "no_available_state_slots"
        return None

    def available_slots(self) -> int:
        return max(self.config.agent.max_concurrent_agents - len(self.state.running), 0)

    def dispatch_issue(self, issue: Issue, attempt: int | None, *, worker_host: str | None = None) -> None:
        self.state.claimed.add(issue.id)
        self.state.blocked.pop(issue.id, None)
        task = asyncio.create_task(self._run_worker(issue, attempt, worker_host=worker_host))
        self._worker_tasks.add(task)
        task.add_done_callback(self._worker_tasks.discard)
        self.state.running[issue.id] = RunningEntry(
            issue=issue,
            task=task,
            started_at=utc_now(),
            retry_attempt=attempt or 0,
            worker_host=worker_host,
        )
        self._set_running_phase(issue.id, "starting", runtime_phase="dispatch_received")
        self._sync_label_group_background(issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
        self._persist_state()

    async def _process_acceptance_state_candidate(self, issue: Issue) -> bool:
        if not self.config.acceptance.enabled:
            return False
        acceptance = self.config.acceptance
        state_key = issue.state_key()
        if state_key == normalize_state_key(acceptance.todo_state):
            if self.dispatch_skip_reason_without_acceptance(issue) is not None:
                return False
            await self._acceptance_preflight(issue)
            return True
        if state_key == normalize_state_key(acceptance.review_state):
            if self.dispatch_skip_reason_without_acceptance(issue) is not None:
                return False
            await self._run_acceptance_gate_for_issue(issue, completion_verdict=None)
            return True
        if state_key == normalize_state_key(acceptance.done_state):
            if _has_passed_acceptance_gate(issue, acceptance):
                self.state.completed.add(issue.id)
                return True
            if self.dispatch_skip_reason_without_acceptance(issue) is not None:
                return False
            await self._handle_direct_done_bypass(issue)
            return True
        return False

    def dispatch_skip_reason_without_acceptance(self, issue: Issue) -> str | None:
        if not issue.id or not issue.identifier or not issue.title or not issue.state:
            return "missing_required_issue_fields"
        if issue.id in self.state.running or issue.id in self.state.claimed:
            return "already_running_or_claimed"
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return "project_mismatch"
        if not self._matches_required_delegate(issue):
            return "delegate_mismatch"
        if self.available_slots() <= 0:
            return "no_available_slots"
        return None

    async def _acceptance_preflight(self, issue: Issue) -> dict[str, Any] | None:
        gates = await self._fetch_gate_issues(issue)
        if not gates:
            planner = self.gate_planner or self._gate_planner()
            raw_plan = await planner.plan_gates(issue=issue, workspace_path=str(self.config.workspace.root))
            plan = parse_gate_plan_report(raw_plan)
            if plan.needs_more_info:
                await self._handle_gate_plan_needs_more_info(issue, plan)
                return None
            if not plan.valid:
                await self._comment_gate_plan_rejected(issue, plan)
                await self._sync_label_group(
                    issue.id,
                    self.config.acceptance.needs_more_info_label,
                    prefix="performer:needs-more-info",
                )
                return None
            gates = []
            for index, gate in enumerate(plan.gates, start=1):
                created = await self._create_gate_issue(issue, gate, index=index)
                if created:
                    gates.append(created)
        if not gates:
            return None
        block = _gate_plan_marker_block(issue, gates, self.config.acceptance)
        update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
        if callable(update_description):
            await update_description(issue.id, self.config.acceptance.marker_name, block)
        if self.config.acceptance.task_type_label:
            await self._sync_label_group(issue.id, self.config.acceptance.task_type_label, prefix="performer:type/")
        await self._sync_label_group(issue.id, self.config.acceptance.gate_pending_label, prefix="performer:gate/")
        await self._sync_label_group(issue.id, self.config.acceptance.planned_phase_label, prefix="performer:phase/")
        await self._transition_issue_by_state_name(issue.id, self.config.acceptance.implementation_state)
        return gates[0]

    async def _fetch_gate_issues(self, issue: Issue) -> list[dict[str, Any]]:
        fetch_children = getattr(self.tracker, "fetch_child_issues", None)
        if not callable(fetch_children):
            return []
        children = await fetch_children(issue.id, label_name=self.config.acceptance.gate_type_label)
        return [child for child in children if _issue_dict_has_label(child, self.config.acceptance.gate_type_label)]

    async def _create_gate_issue(self, issue: Issue, gate: GatePlan, *, index: int) -> dict[str, Any] | None:
        create_child = getattr(self.tracker, "create_child_issue_for", None)
        if not callable(create_child):
            return None
        title = f"[Gate] {issue.identifier}: {gate.title}"
        description = _gate_issue_description(issue, gate, index=index)
        return await create_child(
            parent_issue_id=issue.id,
            title=title,
            description=description,
            label_names=[self.config.acceptance.gate_type_label],
            delegate_id=issue.delegate_id,
        )

    async def _handle_gate_plan_needs_more_info(self, issue: Issue, plan: GatePlanReport) -> None:
        await self._sync_label_group(
            issue.id,
            self.config.acceptance.needs_more_info_label,
            prefix="performer:needs-more-info",
        )
        await self._create_human_intervention(
            issue,
            kind="preflight_needs_input",
            attempt=0,
            error="preflight needs more information",
            questions=plan.questions,
            resume_strategy="preflight",
            last_message="preflight needs more information",
        )

    async def _comment_gate_plan_rejected(self, issue: Issue, plan: GatePlanReport) -> None:
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if callable(comment_issue):
            await comment_issue(issue.id, _gate_plan_rejected_comment(issue, plan.rejection_reasons))

    async def _handle_direct_done_bypass(self, issue: Issue) -> None:
        if not _has_acceptance_evidence(issue):
            await self._comment_policy_violation(issue, has_evidence=False)
            await self._sync_label_group(issue.id, self.config.acceptance.gate_failed_label, prefix="performer:gate/")
            await self._sync_label_group(issue.id, self.config.acceptance.rework_phase_label, prefix="performer:phase/")
            await self._transition_issue_by_state_name(issue.id, self.config.acceptance.implementation_state)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.REWORKING,
                status="reworking",
                reason="implementation_evidence_missing",
            )
            return
        await self._comment_policy_violation(issue, has_evidence=True)
        await self._transition_issue_by_state_name(issue.id, self.config.acceptance.review_state)
        await self._run_acceptance_gate_for_issue(issue, completion_verdict=None)

    async def _ensure_acceptance_issue(self, issue: Issue, completion_verdict: Any | None) -> dict[str, Any] | None:
        if self.config.tracker.kind != "linear":
            return None
        acceptance = self.config.acceptance
        if not acceptance.acceptance_type_label:
            return None
        find_acceptance = getattr(self.tracker, "find_acceptance_issue_for", None)
        if callable(find_acceptance):
            existing = await find_acceptance(
                original_issue=issue,
                acceptance_label_name=acceptance.acceptance_type_label,
            )
            if existing:
                await self._ensure_acceptance_relation(existing, issue)
                return existing
        create_acceptance_issue = getattr(self.tracker, "create_acceptance_issue_for", None)
        create_issue = getattr(self.tracker, "create_issue", None)
        if not callable(create_acceptance_issue) and not callable(create_issue):
            return None
        title = f"[Acceptance] {issue.identifier}: {issue.title}"
        description = _acceptance_issue_description_for_issue(issue, completion_verdict, acceptance_issue=None)
        if callable(create_acceptance_issue):
            created = await create_acceptance_issue(
                original_issue_id=issue.id,
                title=title,
                description=description,
                acceptance_label_name=acceptance.acceptance_type_label,
            )
        else:
            created = await create_issue(
                team_id="",
                project_id=self.config.tracker.project_slug,
                state_id=self.config.tracker.active_states[0] if self.config.tracker.active_states else "",
                label_ids=[],
                title=title,
                description=description,
            )
        await self._ensure_acceptance_relation(created, issue)
        return created

    async def _find_legacy_acceptance_issue(self, issue: Issue) -> dict[str, Any] | None:
        if self.config.tracker.kind != "linear":
            return None
        if not self.config.acceptance.acceptance_type_label:
            return None
        find_acceptance = getattr(self.tracker, "find_acceptance_issue_for", None)
        if not callable(find_acceptance):
            return None
        return await find_acceptance(
            original_issue=issue,
            acceptance_label_name=self.config.acceptance.acceptance_type_label,
        )

    async def _ensure_acceptance_relation(self, acceptance_issue: dict[str, Any], issue: Issue) -> None:
        acceptance_issue_id = str(acceptance_issue.get("id") or "")
        if not acceptance_issue_id:
            return
        ensure_relation = getattr(self.tracker, "ensure_issue_relation", None)
        create_relation = getattr(self.tracker, "create_issue_relation", None)
        if callable(ensure_relation):
            await ensure_relation(
                issue_id=acceptance_issue_id,
                related_issue_id=issue.id,
                relation_type="blocks",
            )
        elif callable(create_relation):
            await create_relation(
                issue_id=acceptance_issue_id,
                related_issue_id=issue.id,
                relation_type="blocks",
            )

    async def _run_acceptance_gate_for_issue(
        self,
        issue: Issue,
        *,
        acceptance_issue: dict[str, Any] | None = None,
        completion_verdict: Any | None = None,
        workspace_path: str | None = None,
    ) -> None:
        _ = acceptance_issue
        gates = await self._fetch_gate_issues(issue)
        if not gates:
            legacy_acceptance = await self._find_legacy_acceptance_issue(issue)
            if legacy_acceptance is not None:
                await self._run_legacy_acceptance_issue(
                    issue,
                    legacy_acceptance,
                    completion_verdict=completion_verdict,
                    workspace_path=workspace_path,
                )
            return
        await self._sync_label_group(issue.id, self.config.acceptance.gate_pending_label, prefix="performer:gate/")
        await self._sync_label_group(issue.id, self.config.acceptance.review_phase_label, prefix="performer:phase/")
        if self.acceptance_runner is None:
            return
        failed = False
        reviewed_gates: list[dict[str, Any]] = []
        for gate in gates:
            if _issue_dict_has_label(gate, self.config.acceptance.gate_passed_label) or _issue_dict_has_label(
                gate, self.config.acceptance.gate_pass_with_findings_label
            ):
                reviewed_gates.append(gate)
                continue
            raw_report = await self.acceptance_runner.run_acceptance(
                original_issue=issue,
                acceptance_issue=gate,
                completion_verdict=completion_verdict,
                workspace_path=workspace_path,
            )
            report = parse_acceptance_report(
                raw_report,
                minimum_score=self.config.acceptance.minimum_score,
                require_findings_for_score_3=self.config.acceptance.require_findings_for_score_3,
            )
            evidence_issue = await self._create_evidence_issue(issue, gate, report, raw_report, workspace_path)
            await self._comment_acceptance_report(str(gate.get("id") or ""), _entry_for_issue(issue, workspace_path), report)
            if report.accepted:
                gate_label = (
                    self.config.acceptance.gate_pass_with_findings_label
                    if report.score == self.config.acceptance.minimum_score and report.residual_findings
                    else self.config.acceptance.gate_passed_label
                )
                await self._sync_label_group(str(gate.get("id") or ""), gate_label, prefix="performer:gate/")
                await self._sync_label_group(
                    str(gate.get("id") or ""),
                    f"{self.config.acceptance.score_label_prefix}{report.score}/4",
                    prefix=self.config.acceptance.score_label_prefix,
                )
                if evidence_issue:
                    await self._transition_issue_by_state_name(str(evidence_issue.get("id") or ""), self.config.acceptance.done_state)
                await self._transition_issue_by_state_name(str(gate.get("id") or ""), self.config.acceptance.done_state)
                reviewed_gates.append({**gate, "labels": [gate_label], "label_ids": [gate_label]})
            else:
                failed = True
                await self._sync_label_group(str(gate.get("id") or ""), self.config.acceptance.gate_failed_label, prefix="performer:gate/")
                if report.score >= 0:
                    await self._sync_label_group(
                        str(gate.get("id") or ""),
                        f"{self.config.acceptance.score_label_prefix}{report.score}/4",
                        prefix=self.config.acceptance.score_label_prefix,
                    )
                break
        if failed:
            await self._sync_label_group(issue.id, self.config.acceptance.gate_failed_label, prefix="performer:gate/")
            await self._sync_label_group(issue.id, self.config.acceptance.rework_phase_label, prefix="performer:phase/")
            await self._transition_issue_by_state_name(issue.id, self.config.acceptance.implementation_state)
            self.state.claimed.discard(issue.id)
            self.state.retry_attempts.pop(issue.id, None)
            self.state.continuations.pop(issue.id, None)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.REWORKING,
                status="reworking",
                reason="acceptance_gate_failed",
            )
            self._persist_state()
            return
        if len(reviewed_gates) == len(gates):
            await self._sync_label_group(issue.id, self.config.acceptance.gate_passed_label, prefix="performer:gate/")
            await self._sync_label_group(issue.id, PHASE_LABELS["completed"], prefix="performer:phase/")
            await self._transition_issue_by_state_name(issue.id, self.config.acceptance.done_state)
            self._record_repository_handoff_after_acceptance(issue, workspace_path=workspace_path)
            self.state.completed.add(issue.id)
            self.state.claimed.discard(issue.id)
            self.state.retry_attempts.pop(issue.id, None)
            self.state.continuations.pop(issue.id, None)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
            )
            self._persist_state()

    async def _run_legacy_acceptance_issue(
        self,
        issue: Issue,
        acceptance_issue: dict[str, Any],
        *,
        completion_verdict: Any | None,
        workspace_path: str | None,
    ) -> None:
        acceptance_issue_id = str((acceptance_issue or {}).get("id") or "")
        if self.acceptance_runner is None or not acceptance_issue_id:
            return
        raw_report = await self.acceptance_runner.run_acceptance(
            original_issue=issue,
            acceptance_issue=acceptance_issue,
            completion_verdict=completion_verdict,
            workspace_path=workspace_path,
        )
        report = parse_acceptance_report(
            raw_report,
            minimum_score=self.config.acceptance.minimum_score,
            require_findings_for_score_3=self.config.acceptance.require_findings_for_score_3,
        )
        await self._comment_acceptance_report(acceptance_issue_id, _entry_for_issue(issue, workspace_path), report)
        if report.accepted:
            await self._transition_issue_by_state_name(acceptance_issue_id, self.config.acceptance.done_state)
            await self._transition_issue_by_state_name(issue.id, self.config.acceptance.done_state)
            await self._sync_label_group(issue.id, PHASE_LABELS["completed"], prefix="performer:phase/")
            self.state.completed.add(issue.id)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
            )
        else:
            await self._transition_issue_by_state_name(issue.id, self.config.acceptance.implementation_state)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.REWORKING,
                status="reworking",
                reason="acceptance_gate_failed",
            )

    async def _create_evidence_issue(
        self,
        issue: Issue,
        gate: dict[str, Any],
        report: AcceptanceReport,
        raw_report: str,
        workspace_path: str | None,
    ) -> dict[str, Any] | None:
        create_child = getattr(self.tracker, "create_child_issue_for", None)
        if not callable(create_child):
            return None
        return await create_child(
            parent_issue_id=str(gate.get("id") or ""),
            title=f"[Evidence] {issue.identifier}: {gate.get('title', 'Gate review')}",
            description=_evidence_issue_description(issue, gate, report, raw_report, workspace_path),
            label_names=[self.config.acceptance.evidence_type_label],
            delegate_id=issue.delegate_id,
        )

    async def _transition_issue_by_state_name(self, issue_id: str, state_name: str) -> None:
        transition = getattr(self.tracker, "transition_issue_by_state_name", None)
        if not callable(transition):
            return
        try:
            result = await transition(issue_id, state_name)
        except Exception as exc:
            logger.warning(
                "performer_transition outcome=failed issue_id=%s state=%s reason=%s",
                issue_id,
                state_name,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_transition outcome=failed issue_id=%s state=%s reason=linear_unsuccessful",
                issue_id,
                state_name,
            )

    async def _run_worker(self, issue: Issue, attempt: int | None, *, worker_host: str | None) -> None:
        def on_event(event: dict[str, Any]) -> None:
            self.on_codex_event(issue.id, event)

        logger.info(
            "performer_worker outcome=started issue_id=%s issue_identifier=%s session_id=%s attempt=%s",
            issue.id,
            issue.identifier,
            "-",
            attempt or 0,
        )
        try:
            result = await self.runner.run_issue(issue, attempt, on_event, worker_host=worker_host)
            entry = self.state.running.get(issue.id)
            structured_result = getattr(result, "structured_result", None)
            if entry is not None and isinstance(structured_result, dict):
                entry.structured_result = structured_result
        except asyncio.CancelledError:
            session_id = self._session_id_for_log(issue.id)
            logger.info(
                "performer_worker outcome=cancelled issue_id=%s issue_identifier=%s session_id=%s",
                issue.id,
                issue.identifier,
                session_id,
            )
            await self._finish_worker(issue.id, normal=False, error="cancelled")
            raise
        except Exception as exc:
            session_id = self._session_id_for_log(issue.id)
            error_code = getattr(exc, "code", None)
            http_status = getattr(exc, "http_status", None)
            logger.exception(
                "performer_worker outcome=failed issue_id=%s issue_identifier=%s session_id=%s reason=%s issue=%s",
                issue.id,
                issue.identifier,
                session_id,
                exc,
                issue.identifier,
            )
            await self._finish_worker(
                issue.id,
                normal=False,
                error=str(exc),
                error_code=error_code if isinstance(error_code, str) else None,
                http_status=http_status if isinstance(http_status, int) else None,
            )
        else:
            session_id = self._session_id_for_log(issue.id)
            logger.info(
                "performer_worker outcome=completed issue_id=%s issue_identifier=%s session_id=%s issue=%s",
                issue.id,
                issue.identifier,
                session_id,
                issue.identifier,
            )
            await self._finish_worker(issue.id, normal=True, error=None)

    async def _finish_worker(
        self,
        issue_id: str,
        *,
        normal: bool,
        error: str | None,
        error_code: str | None = None,
        http_status: int | None = None,
    ) -> None:
        entry = self.state.running.pop(issue_id, None)
        if not entry:
            return
        self.state.ended_runtime_seconds += max((utc_now() - entry.started_at).total_seconds(), 0)
        if normal:
            entry.runtime_phase = "implementation_done"
            # 🆕 完成验证
            try:
                from pathlib import Path

                ops_snapshot = self._load_ops_snapshot()
                workspace_path = self._completion_workspace_path(entry)
                if entry.structured_result is not None:
                    await self._publish_structured_result(entry)
                    if _structured_result_needs_human(entry.structured_result):
                        await self._create_human_intervention_for_entry(
                            entry,
                            kind="codex_needs_input",
                            attempt=max(entry.retry_attempt + 1, 1),
                            error=_structured_result_summary(entry.structured_result),
                            questions=_structured_result_questions(entry.structured_result),
                            resume_strategy="retry",
                        )
                        self._mark_codex_thread_terminal(entry, status="resume_pending")
                        return

                verdict = await self.completion_verifier.verify_completion(
                    entry.issue,
                    workspace_path,
                    ops_snapshot
                )

                if verdict.status == "VERIFIED":
                    refreshed_issue = await self._refresh_issue_after_completion(entry.issue)
                    if refreshed_issue is not None and self._is_active(refreshed_issue):
                        if self.config.acceptance.enabled:
                            if not _has_acceptance_evidence(refreshed_issue):
                                reason = "implementation_evidence_missing: agent must leave implementation summary, test command output, and remaining risks before review"
                                updated_issue = _issue_with_verification_context(entry.issue, verdict)
                                await self._comment_completion_verdict(entry, verdict, next_action="retry")
                                self._schedule_retry(
                                    updated_issue,
                                    max(entry.retry_attempt + 1, 1),
                                    error=reason,
                                    delay_ms=None,
                                )
                                await self._sync_label_group(
                                    updated_issue.id,
                                    PHASE_LABELS["implementation_running"],
                                    prefix="performer:phase/",
                                )
                                logger.warning(
                                    "performer_completion_review_blocked issue_id=%s reason=%s",
                                    issue_id,
                                    reason,
                                )
                                return
                            await self._sync_label_group(
                                refreshed_issue.id,
                                self.config.acceptance.gate_pending_label,
                                prefix="performer:gate/",
                            )
                            await self._sync_label_group(
                                refreshed_issue.id,
                                self.config.acceptance.implementation_phase_label,
                                prefix="performer:phase/",
                            )
                            await self._transition_issue_by_state_name(
                                refreshed_issue.id,
                                self.config.acceptance.review_state,
                            )
                            self.state.claimed.discard(issue_id)
                            self.state.retry_attempts.pop(issue_id, None)
                            self.phase_runtime.record_outcome(
                                issue_id,
                                next_phase=RunPhase.REVIEWING,
                                status="reviewing",
                                reason="implementation_ready_for_review",
                            )
                            logger.info("performer_completion_verified_review issue_id=%s", issue_id)
                            self._persist_state()
                            return
                        else:
                            if self.config.completion_verification.enabled and verdict.checks:
                                await self._transition_issue_by_state_name(
                                    refreshed_issue.id,
                                    self.config.acceptance.done_state,
                                )
                                self.state.completed.add(issue_id)
                                self.state.claimed.discard(issue_id)
                                self.state.retry_attempts.pop(issue_id, None)
                                await self._sync_label_group(
                                    refreshed_issue.id,
                                    PHASE_LABELS["completed"],
                                    prefix="performer:phase/",
                                )
                                self.phase_runtime.record_outcome(
                                    issue_id,
                                    next_phase=RunPhase.DONE,
                                    status="completed",
                                    reason="completed_by_runtime",
                                )
                                logger.info(
                                    "performer_completion_verified_done issue_id=%s reason=%s previous_state=%s",
                                    issue_id,
                                    verdict.reason,
                                    refreshed_issue.state,
                                )
                            else:
                                logger.info(
                                    "performer_completion_verified_continuing issue_id=%s reason=%s state=%s",
                                    issue_id,
                                    verdict.reason,
                                    refreshed_issue.state,
                                )
                                self._schedule_continuation(
                                    refreshed_issue,
                                    max(entry.retry_attempt + 1, 1),
                                    delay_ms=1_000,
                                    last_message=verdict.reason,
                                )
                    elif refreshed_issue is not None and self._is_terminal(refreshed_issue):
                        if self.config.acceptance.enabled:
                            await self._handle_direct_done_bypass(refreshed_issue)
                            self.state.claimed.discard(issue_id)
                            self.state.retry_attempts.pop(issue_id, None)
                            logger.info("performer_acceptance_direct_done_handled issue_id=%s", issue_id)
                            self._persist_state()
                            return
                        self.state.completed.add(issue_id)
                        self.state.claimed.discard(issue_id)
                        self.state.retry_attempts.pop(issue_id, None)
                        await self._sync_label_group(entry.issue.id, PHASE_LABELS["completed"], prefix="performer:phase/")
                        self.phase_runtime.record_outcome(
                            issue_id,
                            next_phase=RunPhase.DONE,
                            status="completed",
                            reason="completed_by_runtime",
                        )
                        logger.info(f"performer_completion_verified issue_id={issue_id} reason={verdict.reason}")
                    elif refreshed_issue is not None:
                        await self._comment_handoff_preserved(entry, refreshed_issue)
                        self.state.claimed.discard(issue_id)
                        self.state.retry_attempts.pop(issue_id, None)
                        self.phase_runtime.record_outcome(
                            issue_id,
                            next_phase=RunPhase.REVIEWING,
                            status="reviewing",
                            reason="implementation_handed_off",
                        )
                    else:
                        self._schedule_continuation(
                            entry.issue,
                            max(entry.retry_attempt + 1, 1),
                            delay_ms=1_000,
                            last_message="completion state refresh failed; continuing",
                        )

                elif verdict.status == "NEEDS_RETRY":
                    # 验证失败，需要重试
                    if self.config.completion_verification.auto_retry_on_fail:
                        logger.warning(f"performer_completion_verification_failed issue_id={issue_id} reason={verdict.reason}")
                        updated_issue = _issue_with_verification_context(entry.issue, verdict)
                        await self._comment_completion_verdict(entry, verdict, next_action="retry")
                        next_attempt = max(entry.retry_attempt + 1, 1)
                        self._schedule_retry(
                            updated_issue,
                            next_attempt,
                            error=f"verification_failed: {verdict.reason}",
                            delay_ms=None
                        )
                        await self._sync_label_group(updated_issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
                    else:
                        # 不自动重试，标记失败并等待人工介入
                        logger.error(f"performer_completion_verification_failed_no_retry issue_id={issue_id}")
                        await self._comment_completion_verdict(entry, verdict, next_action="human_review")
                        self.state.claimed.discard(issue_id)
                        self.state.retry_attempts.pop(issue_id, None)
                        await self._sync_label_group(entry.issue.id, PHASE_LABELS["failed"], prefix="performer:phase/")
                        self.phase_runtime.record_outcome(
                            issue_id,
                            next_phase=RunPhase.FAILED,
                            status="failed",
                            reason=f"verification_failed: {verdict.reason}",
                        )

                else:  # NEEDS_HUMAN
                    # 需要人工审查，不自动标记完成
                    logger.error(f"performer_completion_needs_human_review issue_id={issue_id} reason={verdict.reason}")
                    await self._comment_completion_verdict(entry, verdict, next_action="human_review")
                    if self.config.acceptance.enabled:
                        refreshed_issue = await self._refresh_issue_after_completion(entry.issue)
                        review_issue = refreshed_issue or entry.issue
                        if not _has_acceptance_evidence(review_issue):
                            reason = "implementation_evidence_missing: agent must leave implementation summary, test command output, and remaining risks before review"
                            updated_issue = _issue_with_verification_context(entry.issue, verdict)
                            self._schedule_retry(
                                updated_issue,
                                max(entry.retry_attempt + 1, 1),
                                error=reason,
                                delay_ms=None,
                            )
                            await self._sync_label_group(
                                updated_issue.id,
                                PHASE_LABELS["implementation_running"],
                                prefix="performer:phase/",
                            )
                            return
                        await self._sync_label_group(
                            review_issue.id,
                            self.config.acceptance.gate_pending_label,
                            prefix="performer:gate/",
                        )
                        await self._sync_label_group(
                            review_issue.id,
                            self.config.acceptance.implementation_phase_label,
                            prefix="performer:phase/",
                        )
                        await self._transition_issue_by_state_name(
                            review_issue.id,
                            self.config.acceptance.review_state,
                        )
                        await self._run_acceptance_gate_for_issue(
                            review_issue,
                            completion_verdict=verdict,
                            workspace_path=entry.workspace_path,
                        )
                    else:
                        await self._create_human_intervention_for_entry(
                            entry,
                            kind="verification_needs_human",
                            attempt=max(entry.retry_attempt + 1, 1),
                            error=f"verification_needs_human: {verdict.reason}",
                            questions=[str(verdict.reason)],
                            resume_strategy="retry",
                        )
                    self.state.claimed.discard(issue_id)
                    self.state.retry_attempts.pop(issue_id, None)
                    if not self.config.acceptance.enabled:
                        await self._sync_label_group(entry.issue.id, PHASE_LABELS["failed"], prefix="performer:phase/")
                        self.phase_runtime.record_outcome(
                            issue_id,
                            next_phase=RunPhase.AWAITING_HUMAN,
                            status="awaiting_human",
                            reason=f"verification_needs_human: {verdict.reason}",
                        )

            except Exception as exc:
                # 验证器本身异常也不能直接放行为完成
                logger.exception(f"performer_completion_verification_error issue_id={issue_id} error={exc}")
                self.state.claimed.discard(issue_id)
                await self._comment_completion_verification_error(entry, str(exc))
                next_attempt = max(entry.retry_attempt + 1, 1)
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="verification_needs_human",
                    attempt=next_attempt,
                    error=f"verification_error: {exc}",
                    resume_strategy="retry",
                )
        else:
            next_attempt = max(entry.retry_attempt + 1, 1)
            retry_error = f"worker exited: {error}"
            self._mark_codex_thread_terminal(entry, status="failed")
            if _is_codex_init_error_code(error_code):
                self.state.claimed.discard(issue_id)
                self.state.retry_attempts.pop(issue_id, None)
                self.state.continuations.pop(issue_id, None)
                self.phase_runtime.record_outcome(
                    issue_id,
                    next_phase=RunPhase.QUEUED,
                    status="init_failed",
                    reason=error_code or "codex_init_failed",
                    retry_delay_seconds=5,
                )
                await self._sync_label_group(entry.issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
            elif error_code == "upstream_overloaded_exhausted":
                self.state.claimed.discard(issue_id)
                self.state.retry_attempts.pop(issue_id, None)
                self.state.continuations.pop(issue_id, None)
                self.phase_runtime.record_outcome(
                    issue_id,
                    next_phase=RunPhase.QUEUED,
                    status="upstream_overloaded",
                    reason=error_code,
                    retry_delay_seconds=5,
                    detail=error,
                    http_status=http_status,
                )
                await self._sync_label_group(entry.issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
            elif entry.human_blocked_reason:
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="runtime_permission",
                    attempt=next_attempt,
                    error=entry.human_blocked_reason,
                    resume_strategy="retry",
                )
                await self._sync_label_group(entry.issue.id, PHASE_LABELS["blocked"], prefix="performer:phase/")
            else:
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="runtime_error",
                    attempt=next_attempt,
                    error=retry_error,
                    resume_strategy="retry",
                )
        self._persist_state()

    def _gate_planner(self) -> GatePlannerProtocol:
        if self.config.acceptance.gate_planner_mode == "smoke":
            return SmokeGatePlanner()
        return CodexGatePlanner(self.config)

    def _completion_workspace_path(self, entry: RunningEntry):
        from pathlib import Path

        if entry.workspace_path:
            return Path(entry.workspace_path)
        if self.workspace_manager is not None:
            return self.workspace_manager.config.root
        return self.config.workspace.root

    async def _refresh_issue_after_completion(self, issue: Issue) -> Issue | None:
        try:
            refreshed = await self.tracker.fetch_issue_states_by_ids([issue.id])
        except Exception as exc:
            logger.warning(
                "performer_completion_state_refresh outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                issue.id,
                issue.identifier,
                exc,
            )
            return None
        for current in refreshed:
            if current.id == issue.id:
                return current
        return issue

    async def _comment_worker_failure(self, entry: RunningEntry, error: str, next_attempt: int) -> None:
        if self.config.tracker.kind != "linear" or error == "worker exited: cancelled":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _failure_comment_body(entry, error, next_attempt)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_worker_failure_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_worker_failure_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    async def _comment_completion_verdict(self, entry: RunningEntry, verdict: Any, *, next_action: str) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _completion_verdict_comment_body(entry, verdict, next_action=next_action)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_completion_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_completion_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    async def _publish_structured_result(self, entry: RunningEntry) -> None:
        result = entry.structured_result
        if self.config.tracker.kind != "linear" or not isinstance(result, dict):
            return
        block = _structured_result_evidence_block(result)
        update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
        if callable(update_description):
            await update_description(entry.issue.id, "PERFORMER IMPLEMENTATION EVIDENCE", block)
        else:
            update_issue = getattr(self.tracker, "update_issue_description", None)
            if callable(update_issue):
                await update_issue(entry.issue.id, _description_with_structured_result(entry.issue.description or "", result))
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if callable(comment_issue):
            await comment_issue(entry.issue.id, _structured_result_comment_body(entry, result))

    async def _comment_completion_verification_error(self, entry: RunningEntry, error: str) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _completion_verification_error_comment_body(entry, error)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_completion_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_completion_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    async def _comment_handoff_preserved(self, entry: RunningEntry, refreshed_issue: Issue) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _handoff_preserved_comment_body(entry, refreshed_issue)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_handoff_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_handoff_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    async def _create_acceptance_gate(self, entry: RunningEntry, verdict: Any) -> None:
        await self._run_acceptance_gate_for_issue(
            entry.issue,
            completion_verdict=verdict,
            workspace_path=entry.workspace_path,
        )

    async def _comment_acceptance_report(
        self,
        acceptance_issue_id: str,
        entry: RunningEntry,
        report: AcceptanceReport,
    ) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _acceptance_report_comment_body(entry, report)
        try:
            result = await comment_issue(acceptance_issue_id, body)
        except Exception as exc:
            logger.warning(
                "performer_acceptance_comment outcome=failed issue_id=%s acceptance_issue_id=%s reason=%s",
                entry.issue.id,
                acceptance_issue_id,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_acceptance_comment outcome=failed issue_id=%s acceptance_issue_id=%s reason=linear_unsuccessful",
                entry.issue.id,
                acceptance_issue_id,
            )

    async def _comment_policy_violation(self, issue: Issue, *, has_evidence: bool) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _policy_violation_comment_body(issue, has_evidence=has_evidence)
        try:
            result = await comment_issue(issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_policy_violation_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                issue.id,
                issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_policy_violation_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                issue.id,
                issue.identifier,
            )

    def _schedule_retry(self, issue: Issue, attempt: int, *, error: str | None, delay_ms: int | None) -> None:
        if error is None:
            self._schedule_continuation(issue, attempt, delay_ms=delay_ms)
            return
        if delay_ms is None:
            delay_ms = min(10_000 * (2 ** max(attempt - 1, 0)), self.config.agent.max_retry_backoff_ms)
        due_at = utc_now() + timedelta(milliseconds=delay_ms)
        due_at_ms = monotonic_ms() + delay_ms
        self.state.claimed.add(issue.id)
        self.state.continuations.pop(issue.id, None)
        self.state.blocked.pop(issue.id, None)
        retry_context = _retry_context_from_issue(issue)
        self.state.retry_attempts[issue.id] = RetryEntry(
            issue_id=issue.id,
            identifier=issue.identifier,
            attempt=attempt,
            due_at=due_at,
            due_at_ms=due_at_ms,
            error=error,
            issue_url=issue.url,
            phase="retry_pending",
            status_label=PHASE_LABELS["implementation_running"],
            runtime_phase="failed",
            last_message=retry_context or error,
        )
        self.phase_runtime.record_outcome(
            issue.id,
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason=error,
            retry_delay_seconds=_retry_delay_seconds(self.state.retry_attempts[issue.id]),
        )
        self._sync_label_group_background(issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
        self._persist_state()

    def _schedule_blocked(self, entry: RunningEntry, *, error: str, attempt: int) -> None:
        self.state.claimed.add(entry.issue.id)
        self.state.retry_attempts.pop(entry.issue.id, None)
        self.state.continuations.pop(entry.issue.id, None)
        self.state.human_interventions.pop(entry.issue.id, None)
        self.state.blocked[entry.issue.id] = BlockedEntry(
            issue_id=entry.issue.id,
            identifier=entry.issue.identifier,
            attempt=attempt,
            blocked_at=utc_now(),
            error=error,
            issue_url=entry.issue.url,
            phase="human_blocked",
            status_label=PHASE_LABELS["blocked"],
            runtime_phase="failed",
            last_message=entry.last_codex_message or error,
            recent_events=list(entry.recent_events),
        )
        self.phase_runtime.record_outcome(
            entry.issue.id,
            next_phase=RunPhase.FAILED,
            status="failed",
            reason=error,
        )
        self._sync_label_group_background(entry.issue.id, PHASE_LABELS["blocked"], prefix="performer:phase/")
        self._persist_state()

    async def _create_human_intervention_for_entry(
        self,
        entry: RunningEntry,
        *,
        kind: str,
        attempt: int,
        error: str | None,
        questions: list[str] | None = None,
        resume_strategy: str,
    ) -> HumanInterventionEntry | None:
        return await self._create_human_intervention(
            entry.issue,
            kind=kind,
            attempt=attempt,
            error=error,
            questions=questions or [],
            resume_strategy=resume_strategy,
            last_message=entry.last_codex_message or error,
            recent_events=list(entry.recent_events),
        )

    async def _create_human_intervention(
        self,
        issue: Issue,
        *,
        kind: str,
        attempt: int,
        error: str | None,
        questions: list[str] | None = None,
        resume_strategy: str,
        last_message: str | None = None,
        recent_events: list[dict[str, Any]] | None = None,
    ) -> HumanInterventionEntry | None:
        create_child = getattr(self.tracker, "create_child_issue_for", None)
        if not callable(create_child):
            self._schedule_retry(issue, max(attempt, 1), error=error or "human intervention required", delay_ms=None)
            return None
        labels = [
            HUMAN_INTERVENTION_LABELS["type"],
        ]
        title = _human_intervention_title(issue, kind)
        description = _human_intervention_description(
            issue,
            kind=kind,
            error=error,
            questions=questions or [],
            last_message=last_message,
            http_status=None,
        )
        try:
            child = await create_child(
                parent_issue_id=issue.id,
                title=title,
                description=description,
                label_names=labels,
                assignee_id=issue.assignee_id,
            )
        except Exception as exc:
            logger.warning(
                "performer_human_intervention_create failed issue_id=%s issue_identifier=%s kind=%s reason=%s",
                issue.id,
                issue.identifier,
                kind,
                exc,
            )
            self._schedule_retry(issue, max(attempt, 1), error=error or "human intervention creation failed", delay_ms=None)
            return None
        child_issue_id = str(child.get("id") or "")
        if not child_issue_id:
            return None
        intervention = HumanInterventionEntry(
            issue_id=issue.id,
            identifier=issue.identifier,
            child_issue_id=child_issue_id,
            child_identifier=str(child.get("identifier") or "") or None,
            child_url=str(child.get("url") or "") or None,
            kind=kind,
            attempt=attempt,
            created_at=utc_now(),
            error=error,
            questions=list(questions or []),
            resume_strategy=resume_strategy,
            issue_url=issue.url,
            last_message=last_message,
            recent_events=list(recent_events or []),
        )
        self.state.claimed.add(issue.id)
        self.state.retry_attempts.pop(issue.id, None)
        self.state.continuations.pop(issue.id, None)
        self.state.blocked.pop(issue.id, None)
        self.state.human_interventions[issue.id] = intervention
        self.phase_runtime.record_outcome(
            issue.id,
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason=intervention.error or "awaiting human action",
            human_action={
                "child_issue_id": intervention.child_issue_id,
                "child_identifier": intervention.child_identifier,
                "child_url": intervention.child_url,
                "kind": intervention.kind,
                "questions": list(intervention.questions or []),
            },
        )
        await self._sync_label_group(issue.id, PHASE_LABELS["blocked"], prefix="performer:phase/")
        self._persist_state()
        return intervention

    async def _resolve_human_intervention(self, intervention: HumanInterventionEntry, *, response: str | None) -> None:
        self.state.human_interventions.pop(intervention.issue_id, None)
        self.state.blocked.pop(intervention.issue_id, None)
        issue = Issue(
            id=intervention.issue_id,
            identifier=intervention.identifier,
            title=intervention.identifier,
            state=self.config.tracker.active_states[0] if self.config.tracker.active_states else "",
            url=intervention.issue_url,
            project_slug=self.config.tracker.project_slug,
        )
        if response:
            await self._write_human_response_to_parent(intervention, response)
        await self._sync_label_group(issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
        if intervention.resume_strategy == "preflight":
            self.state.claimed.discard(issue.id)
            self._persist_state()
            return
        self._schedule_retry(
            issue,
            max(intervention.attempt, 1),
            error=_human_resume_error(intervention, response),
            delay_ms=0,
        )

    async def _write_human_response_to_parent(self, intervention: HumanInterventionEntry, response: str) -> None:
        update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
        if not callable(update_description):
            return
        block = "\n".join(
            [
                f"Human action: {intervention.child_identifier or intervention.child_issue_id}",
                f"Type: {intervention.kind}",
                "",
                response.strip(),
            ]
        )
        await update_description(intervention.issue_id, HUMAN_RESPONSE_MARKER_NAME, block)

    async def _comment_missing_human_response(self, intervention: HumanInterventionEntry) -> None:
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        await comment_issue(
            intervention.child_issue_id,
            "This human action is marked Done, but the `Human response` section is empty. Add the response there, then keep this child issue in Done.",
        )

    def _schedule_continuation(
        self,
        issue: Issue,
        attempt: int,
        *,
        delay_ms: int | None,
        last_message: str | None = None,
    ) -> None:
        if delay_ms is None:
            delay_ms = self.config.polling.interval_ms
        due_at = utc_now() + timedelta(milliseconds=delay_ms)
        due_at_ms = monotonic_ms() + delay_ms
        self.state.claimed.add(issue.id)
        self.state.retry_attempts.pop(issue.id, None)
        self.state.blocked.pop(issue.id, None)
        self.state.human_interventions.pop(issue.id, None)
        self.state.continuations[issue.id] = ContinuationEntry(
            issue_id=issue.id,
            identifier=issue.identifier,
            attempt=attempt,
            due_at=due_at,
            due_at_ms=due_at_ms,
            issue_url=issue.url,
            last_message=last_message or _retry_context_from_issue(issue),
        )
        self.phase_runtime.record_outcome(
            issue.id,
            next_phase=RunPhase.QUEUED,
            status="accepted",
            reason=self.state.continuations[issue.id].last_message,
            retry_delay_seconds=_retry_delay_seconds(self.state.continuations[issue.id]),
        )
        self._sync_label_group_background(issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
        self._persist_state()

    def _load_ops_snapshot(self):
        """加载当前的 ops snapshot"""
        try:
            from performer_api.ops_store import OpsStore
            from performer_api.persistence import ops_snapshot_path_from_persistence_path

            ops_path = ops_snapshot_path_from_persistence_path(self.config.persistence.path)
            if not ops_path.exists():
                # 文件不存在，返回空 snapshot
                from performer_api.ops_models import OpsSnapshot
                return OpsSnapshot()
            store = OpsStore(ops_path)
            return store.load()
        except Exception as e:
            # 任何异常都返回空 snapshot，不阻塞完成流程
            logger.warning(f"Failed to load ops snapshot: {e}, using empty snapshot")
            from performer_api.ops_models import OpsSnapshot
            return OpsSnapshot()

    async def reconcile_running(self) -> None:
        await self._reconcile_stalled()
        running_ids = list(self.state.running.keys())
        if not running_ids:
            return
        try:
            refreshed = await self.tracker.fetch_issue_states_by_ids(running_ids)
        except Exception as exc:
            logger.warning("performer_reconcile failed reason=%s", exc)
            return
        by_id = {issue.id: issue for issue in refreshed}
        for issue_id in running_ids:
            entry = self.state.running.get(issue_id)
            if not entry:
                continue
            refreshed_issue = by_id.get(issue_id)
            if not refreshed_issue:
                await self._terminate_running(issue_id, retry=False)
                continue
            if self._is_terminal(refreshed_issue):
                if self.config.acceptance.enabled:
                    entry.issue = refreshed_issue
                    self._persist_state()
                    continue
                await self._sync_label_group(issue_id, PHASE_LABELS["completed"], prefix="performer:phase/")
                await self._terminate_running(issue_id, retry=False, cleanup_workspace=True, ops_status="completed")
            elif self._is_run_eligible(refreshed_issue):
                entry.issue = refreshed_issue
                self._persist_state()
            else:
                await self._comment_handoff_preserved(entry, refreshed_issue)
                await self._terminate_running(issue_id, retry=False)

    async def _reconcile_stalled(self) -> None:
        stall_timeout_ms = self.config.codex.stall_timeout_ms
        hard_turn_timeout_ms = self.config.codex.hard_turn_timeout_ms
        if stall_timeout_ms <= 0 and hard_turn_timeout_ms <= 0:
            return
        now = utc_now()
        for issue_id, entry in list(self.state.running.items()):
            if hard_turn_timeout_ms > 0:
                turn_started_at = entry.turn_started_at or entry.started_at
                if (now - turn_started_at).total_seconds() * 1000 > hard_turn_timeout_ms:
                    await self._terminate_running(issue_id, retry=True, failure_reason="turn_timeout")
                    continue
            if stall_timeout_ms > 0:
                since = entry.last_codex_timestamp or entry.started_at
                if (now - since).total_seconds() * 1000 > stall_timeout_ms:
                    await self._terminate_running(issue_id, retry=True, failure_reason="stalled")

    async def _terminate_running(
        self,
        issue_id: str,
        *,
        retry: bool,
        cleanup_workspace: bool = False,
        ops_status: str | None = None,
        failure_reason: str = "stalled",
    ) -> None:
        entry = self.state.running.pop(issue_id, None)
        if not entry:
            return
        task = entry.task
        if task and not task.done():
            task.cancel()
        if ops_status is not None:
            self._finish_open_ops_for_issue(
                issue_id,
                status=ops_status,
                failure_summary=None if ops_status == "completed" else ops_status,
            )
        self.state.claimed.discard(issue_id)
        if cleanup_workspace and self.workspace_manager is not None:
            await self.workspace_manager.remove_for_issue(entry.issue.identifier)
        if retry:
            self._finish_open_ops_for_issue(issue_id, status="failed", failure_summary=failure_reason)
            next_attempt = max(entry.retry_attempt + 1, 1)
            await self._create_human_intervention_for_entry(
                entry,
                kind="runtime_error",
                attempt=next_attempt,
                error=failure_reason,
                resume_strategy="retry",
            )
            self.phase_runtime.record_outcome(
                issue_id,
                next_phase=RunPhase.QUEUED,
                status="retry",
                reason=failure_reason,
                retry_delay_seconds=5,
            )
        self._persist_state()

    def _finish_open_ops_for_issue(self, issue_id: str, *, status: str, failure_summary: str | None) -> None:
        persistence_path = self.config.persistence.path
        if persistence_path is None:
            return
        recorder = ExecutionTelemetryRecorder(OpsStore(ops_snapshot_path_from_persistence_path(persistence_path)))
        recorder.finish_latest_open_for_issue(
            issue_id,
            status=status,
            failure_code=None if status == "completed" else status,
            failure_summary=failure_summary,
        )

    def _record_repository_handoff_after_acceptance(self, issue: Issue, *, workspace_path: str | None) -> None:
        if not self.config.repository_handoff.enabled or self.config.persistence.path is None:
            return
        if self._repository_handoff_report_exists(issue.id):
            return
        candidate = Path(workspace_path) if workspace_path else self.config.workspace.root
        try:
            report = build_repository_handoff_report(
                issue_id=issue.id,
                issue_identifier=issue.identifier,
                workspace_path=candidate,
                structured_result=_structured_result_from_issue_description(issue.description or ""),
                bundle_root=self._repository_handoff_bundle_root(),
            )
        except Exception as exc:
            logger.exception("performer_repository_handoff_report_failed issue_id=%s reason=%s", issue.id, exc)
            return
        recorder = ExecutionTelemetryRecorder(OpsStore(ops_snapshot_path_from_persistence_path(self.config.persistence.path)))
        recorder.record_repository_handoff_report(report)

    def _repository_handoff_report_exists(self, issue_id: str) -> bool:
        if self.config.persistence.path is None:
            return False
        snapshot = OpsStore(ops_snapshot_path_from_persistence_path(self.config.persistence.path)).load()
        return any(
            event.event_type == "repository_handoff_report.v1" and event.issue_id == issue_id
            for event in snapshot.events
        )

    def _repository_handoff_bundle_root(self) -> Path:
        configured = self.config.repository_handoff.bundle_root
        if configured is not None:
            return configured
        if self.config.persistence.path is not None:
            return self.config.persistence.path.parent / "handoffs"
        return self.config.workspace.root.parent / ".symphony-handoffs"

    def on_codex_event(self, issue_id: str, event: dict[str, Any]) -> None:
        entry = self.state.running.get(issue_id)
        if not entry:
            return
        session_id = event.get("session_id")
        if isinstance(session_id, str) and session_id:
            entry.session_id = session_id
        thread_id = event.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            entry.thread_id = thread_id
        turn_id = event.get("turn_id")
        if isinstance(turn_id, str) and turn_id:
            entry.turn_id = turn_id
        cwd = event.get("cwd")
        if isinstance(cwd, str) and cwd:
            entry.workspace_path = cwd
        entry.last_codex_event = event.get("event")
        raw_message = event.get("message") or event.get("raw_method") or event.get("method")
        entry.last_raw_codex_message = str(raw_message) if raw_message is not None else None
        message = _status_message_from_event(event)
        if message is not None:
            entry.last_codex_message = message
        entry.last_codex_timestamp = utc_now()
        if event.get("event") == "turn_completed":
            entry.turn_count += 1
        blocked_reason = _human_blocked_runtime_reason(entry, event) if _event_can_signal_human_block(event) else None
        if blocked_reason and entry.human_blocked_reason is None:
            entry.human_blocked_reason = blocked_reason
            entry.phase = "error"
            entry.status_label = PHASE_LABELS["blocked"]
            entry.runtime_phase = "failed"
            self._sync_label_group_background(entry.issue.id, PHASE_LABELS["blocked"], prefix="performer:phase/")
            self._comment_runtime_error_background(entry, event)
            if entry.task is not None and not entry.task.done():
                entry.task.cancel()
        self._apply_phase_from_event(entry, event)
        self._append_recent_event(entry, event)
        logger.info(
            "performer_codex_event issue_id=%s issue_identifier=%s session_id=%s event=%s raw_method=%s message=%s",
            issue_id,
            entry.issue.identifier,
            entry.session_id or "-",
            event.get("event") or "-",
            event.get("raw_method") or event.get("method") or "-",
            _log_message(event.get("message") or event.get("tool_name") or ""),
        )
        rate_limits = self._extract_rate_limits(event)
        if rate_limits is not None:
            self.state.codex_rate_limits = rate_limits
        tokens = self._extract_absolute_tokens(event)
        if tokens is not None:
            self._apply_absolute_tokens(entry, tokens)
        self._apply_codex_thread_event(entry, event)
        self._persist_state()

    def _apply_codex_thread_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        if self.config.codex.backend != "sdk":
            return
        thread_id = event.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            return
        status = "active"
        if event.get("event") == "turn_completed":
            status = "completed"
        elif event.get("event") in {"turn_failed", "turn_cancelled", "turn_ended_with_error"}:
            status = "failed"
        final_response = event.get("message") if event.get("event") == "turn_completed" else None
        self.state.codex_threads[entry.issue.id] = CodexThreadEntry(
            issue_id=entry.issue.id,
            thread_id=thread_id,
            backend="sdk",
            workspace_path=entry.workspace_path or str(self.config.workspace.root),
            last_turn_id=entry.turn_id,
            status=status,
            last_final_response=final_response if isinstance(final_response, str) else None,
            updated_at=utc_now(),
        )

    def _mark_codex_thread_terminal(self, entry: RunningEntry, *, status: str) -> None:
        if self.config.codex.backend != "sdk" or not entry.thread_id:
            return
        self.state.codex_threads[entry.issue.id] = CodexThreadEntry(
            issue_id=entry.issue.id,
            thread_id=entry.thread_id,
            backend="sdk",
            workspace_path=entry.workspace_path or str(self.config.workspace.root),
            last_turn_id=entry.turn_id,
            status=status,
            last_final_response=None,
            updated_at=utc_now(),
        )

    def _set_running_phase(self, issue_id: str, phase: str, *, runtime_phase: str | None = None) -> None:
        entry = self.state.running.get(issue_id)
        if entry is None:
            return
        entry.phase = phase
        entry.status_label = PHASE_LABELS.get(phase, PHASE_LABELS["implementation_running"])
        if runtime_phase is not None:
            entry.runtime_phase = runtime_phase

    def _apply_phase_from_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        event_name = event.get("event")
        if event_name in {"process_launch", "session_started"}:
            entry.phase = "starting"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "dispatch_received"
        elif event_name == "turn_started":
            if entry.human_blocked_reason:
                return
            entry.phase = "running"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "implementation_running"
            entry.turn_started_at = utc_now()
            self._sync_label_group_background(entry.issue.id, PHASE_LABELS["implementation_running"], prefix="performer:phase/")
        elif event_name in {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
            was_error = entry.phase == "error"
            entry.phase = "error"
            entry.status_label = PHASE_LABELS["failed"]
            entry.runtime_phase = "failed"
            if not was_error:
                self._sync_label_group_background(entry.issue.id, PHASE_LABELS["failed"], prefix="performer:phase/")
                self._comment_runtime_error_background(entry, event)
            if entry.human_blocked_reason and entry.task is not None and not entry.task.done():
                entry.task.cancel()
        elif event_name == "turn_completed":
            if entry.human_blocked_reason:
                return
            entry.phase = "running"
            entry.status_label = PHASE_LABELS["implementation_running"]
            entry.runtime_phase = "implementation_done"

    def _append_recent_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        row = {
            "at": entry.last_codex_timestamp.astimezone().isoformat()
            if entry.last_codex_timestamp is not None
            else None,
            "event": event.get("event"),
            "message": entry.last_codex_message,
            "raw_method": event.get("raw_method") or event.get("method"),
            "usage": event.get("usage") or self._usage_row_from_tokens(self._extract_absolute_tokens(event)),
            "command": _command_from_event(event),
            "exit_code": _exit_code_from_event(event),
            "raw_event": dict(event),
        }
        entry.recent_events.append(row)
        if len(entry.recent_events) > 20:
            del entry.recent_events[:-20]

    def _usage_row_from_tokens(self, tokens: RuntimeTokens | None) -> dict[str, int] | None:
        if tokens is None:
            return None
        return {
            "input_tokens": tokens.input_tokens,
            "output_tokens": tokens.output_tokens,
            "cached_tokens": tokens.cached_tokens,
            "total_tokens": tokens.total_tokens,
        }

    def _sync_lifecycle_label_background(self, issue_id: str, label_name: str) -> None:
        if not self.config.tracker.lifecycle_labels_enabled:
            return
        self._desired_lifecycle_labels[issue_id] = label_name
        self._track_background_label_task(
            self._sync_lifecycle_label(issue_id, label_name, only_if_current=True)
        )

    def _sync_label_group_background(self, issue_id: str, label_name: str, *, prefix: str) -> None:
        if not self.config.tracker.lifecycle_labels_enabled:
            return
        self._desired_lifecycle_labels[issue_id] = label_name
        self._track_background_label_task(self._sync_label_group(issue_id, label_name, prefix=prefix))

    def _comment_runtime_error_background(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        self._track_background_label_task(self._comment_runtime_error(entry, event))

    def _track_background_label_task(self, coro: Any) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                coro.close()
            except AttributeError:
                pass
            return
        task = loop.create_task(coro)
        self._background_label_tasks.add(task)

        def _done(done: asyncio.Task[Any]) -> None:
            self._background_label_tasks.discard(done)
            try:
                done.result()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("performer_background_label_task outcome=failed reason=%s", exc)

        task.add_done_callback(_done)

    async def _comment_runtime_error(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        if self.config.tracker.kind != "linear":
            return
        comment_issue = getattr(self.tracker, "comment_issue", None)
        if not callable(comment_issue):
            return
        body = _runtime_error_comment_body(entry, event)
        try:
            result = await comment_issue(entry.issue.id, body)
        except Exception as exc:
            logger.warning(
                "performer_runtime_error_comment outcome=failed issue_id=%s issue_identifier=%s reason=%s",
                entry.issue.id,
                entry.issue.identifier,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_runtime_error_comment outcome=failed issue_id=%s issue_identifier=%s reason=linear_unsuccessful",
                entry.issue.id,
                entry.issue.identifier,
            )

    async def _sync_lifecycle_label(
        self, issue_id: str, label_name: str, *, only_if_current: bool = False
    ) -> None:
        if not self.config.tracker.lifecycle_labels_enabled:
            return
        if only_if_current:
            if self._desired_lifecycle_labels.get(issue_id) != label_name:
                return
        else:
            self._desired_lifecycle_labels[issue_id] = label_name
        if self.config.tracker.kind != "linear":
            return
        set_label = getattr(self.tracker, "set_issue_lifecycle_label", None)
        if not callable(set_label):
            return
        try:
            result = await set_label(issue_id, label_name)
        except Exception as exc:
            logger.warning(
                "performer_lifecycle_label outcome=failed issue_id=%s label=%s reason=%s",
                issue_id,
                label_name,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_lifecycle_label outcome=failed issue_id=%s label=%s reason=linear_unsuccessful",
                issue_id,
                label_name,
            )

    async def _sync_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> None:
        if self.config.tracker.kind != "linear":
            return
        set_label_group = getattr(self.tracker, "set_issue_label_group", None)
        if not callable(set_label_group):
            await self._sync_lifecycle_label(issue_id, label_name)
            return
        try:
            result = await set_label_group(issue_id, label_name, prefix=prefix)
        except Exception as exc:
            logger.warning(
                "performer_label_group outcome=failed issue_id=%s label=%s prefix=%s reason=%s",
                issue_id,
                label_name,
                prefix,
                exc,
            )
            return
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "performer_label_group outcome=failed issue_id=%s label=%s prefix=%s reason=linear_unsuccessful",
                issue_id,
                label_name,
                prefix,
            )

    async def wait_for_idle(self) -> None:
        tasks = list(self._worker_tasks)
        for entry in self.state.running.values():
            if entry.task is not None and entry.task not in tasks:
                tasks.append(entry.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        while self._background_label_tasks:
            pending = list(self._background_label_tasks)
            await asyncio.gather(*pending, return_exceptions=True)
            for task in pending:
                self._background_label_tasks.discard(task)

    def _is_active(self, issue: Issue) -> bool:
        active = {normalize_state_key(state) for state in self.config.tracker.active_states}
        terminal = {normalize_state_key(state) for state in self.config.tracker.terminal_states}
        return issue.state_key() in active and issue.state_key() not in terminal

    def _is_terminal(self, issue: Issue) -> bool:
        terminal = {normalize_state_key(state) for state in self.config.tracker.terminal_states}
        return issue.state_key() in terminal

    def _matches_required_delegate(self, issue: Issue) -> bool:
        configured = self.config.tracker.required_delegate_id
        if not configured:
            return True
        return issue.delegate_id == configured

    def _is_run_eligible(self, issue: Issue) -> bool:
        if not self._is_active(issue):
            return False
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return False
        if not self._matches_required_delegate(issue):
            return False
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return False
        return True

    def _available_state_slots(self, state: str) -> int:
        state_key = normalize_state_key(state)
        limit = self.config.agent.max_concurrent_agents_by_state.get(
            state_key, self.config.agent.max_concurrent_agents
        )
        running_count = sum(1 for entry in self.state.running.values() if entry.issue.state_key() == state_key)
        return max(limit - running_count, 0)

    def _select_worker_host(self) -> str | None:
        hosts = self.config.worker.ssh_hosts
        if not hosts:
            return None
        for host in hosts:
            running_count = sum(1 for entry in self.state.running.values() if entry.worker_host == host)
            if running_count < self.config.worker.max_concurrent_agents_per_host:
                return host
        return None

    def _session_id_for_log(self, issue_id: str) -> str:
        entry = self.state.running.get(issue_id)
        if entry and entry.session_id:
            return entry.session_id
        return "-"

    def _apply_absolute_tokens(self, entry: RunningEntry, tokens: RuntimeTokens) -> None:
        input_delta = max(tokens.input_tokens - entry.last_reported_tokens.input_tokens, 0)
        output_delta = max(tokens.output_tokens - entry.last_reported_tokens.output_tokens, 0)
        total_delta = max(tokens.total_tokens - entry.last_reported_tokens.total_tokens, 0)
        entry.tokens = tokens
        entry.last_reported_tokens = RuntimeTokens(
            input_tokens=tokens.input_tokens,
            output_tokens=tokens.output_tokens,
            cached_tokens=tokens.cached_tokens,
            total_tokens=tokens.total_tokens,
        )
        self.state.codex_totals.input_tokens += input_delta
        self.state.codex_totals.output_tokens += output_delta
        self.state.codex_totals.total_tokens += total_delta

    def _extract_absolute_tokens(self, event: dict[str, Any]) -> RuntimeTokens | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        token_payload: Any = None
        if event.get("raw_method") == "thread/tokenUsage/updated":
            token_payload = payload.get("tokenUsage") or payload.get("token_usage") or payload
        if token_payload is None:
            token_payload = payload.get("total_token_usage") or payload.get("totalTokenUsage")
        if not isinstance(token_payload, dict):
            return None
        return RuntimeTokens(
            input_tokens=self._int_from_keys(token_payload, "input_tokens", "inputTokens", "input"),
            output_tokens=self._int_from_keys(token_payload, "output_tokens", "outputTokens", "output"),
            cached_tokens=self._int_from_keys(token_payload, "cached_tokens", "cachedTokens", "cached"),
            total_tokens=self._int_from_keys(token_payload, "total_tokens", "totalTokens", "total"),
        )

    def _extract_rate_limits(self, event: dict[str, Any]) -> dict[str, Any] | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        rate_limits = payload.get("rate_limits") or payload.get("rateLimits")
        return rate_limits if isinstance(rate_limits, dict) else None

    def _int_from_keys(self, values: dict[str, Any], *keys: str) -> int:
        for key in keys:
            value = values.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().isdigit():
                return int(value.strip())
        return 0

    def _persist_state(self) -> None:
        if self.persistence_store is None:
            return
        self.persistence_store.save(
            PersistedState.from_runtime(
                retry_attempts=list(self.state.retry_attempts.values()),
                continuations=list(self.state.continuations.values()),
                blocked=list(self.state.blocked.values()),
                human_interventions=list(self.state.human_interventions.values()),
                running=list(self.state.running.values()),
                codex_threads=list(self.state.codex_threads.values()),
            )
        )


def _log_message(value: Any) -> str:
    text = str(value or "-").replace("\n", "\\n")
    if len(text) > 240:
        return text[:237] + "..."
    return text


def _retry_delay_seconds(entry: Any) -> int:
    due_at = getattr(entry, "due_at", None)
    if not isinstance(due_at, datetime):
        return 0
    remaining = (due_at - datetime.now(timezone.utc)).total_seconds()
    if remaining <= 0:
        return 0
    return max(math.ceil(remaining), 5)


def _is_codex_init_error_code(code: str | None) -> bool:
    return code in {
        "codex_init_failed",
        "codex_sdk_not_installed",
        "invalid_sdk_codex_bin",
        "invalid_workspace_cwd",
        "sdk_missing_thread_start",
        "sdk_missing_thread_resume",
        "unsupported_sdk_worker_host",
    }


def _status_message_from_event(event: dict[str, Any]) -> str | None:
    message = event.get("message")
    if isinstance(message, str) and message.strip():
        if _is_low_value_message(message):
            return None
        return message

    raw_method = event.get("raw_method") or event.get("method")
    if raw_method in {
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "account/rateLimits/updated",
        "turn/diff/updated",
        "thread/status/changed",
    }:
        return None

    event_name = event.get("event")
    if event_name == "request_timeout":
        method = event.get("method")
        if isinstance(method, str) and method:
            return f"{method} timed out"
        return "request timed out"
    if event_name in {
        "stderr",
        "turn_failed",
        "turn_cancelled",
        "turn_ended_with_error",
        "unsupported_tool_call",
        "malformed",
    }:
        fallback = raw_method or event_name
        return str(fallback) if fallback else None

    tool_name = event.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        return tool_name
    return None


def _is_low_value_message(message: str) -> bool:
    stripped = message.strip()
    return bool(stripped) and set(stripped) <= {".", " ", "\n", "\r", "\t"}


def _command_from_event(event: dict[str, Any]) -> str | None:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    command = payload.get("command")
    if isinstance(command, str) and command.strip():
        return command.strip()
    item = payload.get("item")
    if isinstance(item, dict):
        nested = item.get("command")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return None


def _exit_code_from_event(event: dict[str, Any]) -> int | None:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    value = payload.get("exit_code")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    item = payload.get("item")
    if isinstance(item, dict):
        nested = item.get("exit_code")
        if isinstance(nested, int):
            return nested
        if isinstance(nested, str) and nested.strip().isdigit():
            return int(nested.strip())
    return None


def _failure_comment_body(entry: RunningEntry, error: str, next_attempt: int) -> str:
    event_type = "stalled" if error == "stalled" else "retry_backoff"
    reason = (
        "Stalled because no Codex output arrived before the stall timeout."
        if error == "stalled"
        else f"Retrying because {error}. Next retry attempt: {next_attempt}."
    )
    detail = {
        "issue_identifier": entry.issue.identifier,
        "latest_run": {
            "turn_count": entry.turn_count,
            "total_tokens": entry.tokens.total_tokens,
            "estimated_cost_usd": 0.0,
        },
        "state_explanation": reason,
    }
    lines = [
        format_linear_milestone_comment(
            detail,
            event_type=event_type,
            debug_url=entry.issue.url or f"linear://issue/{entry.issue.identifier}",
        ),
        "",
        f"Failure: {error}",
        f"Next retry attempt: {next_attempt}",
    ]
    if entry.session_id:
        lines.append(f"Codex session: {entry.session_id}")
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    return "\n".join(lines)


def _runtime_error_comment_body(entry: RunningEntry, event: dict[str, Any]) -> str:
    event_name = str(event.get("event") or "unknown")
    raw_method = str(event.get("raw_method") or event.get("method") or "-")
    message = entry.last_codex_message or entry.last_raw_codex_message or event_name
    lines = [
        "Performer runtime error.",
        "",
        f"Issue: {entry.issue.identifier}",
        f"Phase: {entry.phase}",
        f"Event: {event_name}",
        f"Raw method: {raw_method}",
        f"Message: {message}",
    ]
    command = _command_from_event(event)
    if command:
        lines.append(f"Command: {command}")
    exit_code = _exit_code_from_event(event)
    if exit_code is not None:
        lines.append(f"Exit code: {exit_code}")
    lines.append("")
    if entry.human_blocked_reason:
        lines.extend(
            [
                "This run is paused because the runtime error requires human approval or environment changes.",
                f"Blocked reason: {entry.human_blocked_reason}",
                "A [Human Action] child issue will be created. Complete that child issue and move it to Done to resume.",
            ]
        )
    else:
        lines.append(
            "The run has not been marked terminal failed yet. Performer will continue, retry, or post a final failure if recovery does not succeed."
        )
    return "\n".join(lines)


def _human_blocked_runtime_reason(entry: RunningEntry, event: dict[str, Any]) -> str | None:
    message = " ".join(
        str(value or "")
        for value in (
            event.get("message"),
            event.get("raw_method"),
            event.get("method"),
            entry.last_codex_message,
            entry.last_raw_codex_message,
        )
    ).lower()
    blocked_patterns = (
        "writing outside of the project",
        "outside of the project",
        "requires approval",
        "permission denied",
        "operation not permitted",
        "sandbox",
        "approval denied",
        "not permitted",
    )
    if any(pattern in message for pattern in blocked_patterns):
        readable = entry.last_codex_message or event.get("message") or event.get("raw_method") or event.get("event")
        return f"runtime_permission_blocked: {readable}"
    return None


def _human_intervention_title(issue: Issue, kind: str) -> str:
    suffix = {
        "preflight_needs_input": "Need more information",
        "codex_needs_input": "Codex requested input",
        "runtime_permission": "Runtime approval required",
        "runtime_error": "Runtime error needs review",
        "verification_needs_human": "Verification needs review",
    }.get(kind, "Human action required")
    return f"[Human Action] {issue.identifier}: {suffix}"


def _human_intervention_description(
    issue: Issue,
    *,
    kind: str,
    error: str | None,
    questions: list[str],
    last_message: str | None,
    http_status: int | None = None,
) -> str:
    reason = {
        "preflight_needs_input": "Performer cannot plan acceptance gates because required information is missing.",
        "codex_needs_input": "Codex requested human input before it can continue.",
        "runtime_permission": "The runtime hit a permission or sandbox boundary that needs human approval or an environment fix.",
        "runtime_error": "The worker hit an execution failure that needs human review before retrying.",
        "verification_needs_human": "Completion verification needs human judgment before Performer can continue.",
    }.get(kind, "Performer needs a human decision before continuing.")
    lines = [
        reason,
        "",
        f"Parent issue: {issue.identifier}",
    ]
    if http_status is not None:
        lines.extend(["", f"Upstream HTTP status: {http_status}"])
    safe_error = _redact_human_text(error)
    safe_last_message = _redact_human_text(last_message)
    if safe_error:
        lines.extend(["", "Last error:", safe_error])
    if safe_last_message and safe_last_message != safe_error:
        lines.extend(["", "Last observed message:", safe_last_message])
    if questions:
        lines.append("")
        lines.append("Questions:")
        lines.extend(f"- {question}" for question in questions)
    lines.extend(
        [
            "",
            "Human action:",
            _human_action_instruction(kind),
            "",
            "Human response:",
            "",
            "(Add the answer or decision here when information is required.)",
            "",
            "When finished, move this child issue to Done. Performer only resumes from this child issue being Done.",
        ]
    )
    return "\n".join(lines)


def _redact_human_text(value: str | None) -> str | None:
    if value is None:
        return None
    redacted = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value)
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(api[_-]?key|token|secret)(\s*[=:]\s*)[^\s,;]+", r"\1\2[REDACTED]", redacted)
    return redacted


def _human_action_instruction(kind: str) -> str:
    if kind in {"preflight_needs_input", "codex_needs_input"}:
        return "Answer the questions above in the Human response section."
    if kind == "runtime_permission":
        return "Approve the runtime action or fix the environment so the next attempt can proceed."
    if kind == "verification_needs_human":
        return "Review the verifier concern and state the decision or correction in Human response if needed."
    return "Review the failure and make any needed repository, environment, or issue updates before retry."


def _find_human_child(
    intervention: HumanInterventionEntry,
    children: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for child in children:
        if not isinstance(child, dict):
            continue
        if str(child.get("id") or "") == intervention.child_issue_id:
            return child
    return None


def _human_response_from_child(child: dict[str, Any]) -> str | None:
    description = str(child.get("description") or "")
    marker = "Human response:"
    if marker.lower() not in description.lower():
        return None
    lower = description.lower()
    start = lower.find(marker.lower())
    response = description[start + len(marker):]
    stop_markers = ["When finished,", "完成后", "Move this child issue"]
    for stop in stop_markers:
        index = response.lower().find(stop.lower())
        if index >= 0:
            response = response[:index]
    cleaned = response.strip()
    if not cleaned or cleaned == "(Add the answer or decision here when information is required.)":
        return None
    return cleaned


def _human_intervention_requires_response(intervention: HumanInterventionEntry) -> bool:
    return intervention.kind in {"preflight_needs_input", "codex_needs_input"}


def _human_resume_error(intervention: HumanInterventionEntry, response: str | None) -> str:
    if response:
        return f"human_action_resolved: {intervention.kind}: {response[:500]}"
    if intervention.error:
        return f"human_action_resolved: {intervention.kind}: {intervention.error}"
    return f"human_action_resolved: {intervention.kind}"


def _event_can_signal_human_block(event: dict[str, Any]) -> bool:
    event_name = str(event.get("event") or "")
    raw_method = str(event.get("raw_method") or event.get("method") or "")
    if event_name in {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
        return True
    if raw_method.startswith("item/commandExecution/"):
        return True
    if raw_method == "item/completed":
        message = str(event.get("message") or "").lower()
        if "previous attempt failed" in message:
            return False
        return "operation not permitted" in message or "permission denied" in message or "outside-workspace write failed" in message
    return False


def _completion_verdict_comment_body(entry: RunningEntry, verdict: Any, *, next_action: str) -> str:
    action_line = (
        "Required next action: fix the verifier failures and retry."
        if next_action == "retry"
        else "Required next action: human review is required before closing this issue."
    )
    lines = [
        "Verification failed after agent claimed success.",
        "",
        f"Verdict: {verdict.status}",
        f"Reason: {verdict.reason}",
        "",
        "Observed evidence:",
    ]
    for check in getattr(verdict, "checks", []):
        icon = "PASS" if check.passed else "FAIL"
        lines.append(f"- [{icon}] {check.check_name}: {check.message}")
        evidence = _format_check_evidence(getattr(check, "evidence", None))
        if evidence:
            lines.append(f"  Evidence: {evidence}")
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    lines.extend(["", action_line])
    return "\n".join(lines)


def _description_with_structured_result(existing: str, result: dict[str, Any]) -> str:
    block = _structured_result_evidence_block(result)
    marker = "<!-- PERFORMER IMPLEMENTATION EVIDENCE -->"
    if marker in existing:
        return existing.split(marker, 1)[0].rstrip() + "\n\n" + marker + "\n" + block
    prefix = existing.rstrip()
    return f"{prefix}\n\n{marker}\n{block}".strip()


def _structured_result_evidence_block(result: dict[str, Any]) -> str:
    return "\n".join(
        [
            "Implementation summary:",
            str(result.get("summary") or "").strip() or "No summary provided.",
            "",
            "Test commands and exact output:",
            _structured_list(result.get("test_commands")),
            "",
            "Remaining risks:",
            _structured_list(result.get("remaining_risks")) or "None.",
            "",
            "Changed files:",
            _structured_list(result.get("changed_files")) or "None reported.",
        ]
    )


def _structured_result_from_issue_description(description: str) -> dict[str, Any] | None:
    summary = _extract_evidence_section(description, "Implementation summary:")
    tests = _extract_evidence_section(description, "Test commands and exact output:")
    risks = _extract_evidence_section(description, "Remaining risks:")
    if not any((summary, tests, risks)):
        return None
    return {
        "summary": summary or "",
        "test_commands": [tests] if tests else [],
        "remaining_risks": [risks] if risks else [],
    }


def _structured_result_needs_human(result: dict[str, Any]) -> bool:
    next_action = str(result.get("next_action") or "").strip().lower()
    if next_action == "needs_human":
        return True
    if next_action == "blocked":
        combined = " ".join(
            str(value or "")
            for value in (
                result.get("summary"),
                result.get("questions"),
                result.get("remaining_risks"),
            )
        ).lower()
        return any(token in combined for token in ("need", "missing", "question", "clarify", "human", "input"))
    return False


def _structured_result_summary(result: dict[str, Any]) -> str:
    summary = result.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    return "Codex requested human input"


def _structured_result_questions(result: dict[str, Any]) -> list[str]:
    questions = result.get("questions")
    if isinstance(questions, list):
        return [str(question).strip() for question in questions if str(question).strip()]
    if isinstance(questions, str) and questions.strip():
        return [questions.strip()]
    risks = result.get("remaining_risks")
    if isinstance(risks, list):
        return [str(risk).strip() for risk in risks if str(risk).strip()]
    return []


def _extract_evidence_section(description: str, heading: str) -> str:
    start = description.lower().find(heading.lower())
    if start < 0:
        return ""
    body_start = start + len(heading)
    next_positions = [
        position
        for marker in ("Implementation summary:", "Test commands and exact output:", "Remaining risks:", "Changed files:")
        if marker.lower() != heading.lower()
        for position in [description.lower().find(marker.lower(), body_start)]
        if position >= 0
    ]
    body_end = min(next_positions) if next_positions else len(description)
    return description[body_start:body_end].strip()


def _structured_result_comment_body(entry: RunningEntry, result: dict[str, Any]) -> str:
    lines = [
        "Performer implementation handoff.",
        "",
        f"Issue: {entry.issue.identifier}",
        "",
        "Implementation summary:",
        str(result.get("summary") or "").strip() or "No summary provided.",
        "",
        "Test commands and exact output:",
        _structured_list(result.get("test_commands")),
        "",
        "Changed files:",
        _structured_list(result.get("changed_files")) or "None reported.",
        "",
        "Remaining risks:",
        _structured_list(result.get("remaining_risks")) or "None.",
        "",
        f"Next action: {result.get('next_action') or 'unknown'}",
    ]
    return "\n".join(lines)


def _structured_list(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    items = [str(item).strip() for item in value if str(item).strip()]
    return "\n".join(f"- {item}" for item in items)


def _completion_verification_error_comment_body(entry: RunningEntry, error: str) -> str:
    lines = [
        "Verification failed after agent claimed success.",
        "",
        "Failure class: verifier_error",
        f"Observed evidence: {error}",
        "",
        "Required next action: fix the verifier failure, then retry the issue.",
    ]
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    return "\n".join(lines)


def _acceptance_issue_description(entry: RunningEntry, verdict: Any) -> str:
    return _acceptance_issue_description_for_issue(entry.issue, verdict, acceptance_issue=None, workspace_path=entry.workspace_path)


def _acceptance_issue_description_for_issue(
    issue: Issue,
    verdict: Any,
    acceptance_issue: dict[str, Any] | None,
    workspace_path: str | None = None,
) -> str:
    _ = acceptance_issue
    return "\n".join(
        [
            f"Original issue: {issue.identifier}",
            f"Original issue ID: {issue.id}",
            f"Workspace: {workspace_path or '<workspace path unavailable>'}",
            f"Completion verdict: {getattr(verdict, 'status', 'unknown')}",
            f"Completion reason: {getattr(verdict, 'reason', 'unknown')}",
            "",
            "Review the implementation evidence and produce a score from 0 to 4.",
        ]
    )


def _acceptance_marker_block(issue: Issue, acceptance_issue: dict[str, Any], acceptance: Any) -> str:
    return "\n".join(
        [
            f"acceptance_issue_id: {acceptance_issue.get('id', '')}",
            f"acceptance_issue_identifier: {acceptance_issue.get('identifier', '')}",
            f"acceptance_issue_url: {acceptance_issue.get('url', '')}",
            f"plan_revision: {acceptance.plan_revision}",
            "",
            "Execution plan:",
            f"- Implement the Linear task described by {issue.identifier}.",
            "- Run focused verification and capture exact output.",
            "- Report implementation summary, test evidence, and remaining risks.",
            "",
            "Acceptance requirements:",
            "- The original issue requirements are satisfied.",
            "- The implementation is maintainable and scoped.",
            "- Verification evidence is concrete enough for independent review.",
            "",
            "Evidence required:",
            "- Implementation summary.",
            "- Test commands and exact output.",
            "- Remaining risks or explicit none.",
        ]
    )


def _gate_plan_marker_block(issue: Issue, gates: list[dict[str, Any]], acceptance: Any) -> str:
    lines = [
        f"plan_revision: {acceptance.plan_revision}",
        f"gate_count: {len(gates)}",
        "",
        "Gate plan:",
    ]
    for index, gate in enumerate(gates, start=1):
        lines.append(f"- Gate {index}: {gate.get('identifier', gate.get('id', ''))} {gate.get('title', '')}".rstrip())
    lines.extend(
        [
            "",
            "Implementation boundary:",
            f"- Implement only the business issue described by {issue.identifier}.",
            "- Do not move the Linear issue to In Review or Done.",
            "- Performer will run each gate and close the tree after acceptance.",
            "",
            "Evidence required:",
            "- Implementation summary.",
            "- Test commands and exact output.",
            "- Remaining risks or explicit none.",
        ]
    )
    return "\n".join(lines)


def _gate_issue_description(issue: Issue, gate: GatePlan, *, index: int) -> str:
    lines = [
        f"Business issue: {issue.identifier}",
        f"Gate index: {index}",
        "",
        "Purpose:",
        gate.purpose,
        "",
        "Acceptance criteria:",
    ]
    for criterion in gate.acceptance_criteria:
        lines.append(f"- {criterion}")
    lines.extend(["", "Required evidence:"])
    for evidence in gate.required_evidence:
        lines.append(f"- {evidence}")
    return "\n".join(lines)


def _evidence_issue_description(
    issue: Issue,
    gate: dict[str, Any],
    report: AcceptanceReport,
    raw_report: str,
    workspace_path: str | None,
) -> str:
    lines = [
        f"Business issue: {issue.identifier}",
        f"Gate: {gate.get('identifier', gate.get('id', ''))}",
        f"Workspace: {workspace_path or '<workspace path unavailable>'}",
        "",
        "Reviewer conclusion:",
        f"- Score: {report.score}",
        f"- Result: {report.result}",
        f"- Accepted: {report.accepted}",
        f"- Reason: {report.score_reason}",
        "",
        "Evidence citations:",
    ]
    for citation in report.evidence_citations:
        lines.append(f"- {citation}")
    if report.residual_findings:
        lines.extend(["", "Residual findings:"])
        for finding in report.residual_findings:
            lines.append(f"- {finding}")
    if report.rejection_reasons:
        lines.extend(["", "Gate rejection reasons:"])
        for reason in report.rejection_reasons:
            lines.append(f"- {reason}")
    lines.extend(["", "Raw reviewer JSON:", raw_report.strip()])
    return "\n".join(lines)


def _gate_plan_needs_more_info_comment(issue: Issue, questions: list[str]) -> str:
    lines = [
        "Performer needs more information before planning acceptance gates.",
        "",
        f"Business issue: {issue.identifier}",
        "",
        "Questions:",
    ]
    for question in questions:
        lines.append(f"- {question}")
    return "\n".join(lines)


def _gate_plan_rejected_comment(issue: Issue, reasons: list[str]) -> str:
    lines = [
        "Performer could not validate the acceptance gate plan.",
        "",
        f"Business issue: {issue.identifier}",
        "",
        "Planner rejection reasons:",
    ]
    for reason in reasons:
        lines.append(f"- {reason}")
    return "\n".join(lines)


def _entry_for_issue(issue: Issue, workspace_path: str | None) -> RunningEntry:
    return RunningEntry(
        issue=issue,
        task=None,
        started_at=utc_now(),
        retry_attempt=0,
        workspace_path=workspace_path,
    )


def _has_acceptance_evidence(issue: Issue) -> bool:
    text = _strip_marker_block(issue.description or "", "PERFORMER ACCEPTANCE").lower()
    evidence_fields = {
        "implementation": ("implementation summary:", "implemented:", "changed:"),
        "tests": (
            "test commands and exact output:",
            "test command:",
            "test commands:",
            "test output:",
        ),
        "risks": ("remaining risks:", "residual risk:", "risks:"),
    }
    return all(_has_nonempty_evidence_field(text, prefixes) for prefixes in evidence_fields.values())


def _has_nonempty_evidence_field(text: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        start = text.find(prefix)
        if start < 0:
            continue
        value = text[start + len(prefix):].strip()
        if not value:
            continue
        first_line = value.splitlines()[0].strip(" -*\t")
        if _is_placeholder_evidence_value(first_line):
            continue
        return True
    return False


def _is_placeholder_evidence_value(value: str) -> bool:
    normalized = value.strip().rstrip(".:").lower()
    if not normalized:
        return True
    placeholder_prefixes = (
        "must include",
        "required",
        "todo",
        "tbd",
        "none provided",
        "no description",
    )
    return any(normalized.startswith(prefix) for prefix in placeholder_prefixes)


def _strip_marker_block(description: str, marker_name: str) -> str:
    begin = f"<!-- BEGIN {marker_name} -->"
    end = f"<!-- END {marker_name} -->"
    remaining = description
    while begin in remaining and end in remaining:
        prefix, after_begin = remaining.split(begin, 1)
        if end not in after_begin:
            break
        _, suffix = after_begin.split(end, 1)
        remaining = (prefix + suffix).strip()
    return remaining


def _has_passed_acceptance_gate(issue: Issue, acceptance: Any) -> bool:
    labels = {str(label).strip().lower() for label in issue.labels}
    return (
        acceptance.gate_passed_label.strip().lower() in labels
        or acceptance.gate_pass_with_findings_label.strip().lower() in labels
    )


def _issue_dict_has_label(issue: dict[str, Any], label_name: str) -> bool:
    labels = issue.get("labels")
    if not isinstance(labels, list):
        labels = issue.get("label_ids")
    if not isinstance(labels, list):
        return False
    wanted = label_name.strip().lower()
    return wanted in {str(label).strip().lower() for label in labels}


def _policy_violation_comment_body(issue: Issue, *, has_evidence: bool) -> str:
    if has_evidence:
        next_action = "Evidence was present, so Performer is pulling the issue back to In Review and running acceptance."
    else:
        next_action = "Evidence was missing, so Performer is pulling the issue back to In Progress for rework."
    return "\n".join(
        [
            "Policy violation: direct Done bypass before acceptance gate passed.",
            "",
            f"Original issue: {issue.identifier}",
            next_action,
            "",
            "Required evidence before Done: implementation summary, test commands and exact output, and remaining risks.",
        ]
    )


def _acceptance_report_comment_body(entry: RunningEntry, report: AcceptanceReport) -> str:
    lines = [
        f"Acceptance score: {report.score}",
        f"Result: {report.result}",
        "",
        f"Reason: {report.score_reason}",
        "",
        "Evidence citations:",
    ]
    for citation in report.evidence_citations:
        lines.append(f"- {citation}")
    if report.residual_findings:
        lines.extend(["", "Residual findings:"])
        for finding in report.residual_findings:
            lines.append(f"- {finding}")
    if report.rejection_reasons:
        lines.extend(["", "Gate rejection reasons:"])
        for reason in report.rejection_reasons:
            lines.append(f"- {reason}")
    lines.extend(
        [
            "",
            f"Recommended next action: {report.recommended_next_action}",
            f"Original issue: {entry.issue.identifier}",
        ]
    )
    return "\n".join(lines)


def _handoff_preserved_comment_body(entry: RunningEntry, refreshed_issue: Issue) -> str:
    evidence_path = entry.workspace_path or "<workspace path unavailable>"
    lines = [
        "Performer stopped automation for human review.",
        "",
        f"Tracker state: {refreshed_issue.state}",
        "Handoff type: non-active, non-terminal",
        f"Workspace preserved for review: {evidence_path}",
    ]
    if entry.session_id:
        lines.append(f"Codex session: {entry.session_id}")
    if entry.last_codex_message:
        lines.append(f"Last observed message: {entry.last_codex_message}")
    lines.append("Required next action: inspect the preserved workspace and validation evidence before closing this issue.")
    return "\n".join(lines)


def _issue_with_verification_context(issue: Issue, verdict: Any) -> Issue:
    evidence_lines = [f"- {check.check_name}: {check.message}" for check in getattr(verdict, "checks", []) if not check.passed]
    if not evidence_lines:
        evidence_lines = [f"- {verdict.reason}"]
    context = "Previous attempt failed verification:\n" + "\n".join(evidence_lines)
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker in description:
        description = description.split(marker, 1)[0].rstrip()
    merged = f"{context}\n\n{description}".strip() if description else context
    return Issue(
        id=issue.id,
        identifier=issue.identifier,
        title=issue.title,
        state=issue.state,
        description=merged,
        priority=issue.priority,
        branch_name=issue.branch_name,
        url=issue.url,
        labels=list(issue.labels),
        blocked_by=list(issue.blocked_by),
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        assignee_id=issue.assignee_id,
        delegate_id=issue.delegate_id,
        project_slug=issue.project_slug,
        project_name=issue.project_name,
    )


def _issue_with_retry_context(issue: Issue, retry: RetryEntry) -> Issue:
    retry_context = retry.last_message or retry.error
    if not retry_context:
        return issue
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker not in retry_context:
        return issue
    if marker in description:
        description = description.split(marker, 1)[0].rstrip()
    merged = f"{retry_context}\n\n{description}".strip() if description else retry_context
    return Issue(
        id=issue.id,
        identifier=issue.identifier,
        title=issue.title,
        state=issue.state,
        description=merged,
        priority=issue.priority,
        branch_name=issue.branch_name,
        url=issue.url,
        labels=list(issue.labels),
        blocked_by=list(issue.blocked_by),
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        assignee_id=issue.assignee_id,
        delegate_id=issue.delegate_id,
        project_slug=issue.project_slug,
        project_name=issue.project_name,
    )


def _retry_context_from_issue(issue: Issue) -> str | None:
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker not in description:
        return None
    return marker + description.split(marker, 1)[1]


def _format_check_evidence(evidence: Any) -> str | None:
    if not isinstance(evidence, dict) or not evidence:
        return None
    parts: list[str] = []
    for key, value in evidence.items():
        if isinstance(value, list):
            rendered_items = []
            for item in value[:5]:
                if isinstance(item, dict):
                    identity = item.get("identifier") or item.get("id") or "unknown"
                    state = item.get("state")
                    rendered_items.append(f"{identity} ({state})" if state else str(identity))
                else:
                    rendered_items.append(str(item))
            rendered = ", ".join(rendered_items)
            if len(value) > 5:
                rendered += ", ..."
        elif isinstance(value, dict):
            rendered = ", ".join(f"{nested_key}={nested_value}" for nested_key, nested_value in list(value.items())[:5])
        else:
            rendered = str(value)
        if rendered:
            parts.append(f"{key}={rendered}")
    return "; ".join(parts)[:1000] if parts else None
