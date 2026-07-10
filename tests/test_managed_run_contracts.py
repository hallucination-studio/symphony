from __future__ import annotations

import pytest

from performer_api.managed_runs import (
    ChangedFile,
    Checkpoint,
    GateSnapshot,
    GateStep,
    GateStepSource,
    ManagedRunPlan,
    ManagedRunPlanValidator,
    ManagedRunPlanValidatorError,
    ManagedRunRuntimeWait,
    ManagedRunTurnContext,
    ParallelizationPolicy,
    TaskOutputManifest,
    ThreadCompletionReport,
    VerificationInputSnapshot,
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


def test_managed_run_turn_context_requires_and_compares_fencing_fields() -> None:
    context = ManagedRunTurnContext(
        run_id="run-1",
        work_item_id="wi-1",
        policy_revision=3,
        plan_version=2,
        lease_id="lease-1",
        fencing_token="fence-1",
        turn_id="turn-1",
    )

    loaded = ManagedRunTurnContext.from_dict(context.to_dict())
    invalid = ManagedRunTurnContext.from_dict({"run_id": "", "policy_revision": 0, "plan_version": -1})

    assert loaded == context
    assert context.validation_errors() == []
    assert context.mismatch_reason(ManagedRunTurnContext.from_dict({**context.to_dict(), "plan_version": 3})) == "stale_plan_version"
    assert context.mismatch_reason(ManagedRunTurnContext.from_dict({**context.to_dict(), "policy_revision": 4})) == "stale_policy_revision"
    assert context.mismatch_reason(ManagedRunTurnContext.from_dict({**context.to_dict(), "lease_id": "lease-stale"})) == "stale_lease_id"
    assert context.mismatch_reason(ManagedRunTurnContext.from_dict({**context.to_dict(), "fencing_token": "fence-stale"})) == "stale_fencing_token"
    assert context.mismatch_reason(ManagedRunTurnContext.from_dict({**context.to_dict(), "turn_id": "turn-stale"})) == "stale_turn_id"
    assert invalid.validation_errors() == [
        "run_id_required",
        "policy_revision_required",
        "plan_version_invalid",
        "lease_id_required",
        "fencing_token_required",
        "turn_id_required",
    ]


def test_managed_run_runtime_wait_requires_a_known_kind_and_message() -> None:
    wait = ManagedRunRuntimeWait(wait_kind="approval_requested", message="Approve this runtime action.")
    invalid = ManagedRunRuntimeWait.from_dict({"wait_kind": "unknown", "message": ""})

    assert ManagedRunRuntimeWait.from_dict(wait.to_dict()) == wait
    assert wait.validation_errors() == []
    assert invalid.validation_errors() == ["runtime_wait_kind_invalid", "runtime_wait_message_required"]


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


def test_managed_run_plan_validator_rejects_too_many_work_items() -> None:
    items = [
        _work_item(
            id=f"wi-{index}",
            title=f"Implement contract {index}",
            files_likely_touched=[f"packages/performer-api/src/performer_api/contract_{index}.py"],
        )
        for index in range(ManagedRunPlanValidator.MAX_WORK_ITEMS + 1)
    ]

    errors = ManagedRunPlanValidator().validate(_plan(*items))

    assert ManagedRunPlanValidatorError.TOO_MANY_WORK_ITEMS in errors


@pytest.mark.parametrize(
    ("plan", "error"),
    [
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "summary": ""}), ManagedRunPlanValidatorError.MISSING_PLAN_SUMMARY),
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "architecture_decisions": []}), ManagedRunPlanValidatorError.MISSING_ARCHITECTURE_DECISIONS),
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": []}), ManagedRunPlanValidatorError.MISSING_WORK_ITEMS),
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [{**_work_item().to_dict(), "id": ""}]}), ManagedRunPlanValidatorError.MISSING_WORK_ITEM_ID),
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [{**_work_item().to_dict(), "objective": ""}]}), ManagedRunPlanValidatorError.MISSING_OBJECTIVE),
        (ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [{**_work_item().to_dict(), "acceptance_criteria": []}]}), ManagedRunPlanValidatorError.MISSING_ACCEPTANCE_CRITERIA),
        (
            ManagedRunPlan.from_dict(
                {
                    **_plan().to_dict(),
                    "work_items": [
                        {
                            **_work_item().to_dict(),
                            "verification": {"red_command": "Confirm result exists", "green_commands": ["Confirm result exists"], "runtime_checks": []},
                        }
                    ],
                }
            ),
            ManagedRunPlanValidatorError.INVALID_VERIFICATION_COMMAND,
        ),
        (
            ManagedRunPlan.from_dict(
                {
                    **_plan().to_dict(),
                    "work_items": [{**_work_item().to_dict(), "parallelization": {"safe_to_parallelize": False, "reason": ""}}],
                }
            ),
            ManagedRunPlanValidatorError.MISSING_PARALLELIZATION_REASON,
        ),
    ],
)
def test_managed_run_plan_validator_requires_complete_executable_work_item_contract(
    plan: ManagedRunPlan,
    error: ManagedRunPlanValidatorError,
) -> None:
    errors = ManagedRunPlanValidator().validate(plan)

    assert error in errors


def test_managed_run_plan_validator_rejects_invalid_checkpoint_target() -> None:
    plan = ManagedRunPlan.from_dict(
        {**_plan().to_dict(), "checkpoints": [Checkpoint(after=["missing"], verify=["pytest -q"]).to_dict()]}
    )

    errors = ManagedRunPlanValidator().validate(plan)

    assert ManagedRunPlanValidatorError.INVALID_CHECKPOINT_TARGET in errors


def test_managed_run_plan_validator_rejects_parallel_file_scope_conflicts() -> None:
    parallel = ParallelizationPolicy(
        safe_to_parallelize=True,
        parallel_group="shared-group",
        reason="independent work items",
        shared_contracts=["result contract"],
    )
    first = _work_item(id="wi-1", files_likely_touched=["src/shared.py"], parallelization=parallel)
    second = _work_item(id="wi-2", title="Implement second contract", files_likely_touched=["src/shared.py"], parallelization=parallel)

    errors = ManagedRunPlanValidator().validate(_plan(first, second))

    assert ManagedRunPlanValidatorError.UNSAFE_PARALLELIZATION in errors


def test_managed_run_plan_validator_rejects_validation_only_followup_work_item() -> None:
    create_marker = _work_item(
        id="wi-1",
        title="Create result marker",
        files_likely_touched=["SYMPHONY_REAL_E2E_RESULT.md"],
        verification=WorkItemVerification(
            red_command="test -f SYMPHONY_REAL_E2E_RESULT.md",
            green_commands=["test -f SYMPHONY_REAL_E2E_RESULT.md"],
        ),
    )
    validate_smoke = _work_item(
        id="wi-2",
        title="Validate smoke test",
        dependencies=["wi-1"],
        files_likely_touched=["SYMPHONY_REAL_E2E_RESULT.md"],
        verification=WorkItemVerification(
            red_command="pytest tests/test_smoke.py -q",
            green_commands=["pytest tests/test_smoke.py -q"],
        ),
    )

    errors = ManagedRunPlanValidator().validate(_plan(create_marker, validate_smoke))

    assert ManagedRunPlanValidatorError.VALIDATION_ONLY_WORK_ITEM in errors


def test_managed_run_plan_validator_requires_full_definition_of_done_rubric() -> None:
    errors = ManagedRunPlanValidator().validate(_plan(rubric=VerificationRubric(correctness=["ok"])))

    assert ManagedRunPlanValidatorError.INCOMPLETE_RUBRIC in errors


def test_managed_run_plan_validator_rejects_prose_checkpoint_verification() -> None:
    plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "checkpoints": [Checkpoint(after=["wi-1"], verify=["Confirm the work is done"]).to_dict()]})

    errors = ManagedRunPlanValidator().validate(plan)

    assert ManagedRunPlanValidatorError.INVALID_CHECKPOINT_COMMAND in errors


def test_managed_run_plan_validator_accepts_common_shell_checkpoint_commands() -> None:
    plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "checkpoints": [
                Checkpoint(
                    after=["wi-1"],
                    verify=[
                        "test -f SYMPHONY_REAL_E2E_RESULT.md",
                        "grep -q 'Podium, Conductor, and Performer reached Codex' SYMPHONY_REAL_E2E_RESULT.md",
                    ],
                ).to_dict()
            ],
        }
    )

    errors = ManagedRunPlanValidator().validate(plan)

    assert ManagedRunPlanValidatorError.INVALID_CHECKPOINT_COMMAND not in errors


def test_gate_snapshot_is_frozen_hashed_and_requires_authoritative_step() -> None:
    item = _work_item()

    snapshot = GateSnapshot.from_work_item(
        run_id="run-1",
        work_item=item,
        plan_version=3,
        creator_attempt_id="plan-attempt-1",
        created_at="2026-07-09T00:00:00Z",
    )
    loaded = GateSnapshot.from_dict(snapshot.to_dict())

    assert loaded == snapshot
    assert loaded.frozen is True
    assert loaded.pass_threshold == 3
    assert loaded.content_hash.startswith("sha256:")
    assert loaded.validation_errors() == []
    assert loaded.verification_procedure[0].source is GateStepSource.ISSUE_REQUIREMENT

    advisory_only = GateSnapshot.from_dict(
        {
            **snapshot.to_dict(),
            "verification_procedure": [
                GateStep(command="pytest -q", source=GateStepSource.PLANNER_INFERRED).to_dict()
            ],
        }
    )

    assert "authoritative_gate_step_required" in advisory_only.validation_errors()


def test_verification_input_snapshot_and_task_manifest_roundtrip_with_score_threshold() -> None:
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
        gate_snapshot_hash="sha256:gate",
    )
    manifest = TaskOutputManifest(
        work_item_id="wi-1",
        verify_attempt_id="verify-1",
        plan_version=3,
        score=3,
        branch_name="managed-run/wi-1",
        commit_sha="commit-sha",
        artifacts=[{"uri": "artifact://bundle", "sha256": "abc"}],
        created_at="2026-07-09T00:01:00Z",
    )

    assert VerificationInputSnapshot.from_dict(verification_input.to_dict()) == verification_input
    assert TaskOutputManifest.from_dict(manifest.to_dict()) == manifest
    assert manifest.validation_errors() == []
    assert TaskOutputManifest.from_dict({**manifest.to_dict(), "score": 2}).validation_errors() == ["score_below_pass_threshold"]


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
