from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_scheduler import OrchestrationScheduler
from conductor.conductor_store import ConductorStore


class Runtime:
    def __init__(self) -> None:
        self.started: list[str] = []

    async def start(self, instance, *, env, advance_request_path, phase_result_path):
        self.started.append(advance_request_path)
        return instance.with_updates(process_status="running", pid=123)


def make_instance(tmp_path: Path) -> InstanceRecord:
    instance_dir = tmp_path / "conductor-data" / "instances" / "inst-1"
    return InstanceRecord.create(
        id="inst-1",
        name="Main",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(instance_dir),
        workflow_path=str(instance_dir / "WORKFLOW.md"),
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={},
        workflow_profile="default",
        workflow_inputs={},
    )


@pytest.mark.asyncio
async def test_scheduler_starts_due_run_through_runtime_boundary(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    run = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    started = await scheduler.start_due_runs()

    updated = store.get_orchestration_run(run.run_id)
    assert started == 1
    assert updated is not None
    assert updated.phase.value == "implementing"
    assert updated.request_path is not None
    assert Path(updated.request_path).exists()
    assert runtime.started == [updated.request_path]
