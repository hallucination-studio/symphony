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

class ReconcileMixin:
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
                    await self._terminate_running(issue_id, retry=True, failure_reason="stalled", human_on_retry=False)

    async def _terminate_running(
        self,
        issue_id: str,
        *,
        retry: bool,
        cleanup_workspace: bool = False,
        ops_status: str | None = None,
        failure_reason: str = "stalled",
        human_on_retry: bool = True,
    ) -> None:
        entry = self.state.finish_running(issue_id)
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
        self.state.release(issue_id)
        if cleanup_workspace and self.workspace_manager is not None:
            await self.workspace_manager.remove_for_issue(entry.issue.identifier)
        if retry:
            self._finish_open_ops_for_issue(issue_id, status="failed", failure_summary=failure_reason)
            next_attempt = max(entry.retry_attempt + 1, 1)
            if human_on_retry:
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="runtime_error",
                    attempt=next_attempt,
                    error=failure_reason,
                    resume_strategy="retry",
                )
            else:
                self._schedule_retry(entry.issue, next_attempt, error=failure_reason, delay_ms=5_000)
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
