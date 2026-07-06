from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .conductor_linear_direct import ProjectLabelLinearProxy, RepositoryHandoffLinearProxy
from .conductor_models import InstanceRecord
from .conductor_phase import PhaseTransitionError
from .conductor_repository_handoff import (
    RepositoryHandoffCoordinator,
    comment_repository_handoff,
    find_repository_integration_child,
)
from .conductor_scheduler import phase_file_paths
from .conductor_service_helpers import *  # noqa: F403
from .conductor_service_types import *  # noqa: F403
from performer_api.ops_models import TraceEvent
from performer_api.ops_store import OpsStore
from performer_api.phase import PhaseAdvanceResult, RunPhase
from performer_api.persistence import PersistenceStore
from performer_api.workflow import load_workflow


class ConductorPhaseOpsMixin:
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
                expected_current_phases={run.phase},
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
            service_module = sys.modules.get("conductor.conductor_service")
            workflow_loader = getattr(service_module, "load_workflow", load_workflow)
            raw = workflow_loader(Path(instance.workflow_path)).config
            codex = raw.get("codex") if isinstance(raw.get("codex"), dict) else {}
        except Exception:
            return 3_665
        turn_timeout_ms = _config_int(codex.get("turn_timeout_ms"), 3_600_000)
        hard_turn_timeout_ms = _config_int(codex.get("hard_turn_timeout_ms"), turn_timeout_ms)
        read_timeout_ms = _config_int(codex.get("read_timeout_ms"), 5_000)
        hard_turn_timeout_ms = max(0, hard_turn_timeout_ms)
        read_timeout_ms = max(0, read_timeout_ms)
        if hard_turn_timeout_ms <= 0 and read_timeout_ms <= 0:
            hard_turn_timeout_ms = CONDUCTOR_STALL_TIMEOUT_FLOOR_MS
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
                expected_current_phases={run.phase},
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
            expected_current_phases={run.phase},
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
