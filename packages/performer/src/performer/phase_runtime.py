from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from performer_api.models import Issue, RunningEntry, utc_now
from performer_api.phase import RunPhase


PHASE_RESULT_STATUSES: set[str] = {
    "accepted",
    "completed",
    "failed",
    "awaiting_human",
    "init_failed",
    "retry",
    "reviewing",
    "reworking",
    "skipped",
    "upstream_overloaded",
}


@dataclass(frozen=True)
class PhaseExecutionOutcome:
    next_phase: RunPhase
    status: str
    reason: str | None
    retry_delay_seconds: int | None = None
    human_action: dict[str, Any] | None = None
    detail: str | None = None
    http_status: int | None = None


class PhaseRuntimeHost(Protocol):
    state: Any

    def _set_running_phase(self, issue_id: str, phase: str, *, runtime_phase: str | None = None) -> None: ...
    async def _sync_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> None: ...
    def _persist_state(self) -> None: ...
    async def _run_worker(self, issue: Issue, attempt: int | None, *, worker_host: str | None = None) -> None: ...


class PhaseRuntime:
    def __init__(self, host: PhaseRuntimeHost):
        self.host = host
        self._outcomes: dict[str, PhaseExecutionOutcome] = {}

    def record_outcome(
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
    ) -> None:
        self._outcomes[issue_id] = PhaseExecutionOutcome(
            next_phase=next_phase,
            status=status if status in PHASE_RESULT_STATUSES else "failed",
            reason=reason,
            retry_delay_seconds=retry_delay_seconds,
            human_action=human_action,
            detail=detail,
            http_status=http_status,
        )

    def pop_outcome(self, issue_id: str, *, default: PhaseExecutionOutcome) -> PhaseExecutionOutcome:
        return self._outcomes.pop(issue_id, default)

    def pop_recorded_outcome(self, issue_id: str) -> PhaseExecutionOutcome | None:
        return self._outcomes.pop(issue_id, None)

    async def run_worker_for_phase(
        self,
        issue: Issue,
        attempt: int | None,
        *,
        worker_host: str | None = None,
    ) -> PhaseExecutionOutcome:
        host = self.host
        self._outcomes.pop(issue.id, None)
        host.state.release_completed(issue.id)
        host.state.mark_running(
            RunningEntry(
                issue=issue,
                task=None,
                started_at=utc_now(),
                retry_attempt=attempt or 0,
                worker_host=worker_host,
            )
        )
        host._set_running_phase(issue.id, "starting", runtime_phase="dispatch_received")
        host._persist_state()
        await host._run_worker(issue, attempt, worker_host=worker_host)
        return self.pop_outcome(
            issue.id,
            default=default_implementation_phase_outcome(),
        )


def default_implementation_phase_outcome() -> PhaseExecutionOutcome:
    return PhaseExecutionOutcome(
        next_phase=RunPhase.REVIEWING,
        status="reviewing",
        reason="implementation_ready_for_review",
    )


def default_review_phase_outcome() -> PhaseExecutionOutcome:
    return PhaseExecutionOutcome(
        next_phase=RunPhase.REWORKING,
        status="reworking",
        reason="acceptance_gate_not_completed",
    )
