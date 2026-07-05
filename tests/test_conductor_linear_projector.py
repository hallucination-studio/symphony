from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_linear_projector import LinearProjector
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


class FailingProjectionTracker:
    def __init__(self) -> None:
        self.project_attempts = 0

    async def project_issue_phase(self, issue_id: str, *, phase_label: str, state_name: str | None) -> dict[str, object]:
        self.project_attempts += 1
        raise RuntimeError("Linear 502")


@pytest.mark.asyncio
async def test_linear_projector_backs_off_and_escalates_failures(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    tracker = FailingProjectionTracker()
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    projector = LinearProjector(
        store=store,
        get_instance=lambda instance_id: object(),
        tracker_factory=lambda instance: tracker,
    )

    await projector.reconcile_once(now="2026-07-05T00:00:00Z")
    await projector.reconcile_once(now="2026-07-05T00:00:10Z")
    await projector.reconcile_once(now="2026-07-05T00:00:31Z")
    await projector.reconcile_once(now="2026-07-05T00:01:32Z")
    await projector.reconcile_once(now="2026-07-05T00:03:33Z")

    updated = store.get_orchestration_run(run.run_id)
    events = store.list_orchestration_events(run.run_id)
    failed_events = [event for event in events if event.event_type == "linear.phase_projection_failed"]
    assert tracker.project_attempts == 4
    assert [event.payload["failure_count"] for event in failed_events] == [1, 2, 3]
    assert updated is not None
    assert updated.phase is RunPhase.FAILED
    assert events[-1].event_type == "linear.phase_projection_escalated"
