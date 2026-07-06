from __future__ import annotations

import asyncio
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

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
from .linear import format_linear_milestone_comment
from .ops_telemetry import ExecutionTelemetryRecorder
from .repository_handoff import build_repository_handoff_report
from .workspace import WorkspaceManager
from .orchestrator_helpers import *

logger = logging.getLogger(__name__)


def _retry_error_is_verification_failure(error: str) -> bool:
    normalized = error.strip().lower()
    return normalized.startswith(
        (
            "verification_failed:",
            "verification_needs_human:",
            "verification_error:",
            "implementation_evidence_missing:",
        )
    )


class DispatchMixin:
    def _release_due_retry_for_phase(self, issue_id: str) -> None:
        retry = self.state.retry_attempts.get(issue_id)
        if retry is None or retry.due_at_ms > monotonic_ms():
            return
        self.state.release_retry(issue_id)
        self._persist_state()

    def release_due_retry_for_phase(self, issue_id: str) -> None:
        self._release_due_retry_for_phase(issue_id)

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
            self.state.release_retry(retry.issue_id)
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
            self.state.release_continuation(continuation.issue_id)
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
        if issue.id in self.state.completed and self._is_active(issue):
            self.state.release_completed(issue.id)
            self._persist_state()
        if self.state.dispatch_blocked(issue.id):
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
        if issue.id in self.state.completed and self._is_active(issue):
            self.state.release_completed(issue.id)
            self._persist_state()
        if self.state.dispatch_blocked(issue.id):
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
        self.state.release_completed(issue.id)
        task = asyncio.create_task(self._run_worker(issue, attempt, worker_host=worker_host))
        self._worker_tasks.add(task)
        task.add_done_callback(self._worker_tasks.discard)
        self.state.mark_running(
            RunningEntry(
                issue=issue,
                task=task,
                started_at=utc_now(),
                retry_attempt=attempt or 0,
                worker_host=worker_host,
            )
        )
        self._set_running_phase(issue.id, "starting", runtime_phase="dispatch_received")
        self._persist_state()

    def dispatch_skip_reason_without_acceptance(self, issue: Issue) -> str | None:
        if not issue.id or not issue.identifier or not issue.title or not issue.state:
            return "missing_required_issue_fields"
        if issue.id in self.state.completed and self._is_active(issue):
            self.state.release_completed(issue.id)
            self._persist_state()
        if self.state.dispatch_blocked(issue.id):
            return "already_running_or_claimed"
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return "project_mismatch"
        if not self._matches_required_delegate(issue):
            return "delegate_mismatch"
        if self.available_slots() <= 0:
            return "no_available_slots"
        return None

    def _schedule_retry(self, issue: Issue, attempt: int, *, error: str | None, delay_ms: int | None) -> None:
        if error is None:
            self._schedule_continuation(issue, attempt, delay_ms=delay_ms)
            return
        retry_limit = int(getattr(self.config.completion_verification, "max_verification_retries", 0) or 0)
        if retry_limit >= 0 and attempt > retry_limit + 1 and _retry_error_is_verification_failure(error):
            blocked_error = f"verification retry limit exceeded: {error}"
            blocked_entry = BlockedEntry(
                issue_id=issue.id,
                identifier=issue.identifier,
                attempt=attempt,
                blocked_at=utc_now(),
                error=blocked_error,
                issue_url=issue.url,
                phase="verification_blocked",
                status_label=PHASE_LABELS["blocked"],
                runtime_phase="failed",
                last_message=blocked_error,
            )
            self.state.mark_blocked(blocked_entry)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.AWAITING_HUMAN,
                status="blocked",
                reason=blocked_error,
            )
            self._persist_state()
            return
        if delay_ms is None:
            delay_ms = min(10_000 * (2 ** max(attempt - 1, 0)), self.config.agent.max_retry_backoff_ms)
        due_at = utc_now() + timedelta(milliseconds=delay_ms)
        due_at_ms = monotonic_ms() + delay_ms
        retry_context = _retry_context_from_issue(issue)
        retry_entry = RetryEntry(
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
        self.state.mark_retry(retry_entry)
        self.phase_runtime.record_outcome(
            issue.id,
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason=error,
            retry_delay_seconds=_retry_delay_seconds(retry_entry),
        )
        self._persist_state()

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
        continuation = ContinuationEntry(
            issue_id=issue.id,
            identifier=issue.identifier,
            attempt=attempt,
            due_at=due_at,
            due_at_ms=due_at_ms,
            issue_url=issue.url,
            last_message=last_message or _retry_context_from_issue(issue),
        )
        self.state.mark_continuation(continuation)
        self.phase_runtime.record_outcome(
            issue.id,
            next_phase=RunPhase.QUEUED,
            status="accepted",
            reason=continuation.last_message,
            retry_delay_seconds=_retry_delay_seconds(continuation),
        )
        self._persist_state()

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

    def select_worker_host(self) -> str | None:
        return self._select_worker_host()
