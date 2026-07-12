from __future__ import annotations

import pytest

from performer_api.labels import is_managed_project_label, managed_project_label_name
from performer_api.turns import GateResult, RuntimeWait, TurnContext
from performer_api.validation import ContractValidationError, validate_plan
from performer_api.workflow import AcceptanceCatalog, Plan, PlanRevision


def test_plan_round_trips_ordered_tasks_and_retained_metadata(minimal_task) -> None:
    plan = Plan(
        summary="Implement the feature",
        tasks=[minimal_task],
        risks=["The external API may be unavailable"],
        architecture_decisions=["Use the existing HTTP client"],
        open_questions=["Which timeout should the proxy use?"],
        acceptance_catalog=AcceptanceCatalog(
            id="catalog-1",
            rubric={"correctness": {"weight": 2, "threshold": 3}},
        ),
    )

    restored = Plan.from_dict(plan.to_dict())

    assert restored == plan
    assert [task.id for task in restored.tasks] == ["task-1"]
    assert restored.acceptance_catalog.rubric["correctness"]["weight"] == 2


def test_plan_revision_keeps_approval_and_manifest_provenance(minimal_task) -> None:
    revision = PlanRevision(
        version=2,
        reason="Address review findings",
        status="approved",
        policy_revision=4,
        plan=Plan(summary="Revised plan", tasks=[minimal_task]),
        approval_id="linear-comment-42",
        manifest_refs=["manifest://run/task-1/2"],
    )

    restored = PlanRevision.from_dict(revision.to_dict())

    assert restored == revision
    assert restored.status == "approved"
    assert restored.manifest_refs == ["manifest://run/task-1/2"]


def test_checkpoint_group_is_not_a_plan_field(minimal_task) -> None:
    with pytest.raises(ContractValidationError, match="checkpoint"):
        validate_plan(
            {
                "summary": "Invalid",
                "tasks": [minimal_task.to_dict()],
                "checkpoints": [{"after": ["task-1"]}],
            }
        )


def test_turn_context_requires_exact_fenced_identity() -> None:
    context = TurnContext(
        run_id="run-1",
        task_id="task-1",
        attempt_id="attempt-1",
        fencing_token=7,
        turn_kind="execute",
    )

    assert TurnContext.from_dict(context.to_dict()) == context
    assert context.mismatch_reason(
        TurnContext(
            run_id="run-1",
            task_id="task-1",
            attempt_id="attempt-1",
            fencing_token=8,
            turn_kind="execute",
        )
    ) == "stale_fencing_token"


def test_gate_result_keeps_score_rubric_and_single_codex_provenance() -> None:
    result = GateResult(
        passed=True,
        score=4,
        threshold=3,
        rubric={"correctness": {"score": 4, "weight": 2}},
        provenance=[{"source": "codex", "attempt_id": "attempt-1"}],
        findings=["All declared commands passed"],
        artifact_refs=["artifact://run-1/task-1"],
    )

    assert GateResult.from_dict(result.to_dict()) == result
    assert {entry["source"] for entry in result.provenance} == {"codex"}


def test_runtime_wait_round_trips_without_becoming_a_second_transport() -> None:
    wait = RuntimeWait(kind="approval_requested", reason="Approve the tool call")

    assert RuntimeWait.from_dict(wait.to_dict()) == wait


def test_managed_project_label_contract_is_shared_by_podium_and_conductor() -> None:
    label = managed_project_label_name("Bach", "abc123")

    assert label == "symphony:conductor/Bach-abc123"
    assert is_managed_project_label(label)
    assert not is_managed_project_label(f" {label} ")
