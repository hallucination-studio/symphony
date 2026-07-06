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

class CompletionMixin:
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
        entry = self.state.finish_running(issue_id)
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
                            self._transition_issue_outcome(
                                issue_id,
                                next_phase=RunPhase.REVIEWING,
                                status="reviewing",
                                reason="implementation_ready_for_review",
                                persist=False,
                            )
                            logger.info("performer_completion_verified_review issue_id=%s", issue_id)
                            self._persist_state()
                            return
                        else:
                            if self.config.completion_verification.enabled and verdict.checks:
                                self._transition_issue_outcome(
                                    issue_id,
                                    next_phase=RunPhase.DONE,
                                    status="completed",
                                    reason="completed_by_runtime",
                                    mark_completed=True,
                                    persist=False,
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
                            self.state.forget_active(issue_id)
                            logger.info("performer_acceptance_direct_done_handled issue_id=%s", issue_id)
                            self._persist_state()
                            return
                        self._transition_issue_outcome(
                            issue_id,
                            next_phase=RunPhase.DONE,
                            status="completed",
                            reason="completed_by_runtime",
                            mark_completed=True,
                            persist=False,
                        )
                        logger.info(f"performer_completion_verified issue_id={issue_id} reason={verdict.reason}")
                    elif refreshed_issue is not None:
                        await self._comment_handoff_preserved(entry, refreshed_issue)
                        self._transition_issue_outcome(
                            issue_id,
                            next_phase=RunPhase.REVIEWING,
                            status="reviewing",
                            reason="implementation_handed_off",
                            persist=False,
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
                    else:
                        # 不自动重试，标记失败并等待人工介入
                        logger.error(f"performer_completion_verification_failed_no_retry issue_id={issue_id}")
                        await self._comment_completion_verdict(entry, verdict, next_action="human_review")
                        self._transition_issue_outcome(
                            issue_id,
                            next_phase=RunPhase.FAILED,
                            status="failed",
                            reason=f"verification_failed: {verdict.reason}",
                            persist=False,
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
                            return
                        await self._sync_label_group(
                            review_issue.id,
                            self.config.acceptance.gate_pending_label,
                            prefix="performer:gate/",
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
                    if self.config.acceptance.enabled:
                        self.state.forget_active(issue_id, keep_human_intervention=True)
                    else:
                        self.phase_runtime.record_outcome(
                            issue_id,
                            next_phase=RunPhase.AWAITING_HUMAN,
                            status="awaiting_human",
                            reason=f"verification_needs_human: {verdict.reason}",
                        )

            except Exception as exc:
                # 验证器本身异常也不能直接放行为完成
                logger.exception(f"performer_completion_verification_error issue_id={issue_id} error={exc}")
                self.state.release(issue_id)
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
                self.state.forget_active(issue_id)
                self.phase_runtime.record_outcome(
                    issue_id,
                    next_phase=RunPhase.QUEUED,
                    status="init_failed",
                    reason=error_code or "codex_init_failed",
                    retry_delay_seconds=5,
                )
            elif error_code == "upstream_overloaded_exhausted":
                self.state.forget_active(issue_id)
                self.phase_runtime.record_outcome(
                    issue_id,
                    next_phase=RunPhase.QUEUED,
                    status="upstream_overloaded",
                    reason=error_code,
                    retry_delay_seconds=5,
                    detail=error,
                    http_status=http_status,
                )
            elif entry.human_blocked_reason:
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="runtime_permission",
                    attempt=next_attempt,
                    error=entry.human_blocked_reason,
                    resume_strategy="retry",
                )
            else:
                await self._create_human_intervention_for_entry(
                    entry,
                    kind="runtime_error",
                    attempt=next_attempt,
                    error=retry_error,
                    resume_strategy="retry",
                )
        self._persist_state()

    def _transition_issue_outcome(
        self,
        issue_id: str,
        *,
        next_phase: RunPhase,
        status: str,
        reason: str | None,
        retry_delay_seconds: int | None = None,
        human_action: dict[str, Any] | None = None,
        detail: str | None = None,
        http_status: int | None = None,
        mark_completed: bool = False,
        keep_claimed: bool = False,
        persist: bool = True,
    ) -> None:
        if mark_completed:
            entry = self.state.running.get(issue_id)
            if entry is not None:
                self._mark_codex_thread_terminal(entry, status="completed")
            else:
                existing = self.state.codex_threads.get(issue_id)
                if existing is not None and existing.status != "completed":
                    self.state.codex_threads[issue_id] = CodexThreadEntry(
                        issue_id=existing.issue_id,
                        thread_id=existing.thread_id,
                        backend=existing.backend,
                        workspace_path=existing.workspace_path,
                        last_turn_id=existing.last_turn_id,
                        status="completed",
                        last_final_response=existing.last_final_response,
                        updated_at=utc_now(),
                    )
            self.state.mark_completed(issue_id)
        elif keep_claimed:
            self.state.claim(issue_id)
        else:
            self.state.forget_active(issue_id, keep_human_intervention=next_phase is RunPhase.AWAITING_HUMAN)
        self.phase_runtime.record_outcome(
            issue_id,
            next_phase=next_phase,
            status=status,
            reason=reason,
            retry_delay_seconds=retry_delay_seconds,
            human_action=human_action,
            detail=detail,
            http_status=http_status,
        )
        if persist:
            self._persist_state()

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
        return None

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

    def _schedule_blocked(self, entry: RunningEntry, *, error: str, attempt: int) -> None:
        blocked_entry = BlockedEntry(
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
        self.state.mark_blocked(blocked_entry)
        self.phase_runtime.record_outcome(
            entry.issue.id,
            next_phase=RunPhase.FAILED,
            status="failed",
            reason=error,
        )
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

    def _mark_codex_thread_terminal(self, entry: RunningEntry, *, status: str) -> None:
        thread_id = entry.thread_id
        if not isinstance(thread_id, str) or not thread_id:
            existing = self.state.codex_threads.get(entry.issue.id)
            thread_id = existing.thread_id if existing is not None else None
        if not isinstance(thread_id, str) or not thread_id:
            return
        existing = self.state.codex_threads.get(entry.issue.id)
        workspace_path = entry.workspace_path or (existing.workspace_path if existing is not None else str(self.config.workspace.root))
        self.state.codex_threads[entry.issue.id] = CodexThreadEntry(
            issue_id=entry.issue.id,
            thread_id=thread_id,
            backend=existing.backend if existing is not None else "sdk",
            workspace_path=workspace_path,
            last_turn_id=entry.turn_id or (existing.last_turn_id if existing is not None else None),
            status=status,
            last_final_response=entry.last_codex_message or (existing.last_final_response if existing is not None else None),
            updated_at=utc_now(),
        )
        if self.persistence_store is not None:
            self._persist_state()
