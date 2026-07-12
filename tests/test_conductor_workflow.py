from __future__ import annotations

import pytest

from conductor.models import RunState, TaskState
from conductor.store import ConductorStore, StaleAttemptError


def _store(tmp_path) -> ConductorStore:
    return ConductorStore(tmp_path)


def _execute_and_gate(store: ConductorStore, run_id: str, task_id: str, *, passed: bool, score: int) -> dict[str, object]:
    execute = store.start_task(run_id, task_id)
    store.record_execute(run_id, execute["attempt_id"], execute["fencing_token"], ready_for_gate=True)
    gate = store.start_gate(run_id, task_id)
    return store.record_gate(run_id, gate["attempt_id"], gate["fencing_token"], passed=passed, score=score)


def test_parent_plan_creates_ordered_linear_tasks(tmp_path, two_task_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    store.save_plan(run["run_id"], two_task_plan)

    assert store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value
    assert [task["task_id"] for task in store.list_tasks(run["run_id"])] == ["task-1", "task-2"]
    assert all(task["parent_issue_id"] == "parent-1" for task in store.list_tasks(run["run_id"]))


def test_plan_approval_is_durable_before_execution(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")

    version = store.save_plan(run["run_id"], minimal_plan, approval_required=True)
    assert store.get_run(run["run_id"])["state"] == RunState.AWAITING_APPROVAL.value

    store.approve_plan(run["run_id"], version, approval_id="linear-comment-1")

    assert store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value


def test_gate_failure_allows_one_rework_then_blocks_task_and_parent(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])

    result = _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)
    assert result["state"] == TaskState.IN_PROGRESS.value
    assert result["rework_count"] == 1

    blocked = _execute_and_gate(store, run["run_id"], task["task_id"], passed=False, score=2)

    assert blocked["state"] == TaskState.BLOCKED.value
    assert store.get_run(run["run_id"])["state"] == RunState.BLOCKED.value


def test_gate_score_below_threshold_fails_even_when_codex_claims_passed(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    result = _execute_and_gate(store, run["run_id"], task["task_id"], passed=True, score=2)

    assert result["state"] == TaskState.IN_PROGRESS.value


def test_all_tasks_done_marks_parent_done(tmp_path, two_task_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], two_task_plan)

    for task in store.list_tasks(run["run_id"]):
        _execute_and_gate(store, run["run_id"], task["task_id"], passed=True, score=4)

    assert store.get_run(run["run_id"])["state"] == RunState.DONE.value


def test_stale_attempt_cannot_change_task_state(tmp_path, minimal_plan) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.save_plan(run["run_id"], minimal_plan)
    task = store.next_task(run["run_id"])
    attempt = store.start_task(run["run_id"], task["task_id"])

    with pytest.raises(StaleAttemptError):
        store.record_execute(run["run_id"], attempt["attempt_id"], attempt["fencing_token"] - 1, ready_for_gate=True)

    assert store.get_task(run["run_id"], task["task_id"])["state"] == TaskState.IN_PROGRESS.value


def test_runtime_wait_is_durable_and_can_resume_once_reopened(tmp_path) -> None:
    store = _store(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    attempt = store.start_plan(run["run_id"])

    store.record_runtime_wait(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        kind="approval_requested",
        reason="Approve the tool call",
    )

    assert store.get_run(run["run_id"])["state"] == RunState.BLOCKED.value
    assert store.resume_runtime_wait(run["run_id"]) is True
    assert store.get_run(run["run_id"])["state"] == RunState.PLANNING.value
    assert store.list_runtime_waits(run["run_id"])[0]["state"] == "resolved"
