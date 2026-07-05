from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_ingress import DirectIngress
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_store import ConductorStore


class FakeTracker:
    def __init__(self, issues: list[dict[str, object]]) -> None:
        self.issues = issues

    async def fetch_candidate_issues(self) -> list[dict[str, object]]:
        return list(self.issues)


class Instance:
    id = "inst-1"
    process_status = "exited"
    workflow_profile = "default"


@pytest.mark.asyncio
async def test_direct_ingress_records_dispatch_without_starting_phase(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    instance = Instance()
    ingress = DirectIngress(
        store=store,
        phase_reducer=reducer,
        list_instances=lambda: [instance],
        get_instance=lambda instance_id: instance,
        tracker_factory=lambda instance: FakeTracker(
            [{"id": "issue-1", "identifier": "ENG-1", "title": "Do it", "state": "Todo"}]
        ),
    )

    received = await ingress.poll()

    run = store.get_orchestration_run_by_issue("inst-1", "issue-1")
    assert received == 1
    assert run is not None
    assert run.phase.value == "queued"
    assert [event.event_type for event in store.list_orchestration_events(run.run_id)] == ["dispatch.created"]
