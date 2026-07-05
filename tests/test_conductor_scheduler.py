from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_scheduler import OrchestrationScheduler, SchedulerPolicy
from conductor.conductor_store import ConductorStore


class Runtime:
    def __init__(self) -> None:
        self.started: list[str] = []

    async def start(self, instance, *, env, advance_request_path, phase_result_path):
        self.started.append(advance_request_path)
        return instance.with_updates(process_status="running", pid=123)


def make_instance(tmp_path: Path, *, instance_id: str = "inst-1") -> InstanceRecord:
    instance_dir = tmp_path / "conductor-data" / "instances" / instance_id
    return InstanceRecord.create(
        id=instance_id,
        name=instance_id,
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(instance_dir),
        workflow_path=str(instance_dir / "WORKFLOW.md"),
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801 + int(instance_id.rsplit("-", 1)[-1]),
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


@pytest.mark.asyncio
async def test_scheduler_applies_global_capacity_before_starting_due_runs(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instances = [make_instance(tmp_path, instance_id=f"inst-{index}") for index in range(1, 4)]
    for instance in instances:
        store.create_instance(instance)
        reducer.dispatch_received(
            instance_id=instance.id,
            issue_id=f"issue-{instance.id}",
            issue_identifier=f"ENG-{instance.id[-1]}",
            workflow_profile="default",
            dispatch_id=None,
        )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
        policy=SchedulerPolicy(global_capacity=2),
    )

    started = await scheduler.start_due_runs()

    assert started == 2
    assert len(runtime.started) == 2
    running = [
        run.issue_id
        for run in store.list_orchestration_runs()
        if run.phase.value in {"implementing", "reviewing", "reworking"}
    ]
    assert len(running) == 2


@pytest.mark.asyncio
async def test_scheduler_rotates_due_runs_fairly_across_instances(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    first = make_instance(tmp_path, instance_id="inst-1")
    second = make_instance(tmp_path, instance_id="inst-2")
    store.create_instance(first)
    store.create_instance(second)
    for issue in ["issue-a", "issue-b"]:
        reducer.dispatch_received(
            instance_id=first.id,
            issue_id=issue,
            issue_identifier=issue.upper(),
            workflow_profile="default",
            dispatch_id=None,
        )
    reducer.dispatch_received(
        instance_id=second.id,
        issue_id="issue-c",
        issue_identifier="ISSUE-C",
        workflow_profile="default",
        dispatch_id=None,
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
        policy=SchedulerPolicy(global_capacity=2),
    )

    started = await scheduler.start_due_runs()

    assert started == 2
    started_issue_ids = [
        Path(path).read_text(encoding="utf-8")
        for path in runtime.started
    ]
    assert any('"issue_id":"issue-a"' in payload or '"issue_id":"issue-b"' in payload for payload in started_issue_ids)
    assert any('"issue_id":"issue-c"' in payload for payload in started_issue_ids)
