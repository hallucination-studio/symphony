from __future__ import annotations

import logging
import shlex
import sys

import pytest

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ChangedFile,
    Checkpoint,
    ManagedRunPlan,
    ManagedRunState,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


def _item(item_id: str, *, deps: list[str] | None = None) -> WorkItem:
    return WorkItem(
        id=item_id,
        title=f"Implement {item_id}",
        objective=f"Complete {item_id}",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=[f"{item_id} accepted"],
        verification=WorkItemVerification(red_command=f"pytest tests/test_{item_id}.py -q", green_commands=[f"pytest tests/test_{item_id}.py -q"]),
        dependencies=deps or [],
        estimated_scope="S",
        files_likely_touched=[f"src/{item_id}.py"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="sequential dependency"),
    )


def _plan() -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="ManagedRun work",
        architecture_decisions=["Use work items"],
        work_items=[_item("wi-1"), _item("wi-2", deps=["wi-1"])],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["accepted"],
            quality=["scoped"],
            integration=["tested"],
            documentation=["projected"],
            ship_readiness=["risks"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


def _result(item_id: str) -> WorkItemResult:
    return WorkItemResult(
        work_item_id=item_id,
        status_claimed=WorkItemResultStatus.READY_FOR_REVIEW,
        changed_files=[
            ChangedFile(
                path=f"src/{item_id}.py",
                action="modified",
                planned=True,
                reason="implements work item",
                handling="kept",
                verification=[f"pytest tests/test_{item_id}.py -q"],
            )
        ],
        undeclared_files=[],
        tests={
            "red_command": f"pytest tests/test_{item_id}.py -q",
            "red_observed": True,
            "green_commands_run": [f"pytest tests/test_{item_id}.py -q"],
            "secret_scan_passed": True,
        },
        acceptance_results=[{"criterion": f"{item_id} accepted", "status": "passed"}],
        blocked_reason=None,
        plan_revision=None,
        notes="ready",
    )


def test_managed_run_coordinator_accepts_dispatch_and_applies_valid_plan(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")

    version = coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")

    run = coordinator.store.get_run(accepted.run_id)
    assert version == 1
    assert run is not None
    assert run["state"] == ManagedRunState.READY.value
    assert coordinator.next_ready_work_item(accepted.run_id)["work_item_id"] == "wi-1"


def test_managed_run_coordinator_waits_for_required_plan_approval(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    approval_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "approval_required": True})

    version = coordinator.apply_plan(accepted.run_id, approval_plan, backend_session_id="thread-1")
    awaiting = coordinator.store.get_run(accepted.run_id)

    assert version == 1
    assert awaiting is not None
    assert awaiting["state"] == ManagedRunState.AWAITING_APPROVAL.value
    assert awaiting["latest_reason"] == "plan_approval_required"
    assert coordinator.next_ready_work_item(accepted.run_id) is None
    assert [item["work_item_id"] for item in coordinator.store.list_work_items(accepted.run_id)] == ["wi-1", "wi-2"]

    coordinator.approve_plan(accepted.run_id, approval_id="approval-1")
    approved = coordinator.store.get_run(accepted.run_id)

    assert approved is not None
    assert approved["state"] == ManagedRunState.READY.value
    assert approved["latest_reason"] == "plan_approved:approval-1"
    assert coordinator.next_ready_work_item(accepted.run_id)["work_item_id"] == "wi-1"


def test_managed_run_coordinator_rejects_unapproved_replacement_plan_after_acceptance(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")

    with pytest.raises(ValueError, match="accepted plan is immutable"):
        coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-2")

    run = coordinator.store.get_run(accepted.run_id)
    assert run is not None
    assert run["plan_version"] == 1


def test_managed_run_coordinator_rejects_invalid_plan_to_blocked_state(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path), plan_validation_retry_limit=1)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    bad_item = _item("wi-1")
    bad_item = WorkItem.from_dict({**bad_item.to_dict(), "estimated_scope": "L"})
    bad = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [bad_item.to_dict()]})

    result = coordinator.apply_plan(accepted.run_id, bad, backend_session_id="thread-1")

    run = coordinator.store.get_run(accepted.run_id)
    assert result == 0
    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert "work_item_too_large" in run["latest_reason"]


def test_managed_run_coordinator_exhausts_bounded_plan_validation_retries(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path), plan_validation_retry_limit=1)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    bad_item = WorkItem.from_dict({**_item("wi-1").to_dict(), "estimated_scope": "L"})
    bad = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [bad_item.to_dict()]})

    first = coordinator.apply_plan(accepted.run_id, bad, backend_session_id="thread-1")
    second = coordinator.apply_plan(accepted.run_id, bad, backend_session_id="thread-1")

    run = coordinator.store.get_run(accepted.run_id)
    assert first == 0
    assert second == 0
    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert run["latest_reason"] == "plan_validation_retries_exhausted:work_item_too_large"
    assert run["payload"]["plan_validation_failures"] == 2


def test_managed_run_coordinator_logs_blocked_failures(tmp_path, caplog) -> None:
    caplog.set_level(logging.ERROR, logger="conductor.conductor_managed_run_coordinator")
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path), plan_validation_retry_limit=1)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    bad_item = WorkItem.from_dict({**_item("wi-1").to_dict(), "estimated_scope": "L"})
    bad = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [bad_item.to_dict()]})

    coordinator.apply_plan(accepted.run_id, bad, backend_session_id="thread-1")

    message = caplog.records[-1].getMessage()
    assert "event=managed_run_blocked" in message
    assert f"run_id={accepted.run_id}" in message
    assert "error_code=invalid_plan" in message
    assert "sanitized_reason=work_item_too_large" in message
    assert "retryable=false" in message


def test_managed_run_coordinator_advances_work_item_through_review_to_done(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")

    started = coordinator.start_work_item(accepted.run_id, "wi-1")
    reviewed = coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    verified = coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    assert started["state"] == WorkItemState.IN_PROGRESS.value
    assert reviewed["state"] == WorkItemState.IN_REVIEW.value
    assert verified["state"] == WorkItemState.DONE.value
    assert coordinator.next_ready_work_item(accepted.run_id)["work_item_id"] == "wi-2"


def test_managed_run_coordinator_does_not_parallelize_unmarked_independent_work_items(tmp_path) -> None:
    independent = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "work_items": [_item("wi-1").to_dict(), _item("wi-2").to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, independent, backend_session_id="thread-1")

    first = coordinator.next_ready_work_item(accepted.run_id)
    assert first is not None
    coordinator.start_work_item(accepted.run_id, str(first["work_item_id"]))

    assert coordinator.next_ready_work_item(accepted.run_id) is None


def test_managed_run_coordinator_blocks_work_item_until_required_human_approval(tmp_path) -> None:
    approval_item = WorkItem.from_dict({**_item("wi-1").to_dict(), "needs_human_approval": True})
    plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [approval_item.to_dict()]})
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")

    blocked = coordinator.start_work_item(accepted.run_id, "wi-1")
    run = coordinator.store.get_run(accepted.run_id)

    assert blocked["state"] == WorkItemState.BLOCKED.value
    assert blocked["gate_status"] == "human_approval_required"
    assert run is not None
    assert run["state"] == ManagedRunState.AWAITING_APPROVAL.value
    assert run["latest_reason"] == "human_approval_required"

    approved = coordinator.approve_work_item(accepted.run_id, "wi-1", approval_id="approval-1")
    started = coordinator.start_work_item(accepted.run_id, "wi-1")

    assert approved["state"] == WorkItemState.TODO.value
    assert approved["gate_status"] == "human_approval_approved:approval-1"
    assert started["state"] == WorkItemState.IN_PROGRESS.value


def test_managed_run_coordinator_blocks_unplanned_file_changes_before_review(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    result = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "changed_files": [
                {
                    "path": "src/unplanned.py",
                    "action": "created",
                    "planned": False,
                    "reason": "extra change",
                    "handling": "kept",
                    "verification": [],
                }
            ],
            "undeclared_files": ["src/unplanned.py"],
        }
    )

    blocked = coordinator.submit_work_item_result(accepted.run_id, result)
    run = coordinator.store.get_run(accepted.run_id)

    assert blocked["state"] == WorkItemState.BLOCKED.value
    assert blocked["gate_status"] == "undeclared_files:src/unplanned.py,unplanned_changed_files:src/unplanned.py,out_of_scope_files:src/unplanned.py"
    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert run["latest_reason"] == blocked["gate_status"]


def test_managed_run_coordinator_ignores_generated_cache_files_in_review_gate(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    result = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "undeclared_files": [
                "tests/__pycache__/",
                "tests/__pycache__/test_smoke.cpython-314-pytest-9.0.2.pyc",
                ".pytest_cache/v/cache/nodeids",
            ],
        }
    )

    reviewed = coordinator.submit_work_item_result(accepted.run_id, result)

    assert reviewed["state"] == WorkItemState.IN_REVIEW.value
    assert reviewed["gate_status"] == "result ready for managed_run verification"


def test_managed_run_coordinator_blocks_missing_red_green_or_acceptance_evidence(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    result = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "tests": {"red_command": "pytest tests/test_wi-1.py -q", "red_observed": False, "green_commands_run": [], "secret_scan_passed": True},
            "acceptance_results": [{"criterion": "wi-1 accepted", "status": "failed"}],
        }
    )

    blocked = coordinator.submit_work_item_result(accepted.run_id, result)

    assert blocked["state"] == WorkItemState.BLOCKED.value
    assert blocked["gate_status"] == "red_not_observed,missing_green_commands,acceptance_failed"


def test_managed_run_coordinator_blocks_missing_or_failed_secret_checks(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    failed_secret_scan = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "tests": {
                "red_command": "pytest tests/test_wi-1.py -q",
                "red_observed": True,
                "green_commands_run": ["pytest tests/test_wi-1.py -q"],
                "secret_scan_passed": False,
            },
        }
    )

    blocked = coordinator.submit_work_item_result(accepted.run_id, failed_secret_scan)

    assert blocked["state"] == WorkItemState.BLOCKED.value
    assert blocked["gate_status"] == "secrets_check_failed"

    coordinator.store.update_work_item_state(accepted.run_id, "wi-1", WorkItemState.IN_PROGRESS, gate_status="retry")
    missing_secret_scan = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "tests": {
                "red_command": "pytest tests/test_wi-1.py -q",
                "red_observed": True,
                "green_commands_run": ["pytest tests/test_wi-1.py -q"],
            },
        }
    )

    blocked_missing = coordinator.submit_work_item_result(accepted.run_id, missing_secret_scan)

    assert blocked_missing["state"] == WorkItemState.BLOCKED.value
    assert blocked_missing["gate_status"] == "secrets_check_missing"


def test_managed_run_coordinator_keeps_failed_verification_out_of_done(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))

    failed = coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification failed: smoke", passed=False)
    run = coordinator.store.get_run(accepted.run_id)

    assert failed["state"] == WorkItemState.BLOCKED.value
    assert failed["gate_status"] == "verification failed: smoke"
    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert run["latest_reason"] == "verification failed: smoke"


def test_managed_run_coordinator_blocks_failed_checkpoint_after_group(tmp_path) -> None:
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [Checkpoint(after=["wi-1"], verify=["pytest -q"]).to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    coordinator.record_checkpoint_result(accepted.run_id, after_work_item_id="wi-1", passed=False, reason="pytest -q failed")
    run = coordinator.store.get_run(accepted.run_id)

    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert run["latest_reason"] == "checkpoint_failed:wi-1:pytest -q failed"


def test_managed_run_coordinator_waits_for_checkpoint_before_next_work_item(tmp_path) -> None:
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [Checkpoint(after=["wi-1"], verify=["pytest -q"]).to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    run_before_checkpoint = coordinator.store.get_run(accepted.run_id)
    assert coordinator.next_ready_work_item(accepted.run_id) is None
    assert run_before_checkpoint is not None
    assert run_before_checkpoint["state"] == ManagedRunState.READY.value
    assert run_before_checkpoint["latest_reason"] == "checkpoint_pending:wi-1"

    coordinator.record_checkpoint_result(accepted.run_id, after_work_item_id="wi-1", passed=True, reason="pytest -q passed")

    assert coordinator.next_ready_work_item(accepted.run_id)["work_item_id"] == "wi-2"
    assert coordinator.store.list_checkpoint_results(accepted.run_id)[0]["passed"] is True


def test_managed_run_coordinator_runs_pending_checkpoint_commands(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    command = f"{shlex.quote(sys.executable)} -c \"from pathlib import Path; Path('checkpoint.txt').write_text('ok')\""
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [Checkpoint(after=["wi-1"], verify=[command]).to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path / "state"))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    result = coordinator.run_pending_checkpoint(accepted.run_id, workspace_path=workspace)

    assert result is not None
    assert result["passed"] is True
    assert (workspace / "checkpoint.txt").read_text(encoding="utf-8") == "ok"
    assert coordinator.next_ready_work_item(accepted.run_id)["work_item_id"] == "wi-2"


def test_managed_run_coordinator_blocks_failed_pending_checkpoint_command(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    command = f"{shlex.quote(sys.executable)} -c \"import sys; print('bad checkpoint'); sys.exit(7)\""
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [Checkpoint(after=["wi-1"], verify=[command]).to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path / "state"))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    result = coordinator.run_pending_checkpoint(accepted.run_id, workspace_path=workspace)
    run = coordinator.store.get_run(accepted.run_id)

    assert result is not None
    assert result["passed"] is False
    assert "command_failed:" in result["reason"]
    assert "bad checkpoint" in result["reason"]
    assert run is not None
    assert run["state"] == ManagedRunState.BLOCKED.value


def test_managed_run_coordinator_requires_final_checkpoint_before_done(tmp_path) -> None:
    single_item_plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "work_items": [_item("wi-1").to_dict()],
            "checkpoints": [Checkpoint(after=["wi-1"], verify=["pytest -q"]).to_dict()],
        }
    )
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, single_item_plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))
    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    pending = coordinator.store.get_run(accepted.run_id)
    assert pending is not None
    assert pending["state"] != ManagedRunState.DONE.value
    assert pending["latest_reason"] == "checkpoint_pending:wi-1"

    coordinator.record_checkpoint_result(accepted.run_id, after_work_item_id="wi-1", passed=True, reason="pytest -q passed")

    verified = coordinator.store.get_run(accepted.run_id)
    assert verified is not None
    assert verified["state"] == ManagedRunState.VERIFIED.value
    assert verified["latest_reason"] == "awaiting_final_projection"


def test_managed_run_coordinator_marks_verified_before_final_projection(tmp_path) -> None:
    single_item_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [_item("wi-1").to_dict()]})
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, single_item_plan, backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(accepted.run_id, _result("wi-1"))

    coordinator.verify_work_item(accepted.run_id, "wi-1", gate_status="verification passed")

    verified = coordinator.store.get_run(accepted.run_id)
    assert verified is not None
    assert verified["state"] == ManagedRunState.VERIFIED.value
    assert verified["latest_reason"] == "awaiting_final_projection"


def test_managed_run_coordinator_approves_plan_revision_as_new_version(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    revision_result = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "status_claimed": WorkItemResultStatus.PLAN_REVISION_REQUESTED.value,
            "plan_revision": {"reason": "needs src/extra.py", "files_likely_touched": ["src/extra.py"]},
        }
    )
    coordinator.submit_work_item_result(accepted.run_id, revision_result)
    revised_item = WorkItem.from_dict({**_item("wi-1").to_dict(), "files_likely_touched": ["src/wi-1.py", "src/extra.py"]})
    revised = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "work_items": [revised_item.to_dict(), _item("wi-2", deps=["wi-1"]).to_dict()],
        }
    )

    version = coordinator.approve_plan_revision(
        accepted.run_id,
        revised,
        backend_session_id="thread-1",
        approval_id="approval-1",
    )
    run = coordinator.store.get_run(accepted.run_id)
    current_item = coordinator.store.list_work_items(accepted.run_id)[0]

    assert version == 2
    assert run is not None
    assert run["state"] == ManagedRunState.READY.value
    assert run["plan_version"] == 2
    assert coordinator.store.get_plan(accepted.run_id, 1) is not None
    assert coordinator.store.get_plan(accepted.run_id, 2).work_items[0].files_likely_touched == ["src/wi-1.py", "src/extra.py"]
    assert current_item["state"] == WorkItemState.TODO.value
    assert current_item["gate_status"] == "plan_revision_approved:approval-1"


def test_managed_run_coordinator_cancels_removed_work_items_on_approved_revision(tmp_path) -> None:
    coordinator = ConductorManagedRunCoordinator(store=ConductorManagedRunStore(tmp_path))
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    revision_result = WorkItemResult.from_dict(
        {
            **_result("wi-1").to_dict(),
            "status_claimed": WorkItemResultStatus.PLAN_REVISION_REQUESTED.value,
            "plan_revision": {"reason": "cancel wi-2"},
        }
    )
    coordinator.submit_work_item_result(accepted.run_id, revision_result)
    revised = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [_item("wi-1").to_dict()]})

    coordinator.approve_plan_revision(
        accepted.run_id,
        revised,
        backend_session_id="thread-1",
        approval_id="approval-2",
    )
    items = {item["work_item_id"]: item for item in coordinator.store.list_work_items(accepted.run_id)}

    assert items["wi-2"]["state"] == WorkItemState.CANCELLED.value
    assert items["wi-2"]["gate_status"] == "cancelled_by_plan_revision:2"
