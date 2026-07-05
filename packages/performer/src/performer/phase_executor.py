from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol

from performer_api.config import ConfigError
from performer_api.models import PHASE_LABELS, Issue
from performer_api.persistence import ops_snapshot_path_from_persistence_path
from performer_api.phase import PhaseAdvanceRequest, PhaseAdvanceResult, RunPhase

from .phase_runtime import (
    PHASE_RESULT_STATUSES,
    PhaseExecutionOutcome,
    PhaseRuntime,
    default_review_phase_outcome,
)


logger = logging.getLogger(__name__)


class PhaseExecutorHost(Protocol):
    config: Any
    phase_runtime: PhaseRuntime
    tracker: Any

    async def reconcile_running(self) -> None: ...
    def _release_due_retry_for_phase(self, issue_id: str) -> None: ...
    async def process_managed_human_response(self, issue_id: str, human_response: str) -> None: ...
    def _sync_label_group_background(self, issue_id: str, label_name: str, *, prefix: str) -> None: ...
    def dispatch_skip_reason_for_event(self, issue: Issue) -> str | None: ...
    async def _acceptance_preflight(self, issue: Issue) -> Any: ...
    def _select_worker_host(self) -> str | None: ...
    def dispatch_skip_reason_without_acceptance(self, issue: Issue) -> str | None: ...
    async def _run_acceptance_gate_for_issue(self, issue: Issue, **kwargs: Any) -> None: ...


class PhaseExecutor:
    def __init__(self, host: PhaseExecutorHost):
        self.host = host

    async def advance(self, request: PhaseAdvanceRequest) -> PhaseAdvanceResult:
        host = self.host
        await host.reconcile_running()
        host._release_due_retry_for_phase(request.issue_id)
        try:
            host.config.validate_for_dispatch()
        except ConfigError as exc:
            logger.warning("performer_phase_advance_validation failed code=%s reason=%s", exc.code, exc)
            return self._phase_result(
                request,
                issue_id=request.issue_id,
                next_phase=RunPhase.FAILED,
                status="failed",
                reason=exc.code,
            )
        if request.human_response:
            await host.process_managed_human_response(request.issue_id, request.human_response)
        try:
            issues = await host.tracker.fetch_issue_states_by_ids([request.issue_id])
        except Exception as exc:
            logger.warning("performer_phase_advance_fetch failed issue_id=%s reason=%s", request.issue_id, exc)
            host._sync_label_group_background(request.issue_id, PHASE_LABELS["failed"], prefix="performer:phase/")
            return self._phase_result(
                request,
                issue_id=request.issue_id,
                next_phase=RunPhase.FAILED,
                status="failed",
                reason=str(exc),
            )
        issue = issues[0] if issues else None
        if issue is None:
            return self._phase_result(
                request,
                issue_id=request.issue_id,
                next_phase=RunPhase.FAILED,
                status="skipped",
                reason="issue_not_found",
            )
        if request.current_phase in {RunPhase.QUEUED, RunPhase.REWORKING}:
            return await self._advance_implementation_phase(request, issue)
        if request.current_phase == RunPhase.REVIEWING:
            return await self._advance_review_phase(request, issue)
        if request.current_phase == RunPhase.AWAITING_HUMAN:
            return self._phase_result(
                request,
                issue_id=issue.id,
                next_phase=RunPhase.AWAITING_HUMAN,
                status="awaiting_human",
                reason="awaiting_human_response",
            )
        if request.current_phase in {RunPhase.DONE, RunPhase.FAILED}:
            return self._phase_result(
                request,
                issue_id=issue.id,
                next_phase=request.current_phase,
                status="completed" if request.current_phase == RunPhase.DONE else "failed",
                reason=f"terminal_phase_{request.current_phase.value}",
            )
        return self._phase_result(
            request,
            issue_id=issue.id,
            next_phase=RunPhase.FAILED,
            status="failed",
            reason=f"unsupported_phase_{request.current_phase.value}",
        )

    async def _advance_implementation_phase(self, request: PhaseAdvanceRequest, issue: Issue) -> PhaseAdvanceResult:
        host = self.host
        reason = host.dispatch_skip_reason_for_event(issue)
        if reason == "acceptance_preflight_required":
            try:
                await host._acceptance_preflight(issue)
            except Exception as exc:
                code = getattr(exc, "code", None)
                if _is_codex_init_error_code(code):
                    return self._phase_result(
                        request,
                        issue_id=issue.id,
                        next_phase=RunPhase.QUEUED,
                        status="init_failed",
                        reason=str(code),
                        retry_delay_seconds=5,
                    )
                raise
            outcome = host.phase_runtime.pop_recorded_outcome(issue.id)
            if outcome is not None:
                return self._phase_result_from_outcome(request, issue, outcome)
            issue = Issue(
                id=issue.id,
                identifier=issue.identifier,
                title=issue.title,
                state=host.config.acceptance.implementation_state,
                description=issue.description,
                priority=issue.priority,
                branch_name=issue.branch_name,
                url=issue.url,
                labels=issue.labels,
                blocked_by=issue.blocked_by,
                created_at=issue.created_at,
                updated_at=issue.updated_at,
                assignee_id=issue.assignee_id,
                delegate_id=issue.delegate_id,
                project_slug=issue.project_slug,
                project_name=issue.project_name,
            )
            reason = host.dispatch_skip_reason_for_event(issue)
        if reason is not None:
            return self._phase_result(
                request,
                issue_id=issue.id,
                next_phase=RunPhase.FAILED if reason in {"missing_required_issue_fields", "project_mismatch"} else request.current_phase,
                status="skipped",
                reason=reason,
            )
        selected_worker_host = host._select_worker_host()
        if host.config.worker.ssh_hosts and selected_worker_host is None:
            return self._phase_result(
                request,
                issue_id=issue.id,
                next_phase=request.current_phase,
                status="skipped",
                reason="no_available_worker_host",
            )
        outcome = await host.phase_runtime.run_worker_for_phase(
            issue,
            attempt=request.attempt,
            worker_host=selected_worker_host,
        )
        return self._phase_result_from_outcome(request, issue, outcome)

    async def _advance_review_phase(self, request: PhaseAdvanceRequest, issue: Issue) -> PhaseAdvanceResult:
        host = self.host
        reason = host.dispatch_skip_reason_without_acceptance(issue)
        if reason is not None:
            return self._phase_result(
                request,
                issue_id=issue.id,
                next_phase=RunPhase.FAILED if reason in {"missing_required_issue_fields", "project_mismatch"} else RunPhase.REVIEWING,
                status="skipped",
                reason=reason,
            )
        await host._run_acceptance_gate_for_issue(issue, completion_verdict=None)
        return self._phase_result_from_outcome(
            request,
            issue,
            host.phase_runtime.pop_outcome(issue.id, default=default_review_phase_outcome()),
        )

    def _phase_result_from_outcome(
        self,
        request: PhaseAdvanceRequest,
        issue: Issue,
        outcome: PhaseExecutionOutcome,
    ) -> PhaseAdvanceResult:
        return self._phase_result(
            request,
            issue_id=issue.id,
            next_phase=outcome.next_phase,
            status=outcome.status,
            reason=outcome.reason,
            retry_delay_seconds=outcome.retry_delay_seconds,
            human_action=outcome.human_action,
            detail=outcome.detail,
            http_status=outcome.http_status,
        )

    def _phase_result(
        self,
        request: PhaseAdvanceRequest,
        *,
        issue_id: str,
        next_phase: RunPhase,
        status: str,
        reason: str | None,
        retry_delay_seconds: int | None = None,
        human_action: dict[str, Any] | None = None,
        detail: str | None = None,
        http_status: int | None = None,
    ) -> PhaseAdvanceResult:
        return PhaseAdvanceResult(
            run_id=request.run_id,
            issue_id=issue_id,
            next_phase=next_phase,
            status=status if status in PHASE_RESULT_STATUSES else "failed",
            reason=reason,
            retry_delay_seconds=retry_delay_seconds,
            detail=detail,
            http_status=http_status,
            human_action=human_action,
            workspace_path=self._phase_workspace_path(request),
            ops_snapshot_path=self._phase_ops_snapshot_path(request),
        )

    def _phase_workspace_path(self, request: PhaseAdvanceRequest) -> str | None:
        configured = request.workspace_context.get("workspace_root")
        root = Path(str(configured)) if configured else self.host.config.workspace.root
        if request.issue_identifier and self.host.config.workspace.per_issue:
            return str(root / request.issue_identifier)
        return str(root) if root else None

    def _phase_ops_snapshot_path(self, request: PhaseAdvanceRequest) -> str | None:
        configured = request.workspace_context.get("ops_snapshot_path")
        if configured:
            return str(configured)
        if self.host.config.persistence.path is None:
            return None
        return str(ops_snapshot_path_from_persistence_path(self.host.config.persistence.path))


def _is_codex_init_error_code(code: Any) -> bool:
    return code in {
        "codex_init_failed",
        "codex_sdk_not_installed",
        "invalid_sdk_codex_bin",
        "invalid_workspace_cwd",
        "sdk_missing_thread_start",
        "sdk_missing_thread_resume",
        "unsupported_sdk_worker_host",
    }
