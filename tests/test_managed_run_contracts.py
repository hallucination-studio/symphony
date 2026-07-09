from __future__ import annotations

import pytest

from performer_api.managed_runs import (
    ChangedFile,
    Checkpoint,
    ManagedRunPlan,
    ManagedRunPlanValidator,
    ManagedRunPlanValidatorError,
    ParallelizationPolicy,
    ThreadCompletionReport,
    VerificationRubric,
    WorkItem,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemVerification,
    replace_managed_run_summary_block,
)


def _rubric() -> VerificationRubric:
    return VerificationRubric(
        correctness=["acceptance criteria pass"],
        quality=["scope discipline"],
        integration=["tests pass"],
        documentation=["Linear updated"],
        ship_readiness=["residual risk recorded"],
    )


def _work_item(**overrides: object) -> WorkItem:
    payload = {
        "id": "wi-1",
        "title": "Implement contract",
        "objective": "Define the shared managed_run contract",
        "slice_type": WorkItemSliceType.CONTRACT_FIRST,
        "acceptance_criteria": ["schema roundtrips"],
        "verification": WorkItemVerification(red_command="pytest tests/test_managed_run_contracts.py -q", green_commands=["pytest tests/test_managed_run_contracts.py -q"]),
        "dependencies": [],
        "estimated_scope": "S",
        "files_likely_touched": ["packages/performer-api/src/performer_api/managed_run.py"],
        "parallelization": ParallelizationPolicy(safe_to_parallelize=False, reason="shared contract"),
    }
    payload.update(overrides)
    return WorkItem(**payload)  # type: ignore[arg-type]


def _plan(*items: WorkItem, rubric: VerificationRubric | None = None) -> ManagedRunPlan:
    return ManagedRunPlan(
        summary="Build Linear-native Managed Runs",
        architecture_decisions=["Conductor owns terminal state"],
        work_items=list(items) or [_work_item()],
        checkpoints=[],
        verification_rubric=rubric or _rubric(),
        risks=[],
        open_questions=[],
        approval_required=True,
    )


def test_managed_run_plan_roundtrips_with_work_item_contract() -> None:
    plan = _plan()

    loaded = ManagedRunPlan.from_dict(plan.to_dict())

    assert loaded == plan
    assert loaded.work_items[0].id == "wi-1"
    assert loaded.verification_rubric.to_dict()["ship_readiness"] == ["residual risk recorded"]


@pytest.mark.parametrize(
    ("item", "error"),
    [
        (_work_item(estimated_scope="L"), ManagedRunPlanValidatorError.WORK_ITEM_TOO_LARGE),
        (_work_item(estimated_scope=""), ManagedRunPlanValidatorError.INVALID_SCOPE),
        (_work_item(estimated_scope="tiny"), ManagedRunPlanValidatorError.INVALID_SCOPE),
        (_work_item(title="Implement contract and projector"), ManagedRunPlanValidatorError.TITLE_HAS_AND),
        (_work_item(title="Contract implementation"), ManagedRunPlanValidatorError.TITLE_NOT_VERB_FIRST),
        (_work_item(acceptance_criteria=["a", "b", "c", "d"]), ManagedRunPlanValidatorError.TOO_MANY_ACCEPTANCE_CRITERIA),
        (_work_item(verification=WorkItemVerification(red_command="", green_commands=["pytest -q"])), ManagedRunPlanValidatorError.MISSING_RED_COMMAND),
        (_work_item(verification=WorkItemVerification(red_command="pytest -q", green_commands=[])), ManagedRunPlanValidatorError.MISSING_GREEN_COMMANDS),
        (_work_item(files_likely_touched=[]), ManagedRunPlanValidatorError.EMPTY_FILE_SCOPE),
        (
            _work_item(parallelization=ParallelizationPolicy(safe_to_parallelize=True, reason="maybe")),
            ManagedRunPlanValidatorError.UNSAFE_PARALLELIZATION,
        ),
    ],
)
def test_managed_run_plan_validator_rejects_invalid_work_items(item: WorkItem, error: ManagedRunPlanValidatorError) -> None:
    errors = ManagedRunPlanValidator().validate(_plan(item))

    assert error in errors


def test_managed_run_plan_validator_requires_docs_only_items_to_remain_verifiable_and_scoped() -> None:
    item = _work_item(
        title="Document managed run state",
        slice_type=WorkItemSliceType.DOCS_ONLY,
        verification=WorkItemVerification(red_command="", green_commands=[]),
        files_likely_touched=[],
    )

    errors = ManagedRunPlanValidator().validate(_plan(item))

    assert ManagedRunPlanValidatorError.MISSING_RED_COMMAND in errors
    assert ManagedRunPlanValidatorError.MISSING_GREEN_COMMANDS in errors
    assert ManagedRunPlanValidatorError.EMPTY_FILE_SCOPE in errors


def test_managed_run_plan_validator_rejects_dependency_cycles() -> None:
    wi_1 = _work_item(id="wi-1", dependencies=["wi-2"])
    wi_2 = _work_item(id="wi-2", title="Implement projector", dependencies=["wi-1"])

    errors = ManagedRunPlanValidator().validate(_plan(wi_1, wi_2))

    assert ManagedRunPlanValidatorError.CYCLE_DETECTED in errors


def test_managed_run_plan_validator_requires_full_definition_of_done_rubric() -> None:
    errors = ManagedRunPlanValidator().validate(_plan(rubric=VerificationRubric(correctness=["ok"])))

    assert ManagedRunPlanValidatorError.INCOMPLETE_RUBRIC in errors


def test_managed_run_plan_validator_rejects_prose_checkpoint_verification() -> None:
    plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "checkpoints": [Checkpoint(after=["wi-1"], verify=["Confirm the work is done"]).to_dict()]})

    errors = ManagedRunPlanValidator().validate(plan)

    assert ManagedRunPlanValidatorError.INVALID_CHECKPOINT_COMMAND in errors


def test_work_item_result_roundtrips_file_impact_manifest() -> None:
    result = WorkItemResult(
        work_item_id="wi-1",
        status_claimed=WorkItemResultStatus.READY_FOR_REVIEW,
        changed_files=[
            ChangedFile(
                path="packages/performer-api/src/performer_api/managed_run.py",
                action="created",
                planned=True,
                reason="adds managed_run contract",
                handling="kept",
                verification=["pytest tests/test_managed_run_contracts.py -q"],
            )
        ],
        undeclared_files=[],
        tests={"red_command": "pytest tests/test_managed_run_contracts.py -q", "red_observed": True, "green_commands_run": ["pytest tests/test_managed_run_contracts.py -q"]},
        acceptance_results=[{"criterion": "schema roundtrips", "status": "passed"}],
        blocked_reason=None,
        plan_revision=None,
        notes="Ready for managed_run review",
    )

    loaded = WorkItemResult.from_dict(result.to_dict())

    assert loaded == result


def test_replace_managed_run_summary_block_preserves_user_description() -> None:
    report = ThreadCompletionReport(
        status="verified",
        thread_id="thread-1",
        plan_version=1,
        what_this_thread_did=["planned one bounded work item"],
        files_changed=[],
        rubric_results=[{"area": "correctness", "status": "passed", "evidence": ["wi-1 accepted"]}],
        token_usage=[],
        residual_risks=[],
    )
    original = "User requirement\n\n<!-- symphony:run-summary:start -->\nstale\n<!-- symphony:run-summary:end -->\n\nMore user notes"

    updated = replace_managed_run_summary_block(original, report)

    assert updated.startswith("User requirement")
    assert updated.endswith("More user notes")
    assert "stale" not in updated
    assert "Status: verified" in updated
    assert "thread-1" in updated
