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

class AcceptanceMixin:
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
                self.state.mark_completed(issue.id)
                self._persist_state()
                return True
            if self.dispatch_skip_reason_without_acceptance(issue) is not None:
                return False
            await self._handle_direct_done_bypass(issue)
            return True
        return False

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
        return gates[0]

    async def acceptance_preflight(self, issue: Issue) -> dict[str, Any] | None:
        return await self._acceptance_preflight(issue)

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
            delegate_id=self._delegate_id_for_child_issue(issue),
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
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.REWORKING,
                status="reworking",
                reason="implementation_evidence_missing",
            )
            return
        await self._comment_policy_violation(issue, has_evidence=True)
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
            self._transition_issue_outcome(
                issue.id,
                next_phase=RunPhase.REWORKING,
                status="reworking",
                reason="acceptance_gate_failed",
            )
            self._persist_state()
            return
        gate_ids = {str(gate.get("id") or "") for gate in gates if str(gate.get("id") or "")}
        reviewed_gate_ids = {str(gate.get("id") or "") for gate in reviewed_gates if str(gate.get("id") or "")}
        if gate_ids and reviewed_gate_ids == gate_ids:
            await self._sync_label_group(issue.id, self.config.acceptance.gate_passed_label, prefix="performer:gate/")
            self._record_repository_handoff_after_acceptance(issue, workspace_path=workspace_path)
            self._transition_issue_outcome(
                issue.id,
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
                mark_completed=True,
            )

    async def run_acceptance_gate_for_issue(
        self,
        issue: Issue,
        **kwargs: Any,
    ) -> None:
        await self._run_acceptance_gate_for_issue(issue, **kwargs)

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
            self.state.mark_completed(issue.id)
            self.phase_runtime.record_outcome(
                issue.id,
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
            )
        else:
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
            delegate_id=self._delegate_id_for_child_issue(issue),
        )

    def _delegate_id_for_child_issue(self, issue: Issue) -> str | None:
        return issue.delegate_id or self.config.tracker.required_delegate_id

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

    def _gate_planner(self) -> GatePlannerProtocol:
        if self.config.acceptance.gate_planner_mode == "smoke":
            return SmokeGatePlanner()
        return CodexGatePlanner(self.config)

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

