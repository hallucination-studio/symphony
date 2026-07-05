from __future__ import annotations

import json
from pathlib import Path

import pytest

from conductor.conductor_performer_supervisor import PerformerSupervisor
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


@pytest.mark.asyncio
async def test_performer_supervisor_applies_phase_result_file(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path=str(tmp_path / "result.json"))
    Path(tmp_path / "result.json").write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
            ).to_dict()
        ),
        encoding="utf-8",
    )
    diagnostics: list[str] = []
    supervisor = PerformerSupervisor(
        store=store,
        phase_reducer=reducer,
        comment_result_diagnostic=lambda run_id, result: diagnostics.append(run_id),
    )

    applied = await supervisor.apply_result_files()

    updated = store.get_orchestration_run(run.run_id)
    assert applied == 1
    assert updated is not None
    assert updated.phase is RunPhase.DONE
    assert diagnostics == [run.run_id]
    assert not (tmp_path / "result.json").exists()
