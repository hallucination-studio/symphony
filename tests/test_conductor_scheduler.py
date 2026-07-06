from __future__ import annotations

from pathlib import Path
import json

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_scheduler import OrchestrationScheduler, SchedulerPolicy
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


class Runtime:
    def __init__(self) -> None:
        self.started: list[str] = []

    async def start(self, instance, *, env, advance_request_path, phase_result_path):
        self.started.append(advance_request_path)
        return instance.with_updates(process_status="running", pid=123)


class FailingRuntime(Runtime):
    async def start(self, instance, *, env, advance_request_path, phase_result_path):
        self.started.append(advance_request_path)
        raise RuntimeError("fork failed")


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


def _started_issue_ids(runtime: Runtime) -> list[str]:
    return [json.loads(Path(path).read_text(encoding="utf-8"))["issue_id"] for path in runtime.started]


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
async def test_scheduler_recovers_run_and_instance_when_process_start_fails(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = FailingRuntime()
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
    refreshed = store.get_instance(instance.id)
    assert started == 0
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.status == "queued"
    assert updated.process_pid is None
    assert updated.last_error == "fork failed"
    assert refreshed is not None
    assert refreshed.process_status == "idle"
    assert refreshed.pid is None


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


@pytest.mark.asyncio
async def test_scheduler_does_not_start_run_with_non_terminal_blocker(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    blocker = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocker",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    blocked = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=[blocker.issue_id],
        parent_issue_id="issue-parent",
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    started = await scheduler.start_due_runs()

    assert started == 1
    assert _started_issue_ids(runtime) == [blocker.issue_id]
    assert store.get_orchestration_run(blocked.run_id).phase is RunPhase.QUEUED


@pytest.mark.asyncio
async def test_scheduler_starts_blocked_run_after_blocker_becomes_terminal(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    blocker = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocker",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    blocked = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=[blocker.issue_id],
    )
    reducer.performer_started(blocker.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=blocker.run_id,
            issue_id=blocker.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    store.update_instance(instance.with_updates(process_status="idle", pid=None))
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    assert scheduler.is_dispatchable(blocked) is True


@pytest.mark.asyncio
async def test_scheduler_resolves_blocker_run_across_instances(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    first_instance = make_instance(tmp_path, instance_id="inst-1")
    second_instance = make_instance(tmp_path, instance_id="inst-2")
    store.create_instance(first_instance)
    store.create_instance(second_instance)
    blocker = reducer.dispatch_received(
        instance_id=first_instance.id,
        issue_id="issue-blocker",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    blocked = reducer.dispatch_received(
        instance_id=second_instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=[blocker.issue_id],
    )
    reducer.performer_started(blocker.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=blocker.run_id,
            issue_id=blocker.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    assert scheduler.is_dispatchable(blocked) is True


@pytest.mark.asyncio
async def test_scheduler_treats_blocker_as_terminal_when_any_duplicate_run_is_terminal(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    first_instance = make_instance(tmp_path, instance_id="inst-1")
    second_instance = make_instance(tmp_path, instance_id="inst-2")
    third_instance = make_instance(tmp_path, instance_id="inst-3")
    for instance in [first_instance, second_instance, third_instance]:
        store.create_instance(instance)
    completed_blocker = reducer.dispatch_received(
        instance_id=first_instance.id,
        issue_id="issue-blocker",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(completed_blocker.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=completed_blocker.run_id,
            issue_id=completed_blocker.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    reducer.dispatch_received(
        instance_id=second_instance.id,
        issue_id="issue-blocker",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-2",
    )
    blocked = reducer.dispatch_received(
        instance_id=third_instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id="dispatch-3",
        blocked_by=["issue-blocker"],
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    assert scheduler.is_dispatchable(blocked) is True


@pytest.mark.asyncio
async def test_scheduler_runs_parent_children_in_parallel_and_waits_for_declared_dependency(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instances = [make_instance(tmp_path, instance_id=f"inst-{index}") for index in range(1, 4)]
    for instance in instances:
        store.create_instance(instance)
    first = reducer.dispatch_received(
        instance_id=instances[0].id,
        issue_id="child-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
        parent_issue_id="parent-1",
    )
    second = reducer.dispatch_received(
        instance_id=instances[1].id,
        issue_id="child-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        parent_issue_id="parent-1",
    )
    third = reducer.dispatch_received(
        instance_id=instances[2].id,
        issue_id="child-3",
        issue_identifier="ENG-3",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=[first.issue_id],
        parent_issue_id="parent-1",
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
        policy=SchedulerPolicy(global_capacity=3),
    )

    started = await scheduler.start_due_runs()

    assert started == 2
    assert _started_issue_ids(runtime) == [first.issue_id, second.issue_id]
    assert store.get_orchestration_run(third.run_id).phase is RunPhase.QUEUED


@pytest.mark.asyncio
async def test_scheduler_combines_dependency_readiness_with_global_capacity(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instances = [make_instance(tmp_path, instance_id=f"inst-{index}") for index in range(1, 5)]
    for instance in instances:
        store.create_instance(instance)
        reducer.dispatch_received(
            instance_id=instance.id,
            issue_id=f"issue-{instance.id}",
            issue_identifier=f"ENG-{instance.id[-1]}",
            workflow_profile="default",
            dispatch_id=None,
            parent_issue_id="parent-1",
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
    assert sum(1 for run in store.list_orchestration_runs(phases={RunPhase.IMPLEMENTING})) == 2


def test_scheduler_readiness_counts_split_dispatchable_from_blocked_waiting(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    runtime = Runtime()
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="ready",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=["missing-blocker"],
    )
    scheduler = OrchestrationScheduler(
        store=store,
        phase_reducer=reducer,
        runtime_manager=runtime,
        runtime_env=lambda: {},
        get_instance=store.get_instance,
    )

    assert scheduler.readiness_counts() == {"dispatchable": 1, "blocked_waiting": 1}
