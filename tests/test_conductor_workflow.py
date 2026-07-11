from __future__ import annotations

import pytest

from conductor.models import RunState, TaskState
from conductor.store import ConductorStore, StaleAttemptError
from conductor.workflow import Workflow


def test_parent_plan_creates_ordered_linear_tasks(tmp_path, two_task_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")

    workflow.commit_plan(run["run_id"], two_task_plan)

    assert workflow.store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value
    assert [task["task_id"] for task in workflow.store.list_tasks(run["run_id"])] == ["task-1", "task-2"]
    assert all(task["parent_issue_id"] == "parent-1" for task in workflow.store.list_tasks(run["run_id"]))


def test_plan_approval_is_durable_before_execution(tmp_path, minimal_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")

    version = workflow.commit_plan(run["run_id"], minimal_plan, approval_required=True)
    assert workflow.store.get_run(run["run_id"])["state"] == RunState.AWAITING_APPROVAL.value

    workflow.approve_plan(run["run_id"], version, approval_id="linear-comment-1")

    assert workflow.store.get_run(run["run_id"])["state"] == RunState.EXECUTING.value


def test_gate_failure_allows_one_rework_then_blocks_task_and_parent(tmp_path, minimal_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    workflow.commit_plan(run["run_id"], minimal_plan)
    task = workflow.next_task(run["run_id"])

    first = workflow.start_task(run["run_id"], task["task_id"])
    workflow.record_execute(run["run_id"], first["attempt_id"], first["fencing_token"], ready_for_gate=True)
    result = workflow.record_gate(run["run_id"], first["attempt_id"], first["fencing_token"], passed=False, score=2)
    assert result["state"] == TaskState.IN_PROGRESS.value
    assert result["rework_count"] == 1

    second = workflow.start_task(run["run_id"], task["task_id"])
    workflow.record_execute(run["run_id"], second["attempt_id"], second["fencing_token"], ready_for_gate=True)
    blocked = workflow.record_gate(run["run_id"], second["attempt_id"], second["fencing_token"], passed=False, score=2)

    assert blocked["state"] == TaskState.BLOCKED.value
    assert workflow.store.get_run(run["run_id"])["state"] == RunState.BLOCKED.value


def test_gate_score_below_threshold_fails_even_when_codex_claims_passed(tmp_path, minimal_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    workflow.commit_plan(run["run_id"], minimal_plan)
    task = workflow.next_task(run["run_id"])
    attempt = workflow.start_task(run["run_id"], task["task_id"])
    workflow.record_execute(run["run_id"], attempt["attempt_id"], attempt["fencing_token"], ready_for_gate=True)

    result = workflow.record_gate(run["run_id"], attempt["attempt_id"], attempt["fencing_token"], passed=True, score=2)

    assert result["state"] == TaskState.IN_PROGRESS.value


def test_all_tasks_done_marks_parent_done(tmp_path, two_task_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    workflow.commit_plan(run["run_id"], two_task_plan)

    for task in workflow.store.list_tasks(run["run_id"]):
        attempt = workflow.start_task(run["run_id"], task["task_id"])
        workflow.record_execute(run["run_id"], attempt["attempt_id"], attempt["fencing_token"], ready_for_gate=True)
        workflow.record_gate(run["run_id"], attempt["attempt_id"], attempt["fencing_token"], passed=True, score=4)

    assert workflow.store.get_run(run["run_id"])["state"] == RunState.DONE.value


def test_stale_attempt_cannot_change_task_state(tmp_path, minimal_plan) -> None:
    workflow = Workflow(ConductorStore(tmp_path / "workflow.db"))
    run = workflow.accept_parent("parent-1", "APP-1", instance_id="instance-1")
    workflow.commit_plan(run["run_id"], minimal_plan)
    task = workflow.next_task(run["run_id"])
    attempt = workflow.start_task(run["run_id"], task["task_id"])

    with pytest.raises(StaleAttemptError):
        workflow.record_execute(run["run_id"], attempt["attempt_id"], attempt["fencing_token"] - 1, ready_for_gate=True)

    assert workflow.store.get_task(run["run_id"], task["task_id"])["state"] == TaskState.IN_PROGRESS.value
