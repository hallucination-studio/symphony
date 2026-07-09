from __future__ import annotations

from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ManagedRunPlan,
    ManagedRunState,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


def _plan() -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="Implement managed_run",
        architecture_decisions=["Conductor owns state"],
        work_items=[
            WorkItem(
                id="wi-1",
                title="Add contract",
                objective="Create shared contract",
                slice_type=WorkItemSliceType.CONTRACT_FIRST,
                acceptance_criteria=["contract roundtrips"],
                verification=WorkItemVerification(red_command="pytest tests/test_managed_run_contracts.py -q", green_commands=["pytest tests/test_managed_run_contracts.py -q"]),
                dependencies=[],
                estimated_scope="S",
                files_likely_touched=["packages/performer-api/src/performer_api/managed_run.py"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="shared contract"),
            ),
            WorkItem(
                id="wi-2",
                title="Add store",
                objective="Persist runs",
                slice_type=WorkItemSliceType.VERTICAL,
                acceptance_criteria=["store recovers"],
                verification=WorkItemVerification(red_command="pytest tests/test_conductor_managed_run_store.py -q", green_commands=["pytest tests/test_conductor_managed_run_store.py -q"]),
                dependencies=["wi-1"],
                estimated_scope="S",
                files_likely_touched=["packages/conductor/src/conductor/conductor_managed_run_store.py"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="depends on contract"),
            ),
        ],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["acceptance passes"],
            quality=["scope checked"],
            integration=["tests pass"],
            documentation=["Linear projection updated"],
            ship_readiness=["risks recorded"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


def test_managed_run_store_persists_run_plan_and_recovery_cursor(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "issue_title": "Build managed_run",
            "issue_description": "Replace scheduler",
            "agent_session_id": "agent-session-1",
        },
        instance_id="instance-1",
    )

    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")
    store.update_work_item_state(run.run_id, "wi-1", WorkItemState.DONE, gate_status="verification passed")

    reopened = ConductorManagedRunStore(tmp_path)
    loaded = reopened.get_run(run.run_id)
    cursor = reopened.recovery_cursor(run.run_id)

    assert loaded is not None
    assert loaded["state"] == ManagedRunState.READY.value
    assert loaded["backend_session_id"] == "thread-1"
    assert [item["work_item_id"] for item in reopened.list_work_items(run.run_id)] == ["wi-1", "wi-2"]
    assert cursor["next_work_item_id"] == "wi-2"
    assert cursor["verified_work_item_ids"] == ["wi-1"]


def test_managed_run_store_records_linear_projection_idempotently(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-2"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")

    first = store.record_linear_projection(run.run_id, "wi-1", linear_issue_id="child-1", metadata={"state": "todo"})
    second = store.record_linear_projection(run.run_id, "wi-1", linear_issue_id="child-1", metadata={"state": "in_progress"})

    assert first["projection_id"] == second["projection_id"]
    assert second["metadata"] == {"state": "in_progress"}


def test_managed_run_store_preserves_result_when_only_state_changes(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-2"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")
    result = {"changed_files": [{"path": "src/a.py", "action": "modified"}]}

    store.update_work_item_state(run.run_id, "wi-1", WorkItemState.IN_REVIEW, gate_status="ready", result=result)
    store.update_work_item_state(run.run_id, "wi-1", WorkItemState.DONE, gate_status="verified")

    item = store.list_work_items(run.run_id)[0]
    assert item["state"] == WorkItemState.DONE.value
    assert item["result"] == result


def test_managed_run_store_records_checkpoint_results(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-2"}, instance_id="instance-1")

    result = store.record_checkpoint_result(
        run.run_id,
        after=["wi-1"],
        verify=["pytest -q"],
        passed=True,
        reason="pytest passed",
    )

    assert result["checkpoint_key"] == "wi-1::pytest -q"
    assert store.list_checkpoint_results(run.run_id)[0]["passed"] is True
    assert store.managed_run_view()["runs"][0]["checkpoint_results"][0]["reason"] == "pytest passed"


def test_managed_run_view_uses_run_and_work_item_language(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-3"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")

    view = store.managed_run_view()

    assert view["runs"][0]["run_id"] == run.run_id
    assert "graph_revision" not in view
    assert view["runs"][0]["work_items"][0]["state"] == WorkItemState.TODO.value
