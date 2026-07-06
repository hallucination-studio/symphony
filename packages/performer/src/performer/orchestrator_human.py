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

class HumanInterventionMixin:
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
        self.state.mark_human_intervention(intervention)
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
        self._persist_state()
        return intervention

    async def _resolve_human_intervention(self, intervention: HumanInterventionEntry, *, response: str | None) -> None:
        self.state.release_human_intervention(intervention.issue_id)
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
        if intervention.resume_strategy == "preflight":
            self.state.release(issue.id)
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

