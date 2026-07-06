from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from .phase_executor import PhaseExecutor
from .phase_runtime import PhaseRuntime
from .orchestrator_codex_events import (
    CodexEventProcessor,
    command_from_event,
    event_can_signal_human_block,
    exit_code_from_event,
    extract_absolute_tokens,
    human_blocked_runtime_reason,
    log_message,
    status_message_from_event,
    usage_row_from_tokens,
)
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
from .orchestrator_state import OrchestratorState
from .orchestrator_acceptance import AcceptanceMixin
from .orchestrator_completion import CompletionMixin
from .orchestrator_dispatch import DispatchMixin
from .orchestrator_helpers import *
from .orchestrator_human import HumanInterventionMixin
from .orchestrator_reconcile import ReconcileMixin
from .linear import format_linear_milestone_comment
from .ops_telemetry import ExecutionTelemetryRecorder
from .repository_handoff import build_repository_handoff_report
from .workspace import WorkspaceManager


logger = logging.getLogger(__name__)


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


class Orchestrator(DispatchMixin, AcceptanceMixin, CompletionMixin, HumanInterventionMixin, ReconcileMixin):
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
        self._label_task_tails: dict[str, asyncio.Task[Any]] = {}
        self._label_task_semaphore = asyncio.Semaphore(8)
        self._desired_lifecycle_labels: dict[str, str] = {}
        self.phase_runtime = PhaseRuntime(self)

    def load_persisted_state(self) -> None:
        if self.persistence_store is None:
            return
        persisted = self.persistence_store.load()
        for issue_id in persisted.completed:
            self.state.mark_completed(issue_id)
        for retry in persisted.retry_attempts:
            self.state.mark_retry(retry)
        for continuation in persisted.continuations:
            self.state.mark_continuation(continuation)
        for blocked in persisted.blocked:
            self.state.mark_blocked(blocked)
        for intervention in persisted.human_interventions:
            self.state.mark_human_intervention(intervention)
        for session in persisted.sessions:
            self.state.claim(session.issue_id)
        for thread in persisted.codex_threads:
            self.state.codex_threads[thread.issue_id] = thread
            if thread.status in {"active", "resume_pending"}:
                self.state.claim(thread.issue_id)

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
        self.state.forget_active(issue_id)
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

    def on_codex_event(self, issue_id: str, event: dict[str, Any]) -> None:
        entry = self.state.running.get(issue_id)
        if entry is not None:
            self._apply_codex_thread_event(entry, event)
        CodexEventProcessor(
            state=self.state,
            config=self.config,
            persist_state=self._persist_state,
            comment_runtime_error_background=self._comment_runtime_error_background,
        ).on_event(issue_id, event)

    def _apply_codex_thread_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        thread_id = event.get("thread_id") or entry.thread_id
        if not isinstance(thread_id, str) or not thread_id:
            return
        existing = self.state.codex_threads.get(entry.issue.id)
        if existing is not None and existing.status in {"completed", "failed"}:
            return
        backend = str(event.get("backend") or "sdk")
        workspace_path = event.get("cwd") or entry.workspace_path
        if not isinstance(workspace_path, str) or not workspace_path:
            workspace_path = str(self.config.workspace.root)
        turn_id = event.get("turn_id") or entry.turn_id
        message = event.get("message") or entry.last_codex_message
        event_name = str(event.get("event") or "")
        error_events = {"request_timeout", "stderr", "turn_failed", "turn_cancelled", "turn_ended_with_error"}
        status = "failed" if event_name in error_events else "resume_pending"
        self.state.codex_threads[entry.issue.id] = CodexThreadEntry(
            issue_id=entry.issue.id,
            thread_id=thread_id,
            backend=backend,
            workspace_path=workspace_path,
            last_turn_id=turn_id if isinstance(turn_id, str) and turn_id else None,
            status=status,
            last_final_response=message if isinstance(message, str) and message else None,
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
        CodexEventProcessor(
            state=self.state,
            config=self.config,
            persist_state=self._persist_state,
            comment_runtime_error_background=self._comment_runtime_error_background,
        ).apply_phase_from_event(entry, event)

    def _append_recent_event(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        CodexEventProcessor(
            state=self.state,
            config=self.config,
            persist_state=self._persist_state,
            comment_runtime_error_background=self._comment_runtime_error_background,
        ).append_recent_event(entry, event)

    def _usage_row_from_tokens(self, tokens: RuntimeTokens | None) -> dict[str, int] | None:
        return usage_row_from_tokens(tokens)

    def _sync_lifecycle_label_background(self, issue_id: str, label_name: str) -> None:
        if not self.config.tracker.lifecycle_labels_enabled:
            return
        self._desired_lifecycle_labels[issue_id] = label_name
        previous = self._label_task_tails.get(issue_id)
        self._track_background_label_task(
            self._run_label_update_serialized(
                issue_id,
                self._sync_lifecycle_label(issue_id, label_name, only_if_current=True),
                after=previous,
            ),
            issue_id=issue_id,
        )

    def sync_label_group_background(self, issue_id: str, label_name: str, *, prefix: str) -> None:
        self._sync_label_group_background(issue_id, label_name, prefix=prefix)

    def _sync_label_group_background(self, issue_id: str, label_name: str, *, prefix: str) -> None:
        if not self.config.tracker.lifecycle_labels_enabled:
            return
        self._desired_lifecycle_labels[issue_id] = label_name
        previous = self._label_task_tails.get(issue_id)
        self._track_background_label_task(
            self._run_label_update_serialized(
                issue_id,
                self._sync_label_group(issue_id, label_name, prefix=prefix),
                after=previous,
            ),
            issue_id=issue_id,
        )

    def _comment_runtime_error_background(self, entry: RunningEntry, event: dict[str, Any]) -> None:
        self._track_background_label_task(self._comment_runtime_error(entry, event))

    async def _run_label_update_serialized(self, issue_id: str, coro: Any, *, after: asyncio.Task[Any] | None) -> None:
        _ = issue_id
        if after is not None:
            with contextlib.suppress(Exception):
                await after
        async with self._label_task_semaphore:
            await coro

    def _track_background_label_task(self, coro: Any, *, issue_id: str | None = None) -> None:
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
        if issue_id is not None:
            self._label_task_tails[issue_id] = task

        def _done(done: asyncio.Task[Any]) -> None:
            self._background_label_tasks.discard(done)
            if issue_id is not None and self._label_task_tails.get(issue_id) is done:
                self._label_task_tails.pop(issue_id, None)
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

    def _session_id_for_log(self, issue_id: str) -> str:
        entry = self.state.running.get(issue_id)
        if entry and entry.session_id:
            return entry.session_id
        return "-"

    def _apply_absolute_tokens(self, entry: RunningEntry, tokens: RuntimeTokens) -> None:
        CodexEventProcessor(
            state=self.state,
            config=self.config,
            persist_state=self._persist_state,
            comment_runtime_error_background=self._comment_runtime_error_background,
        ).apply_absolute_tokens(entry, tokens)

    def _extract_absolute_tokens(self, event: dict[str, Any]) -> RuntimeTokens | None:
        return extract_absolute_tokens(event)

    def _extract_rate_limits(self, event: dict[str, Any]) -> dict[str, Any] | None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            return None
        rate_limits = payload.get("rate_limits") or payload.get("rateLimits")
        return rate_limits if isinstance(rate_limits, dict) else None

    def _int_from_keys(self, values: dict[str, Any], *keys: str) -> int:
        from .orchestrator_codex_events import int_from_keys

        return int_from_keys(values, *keys)

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
                completed=sorted(self.state.completed),
            )
        )










































