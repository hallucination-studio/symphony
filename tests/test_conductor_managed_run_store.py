from __future__ import annotations

from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    GateSnapshot,
    TaskOutputManifest,
    VerificationInputSnapshot,
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


def test_managed_run_store_freezes_gate_snapshots_when_plan_is_saved(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-4"}, instance_id="instance-1")

    version = store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")
    snapshots = store.list_gate_snapshots(run.run_id)

    assert version == 1
    assert [snapshot["work_item_id"] for snapshot in snapshots] == ["wi-1", "wi-2"]
    assert all(snapshot["frozen"] is True for snapshot in snapshots)
    assert all(snapshot["pass_threshold"] == 3 for snapshot in snapshots)
    assert all(str(snapshot["content_hash"]).startswith("sha256:") for snapshot in snapshots)
    loaded = GateSnapshot.from_dict(store.get_gate_snapshot(str(snapshots[0]["content_hash"])) or {})
    assert loaded.validation_errors() == []


def test_managed_run_store_records_verification_inputs_and_publishes_manifests(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-5"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")
    gate_hash = str(store.list_gate_snapshots(run.run_id)[0]["content_hash"])
    verification_input = VerificationInputSnapshot(
        work_item_id="wi-1",
        execute_attempt_id="execute-1",
        base_revision="base-sha",
        branch_name="managed-run/wi-1",
        commit_sha="commit-sha",
        no_change=False,
        artifact_hashes=[{"uri": "artifact://bundle", "sha256": "abc"}],
        declared_commands=["pytest -q"],
        evidence_uri="artifact://evidence/wi-1.json",
        gate_snapshot_hash=gate_hash,
    )
    manifest = TaskOutputManifest(
        work_item_id="wi-1",
        verify_attempt_id="verify-1",
        plan_version=1,
        score=3,
        branch_name="managed-run/wi-1",
        commit_sha="commit-sha",
        artifacts=[{"uri": "artifact://bundle", "sha256": "abc"}],
        created_at="2026-07-09T00:01:00Z",
    )

    store.record_verification_input(run.run_id, verification_input)
    store.publish_task_output_manifest(run.run_id, manifest)

    view = store.managed_run_view()["runs"][0]
    assert view["verification_inputs"][0]["gate_snapshot_hash"] == gate_hash
    assert view["manifests"][0]["verify_attempt_id"] == "verify-1"
    assert view["manifests"][0]["score"] == 3


def test_managed_run_view_exposes_complete_evidence_bundle(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-6"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")
    gate_hash = str(store.list_gate_snapshots(run.run_id)[0]["content_hash"])
    store.record_verification_input(
        run.run_id,
        VerificationInputSnapshot(
            work_item_id="wi-1",
            execute_attempt_id="execute-1",
            base_revision="base-sha",
            branch_name="managed-run/wi-1",
            commit_sha="commit-sha",
            no_change=False,
            artifact_hashes=[{"path": "result.txt", "sha256": "abc"}],
            declared_commands=["pytest -q"],
            evidence_uri="artifact://evidence/wi-1.json",
            gate_snapshot_hash=gate_hash,
        ),
    )
    store.publish_task_output_manifest(
        run.run_id,
        TaskOutputManifest(
            work_item_id="wi-1",
            verify_attempt_id="verify-1",
            plan_version=1,
            score=3,
            branch_name="managed-run/wi-1",
            commit_sha="commit-sha",
            artifacts=[{"path": "result.txt", "sha256": "abc"}],
            created_at="2026-07-09T00:01:00Z",
        ),
    )
    store.record_checkpoint_result(run.run_id, after=["wi-1"], verify=["pytest -q"], passed=True, reason="pytest passed")
    store.merge_run_payload(
        run.run_id,
        {
            "branch_joins": [{"status": "integrated", "branch_name": "managed-run/run-1/wi-2/join"}],
            "final_completion_report": {
                "rubric_results": [{"area": "correctness", "status": "passed", "evidence": [gate_hash]}],
                "residual_risks": [],
            },
        },
    )

    bundle = store.managed_run_view()["runs"][0]["evidence_bundle"]

    assert bundle["gate_snapshot_hashes"][0] == gate_hash
    assert bundle["verification_inputs"][0]["execute_attempt_id"] == "execute-1"
    assert bundle["manifests"][0]["verify_attempt_id"] == "verify-1"
    assert bundle["branch_joins"][0]["status"] == "integrated"
    assert bundle["checkpoint_results"][0]["reason"] == "pytest passed"
    assert bundle["final_rubric_results"][0]["area"] == "correctness"


def test_managed_run_view_uses_run_and_work_item_language(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-3"}, instance_id="instance-1")
    store.save_plan(run.run_id, _plan(), backend_session_id="thread-1")

    view = store.managed_run_view()

    assert view["runs"][0]["run_id"] == run.run_id
    assert "graph_revision" not in view
    assert view["runs"][0]["work_items"][0]["state"] == WorkItemState.TODO.value


def test_managed_run_view_reports_duplicate_attempt_as_integrity_error_without_duplicate_rows(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    run = store.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-7"}, instance_id="instance-1")
    duplicate = {"attempt_id": "work-item-1", "kind": "work_item", "work_item_id": "wi-1"}
    store.merge_run_payload(
        run.run_id,
        {
            "completed_attempts": [{**duplicate, "state": "succeeded", "completed_at": "2026-07-10T00:00:01Z"}],
            "active_attempts": [{**duplicate, "state": "running"}],
        },
    )

    view = store.managed_run_view()

    assert [attempt["state"] for attempt in view["attempts"]] == ["succeeded"]
    assert view["runs"][0]["attempt_integrity"] == {"passed": False, "errors": ["active_attempt_already_terminal:work-item-1"]}
    assert view["attempt_integrity"]["passed"] is False
