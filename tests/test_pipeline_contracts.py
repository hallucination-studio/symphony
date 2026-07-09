from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    canonical_gate_hash,
    DependencySatisfactionPolicy,
    GateStep,
    GateStepSource,
    GateSpecContent,
    GateSpecSnapshot,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    IntentSpec,
    PlanRepair,
    PlanProposal,
    PlanAttemptRequest,
    PlanAttemptResult,
    PlanValidator,
    PlanValidatorError,
    RuntimeMode,
    RuntimeConfigEnvelope,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    ExecuteAttemptRequest,
    VerifyAttemptRequest,
    VerifyAttemptResult,
    WorkerLease,
)


def test_linear_topology_state_set_uses_need_human_and_removes_reworking() -> None:
    states = {state.value for state in GraphNodeState}

    assert "need_human" in states
    assert "reworking" not in states
    assert GraphNodeState.from_value("awaiting_human") is GraphNodeState.NEED_HUMAN


def test_gate_snapshot_hash_is_canonical_and_threshold_is_fixed() -> None:
    content = GateSpecContent(
        acceptance_criteria=["returns useful pipeline state"],
        verification_procedure=["pytest tests/test_pipeline_contracts.py"],
        rubric={
            "0": "no implementation",
            "1": "attempted but broken",
            "2": "partial or mock-only",
            "3": "gate passes",
            "4": "gate passes with edge cases",
        },
        pass_threshold=3,
    )
    first = GateSpecSnapshot.create(
        gate_id="gate-1",
        task_id="node-1",
        created_by="plan-attempt-1",
        created_at="2026-07-06T00:00:00Z",
        content=content,
    )
    second = GateSpecSnapshot.from_dict(first.to_dict())

    assert first.hash == second.hash
    assert first.frozen is True
    assert second.content.pass_threshold == 3

    lowered = first.to_dict()
    lowered["content"]["pass_threshold"] = 2

    with pytest.raises(ValueError, match="pass_threshold"):
        GateSpecSnapshot.from_dict(lowered)


def test_gate_steps_carry_source_and_legacy_steps_parse_as_planner_inferred() -> None:
    content = GateSpecContent.from_dict(
        {
            "acceptance_criteria": ["README exists"],
            "verification_procedure": [
                {"step": "test -f README.md", "source": "issue_requirement"},
                "pytest -q",
            ],
            "rubric": {str(score): f"score {score}" for score in range(5)},
            "pass_threshold": 3,
        }
    )

    assert content.verification_procedure == [
        GateStep("test -f README.md", GateStepSource.ISSUE_REQUIREMENT),
        GateStep("pytest -q", GateStepSource.PLANNER_INFERRED),
    ]
    assert content.to_dict()["verification_procedure"] == [
        {"step": "test -f README.md", "source": "issue_requirement"},
        {"step": "pytest -q", "source": "planner_inferred"},
    ]


def test_plan_validator_rejects_gate_without_authoritative_step() -> None:
    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["model guess"],
            verification_procedure=[GateStep("pytest -q", GateStepSource.PLANNER_INFERRED)],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="node-1",
        nodes=[GraphNode(node_id="node-1", title="Node", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash)],
        blocks=[],
        gates=[gate],
        entry_node_ids=["node-1"],
        exit_node_ids=["node-1"],
    )

    errors = PlanValidator().validate(proposal)

    assert PlanValidatorError.NO_AUTHORITATIVE_GATE_STEP in errors


def test_intent_spec_derives_only_from_structured_dispatch_context() -> None:
    dispatch_context = {
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "description": (
            "This prose mentions SYMPHONY_REAL_E2E_RESULT.md and says downstream should depend "
            "on both parallel subtasks, but prose is not authoritative."
        ),
        "intent": {
            "required_gate_steps": [
                {"step": "test -f SYMPHONY_REAL_E2E_RESULT.md", "source": "appendix_harness"},
                {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"},
            ],
            "parallel_dependency_shape": {
                "parallel_branch_node_ids": ["branch-a", "branch-b"],
                "downstream_node_ids": ["integration"],
            },
        },
    }

    first = IntentSpec.from_dispatch_context(dispatch_context)
    second = IntentSpec.from_dispatch_context(dict(dispatch_context))

    assert first == second
    assert first.requires_all_parallel_branches_for_downstream is True
    assert first.parallel_branch_node_ids == ["branch-a", "branch-b"]
    assert first.downstream_node_ids == ["integration"]
    assert first.required_gate_steps == [
        GateStep("test -f SYMPHONY_REAL_E2E_RESULT.md", GateStepSource.APPENDIX_HARNESS),
        GateStep("pytest tests/test_smoke.py -q", GateStepSource.APPENDIX_HARNESS),
    ]

    prose_only = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "description": (
                "Create SYMPHONY_REAL_E2E_RESULT.md and make downstream depend on both parallel subtasks. "
                "Run pytest tests/test_smoke.py -q."
            ),
        }
    )
    assert prose_only.required_gate_steps == []
    assert prose_only.requires_all_parallel_branches_for_downstream is False


def test_intent_spec_uses_pipeline_intent_when_intent_is_empty() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {},
            "pipeline_intent": {
                "requires_parent_aggregate": True,
                "required_gate_steps": [
                    {"step": "test -f SYMPHONY_REAL_E2E_RESULT.md", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        }
    )

    assert intent.requires_parent_aggregate is True
    assert intent.requires_all_parallel_branches_for_downstream is True
    assert intent.parallel_branch_node_ids == ["parallel-a", "parallel-b"]
    assert intent.downstream_node_ids == ["integration"]
    assert intent.required_gate_steps == [
        GateStep("test -f SYMPHONY_REAL_E2E_RESULT.md", GateStepSource.APPENDIX_HARNESS)
    ]


def test_intent_spec_uses_intent_when_pipeline_intent_is_empty() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {
                "requires_parent_aggregate": True,
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
            "pipeline_intent": {},
        }
    )

    assert intent.requires_parent_aggregate is True
    assert intent.requires_all_parallel_branches_for_downstream is True
    assert intent.parallel_branch_node_ids == ["parallel-a", "parallel-b"]
    assert intent.downstream_node_ids == ["integration"]


def test_intent_spec_merges_pipeline_intent_base_with_non_empty_intent_overrides() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "pipeline_intent": {
                "required_gate_steps": [
                    {"step": "test -f SYMPHONY_REAL_E2E_RESULT.md", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["stale-a", "stale-b"],
                    "downstream_node_ids": ["stale-integration"],
                },
            },
            "intent": {
                "required_gate_steps": [],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        }
    )

    assert intent.parallel_branch_node_ids == ["parallel-a", "parallel-b"]
    assert intent.downstream_node_ids == ["integration"]
    assert intent.required_gate_steps == [
        GateStep("test -f SYMPHONY_REAL_E2E_RESULT.md", GateStepSource.APPENDIX_HARNESS)
    ]


def test_plan_repair_is_idempotent_and_repairs_required_parallel_shape() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {
                "required_gate_steps": [
                    {"step": "test -f SYMPHONY_REAL_E2E_RESULT.md", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        }
    )
    proposal = _parallel_shape_proposal(
        blocks=[("parallel-a", "integration")],
        titles={"parallel-a": "First branch", "parallel-b": "Second branch", "integration": "Join work"},
    )

    repaired = PlanRepair(intent).repair(proposal)
    repaired_again = PlanRepair(intent).repair(repaired)

    assert ("parallel-a", "integration") in repaired.blocks
    assert ("parallel-b", "integration") in repaired.blocks
    assert repaired.entry_node_ids == ["parallel-a", "parallel-b"]
    assert repaired.exit_node_ids == ["integration"]
    assert repaired_again.to_dict() == repaired.to_dict()
    integration_gate = next(gate for gate in repaired.gates if gate.task_id == "integration")
    assert GateStep("test -f SYMPHONY_REAL_E2E_RESULT.md", GateStepSource.APPENDIX_HARNESS) in integration_gate.content.verification_procedure


def test_plan_repair_promotes_business_issue_root_to_pure_parent_for_aggregate_intent() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {
                "requires_parent_aggregate": True,
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        }
    )
    gates: list[GateSpecSnapshot] = []
    nodes: list[GraphNode] = []
    for node_id in ("root", "parallel-a", "parallel-b", "integration"):
        gate = GateSpecSnapshot.create(
            gate_id=f"gate-{node_id}",
            task_id=node_id,
            created_by="plan-1",
            created_at="2026-07-06T00:00:00Z",
            content=GateSpecContent(
                acceptance_criteria=[f"{node_id} works"],
                verification_procedure=[GateStep("true", GateStepSource.ISSUE_REQUIREMENT)],
                rubric={str(score): f"score {score}" for score in range(5)},
                pass_threshold=3,
            ),
        )
        gates.append(gate)
        nodes.append(GraphNode(node_id=node_id, title=node_id, state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash))
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=nodes,
        blocks=[("root", "parallel-a"), ("parallel-a", "integration")],
        gates=gates,
        entry_node_ids=["root", "parallel-b"],
        exit_node_ids=["parallel-b", "integration"],
    )

    repaired = PlanRepair(intent).repair(proposal)
    repaired_again = PlanRepair(intent).repair(repaired)

    root = next(node for node in repaired.nodes if node.node_id == "root")
    subtasks = [node for node in repaired.nodes if node.node_id != "root"]
    assert root.parent_node_id is None
    assert root.gate_snapshot_hash is None
    assert all(node.parent_node_id == "root" for node in subtasks)
    assert {gate.task_id for gate in repaired.gates} == {"parallel-a", "parallel-b", "integration"}
    assert not any("root" in edge for edge in repaired.blocks)
    assert repaired.entry_node_ids == ["parallel-a", "parallel-b"]
    assert repaired.exit_node_ids == ["integration"]
    assert PlanValidator(intent_spec=intent).validate(repaired) == set()
    assert repaired_again.to_dict() == repaired.to_dict()


def test_plan_repair_promotes_parent_aggregate_from_pipeline_intent_shadowed_by_empty_intent() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {},
            "pipeline_intent": {
                "requires_parent_aggregate": True,
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        }
    )
    gates: list[GateSpecSnapshot] = []
    nodes: list[GraphNode] = []
    for node_id in ("root", "parallel-a", "parallel-b", "integration"):
        gate = GateSpecSnapshot.create(
            gate_id=f"gate-{node_id}",
            task_id=node_id,
            created_by="plan-1",
            created_at="2026-07-06T00:00:00Z",
            content=GateSpecContent(
                acceptance_criteria=[f"{node_id} works"],
                verification_procedure=[GateStep("true", GateStepSource.ISSUE_REQUIREMENT)],
                rubric={str(score): f"score {score}" for score in range(5)},
                pass_threshold=3,
            ),
        )
        gates.append(gate)
        nodes.append(GraphNode(node_id=node_id, title=node_id, state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash))
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=nodes,
        blocks=[("root", "parallel-a"), ("parallel-a", "integration")],
        gates=gates,
        entry_node_ids=["root", "parallel-b"],
        exit_node_ids=["parallel-b", "integration"],
    )

    repaired = PlanRepair(intent).repair(proposal)

    root = next(node for node in repaired.nodes if node.node_id == "root")
    subtasks = [node for node in repaired.nodes if node.node_id != "root"]
    assert root.parent_node_id is None
    assert root.gate_snapshot_hash is None
    assert all(node.parent_node_id == "root" for node in subtasks)
    assert {gate.task_id for gate in repaired.gates} == {"parallel-a", "parallel-b", "integration"}
    assert not any("root" in edge for edge in repaired.blocks)
    assert repaired.entry_node_ids == ["parallel-a", "parallel-b"]
    assert repaired.exit_node_ids == ["integration"]
    assert PlanValidator(intent_spec=intent).validate(repaired) == set()


def test_plan_repair_infers_gate_less_root_parent_as_aggregate() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {},
        }
    )
    gate = GateSpecSnapshot.create(
        gate_id="gate-child",
        task_id="task-create-result",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["child work is complete"],
            verification_procedure=[GateStep("test -f SYMPHONY_REAL_E2E_RESULT.md", GateStepSource.ISSUE_REQUIREMENT)],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="issue-1",
        nodes=[
            GraphNode(
                node_id="issue-1",
                title="Business issue",
                state=GraphNodeState.PLANNED,
                issue_id="issue-1",
                issue_identifier="ENG-1",
            ),
            GraphNode(
                node_id="task-create-result",
                title="Create result",
                state=GraphNodeState.PLANNED,
                parent_node_id="issue-1",
                gate_snapshot_hash=gate.hash,
            ),
        ],
        blocks=[],
        gates=[gate],
        entry_node_ids=["issue-1", "task-create-result"],
        exit_node_ids=["issue-1", "task-create-result"],
    )

    repaired = PlanRepair(intent).repair(proposal)
    repaired_again = PlanRepair(intent).repair(repaired)

    assert repaired.entry_node_ids == ["task-create-result"]
    assert repaired.exit_node_ids == ["task-create-result"]
    assert PlanValidator(intent_spec=intent).validate(repaired) == set()
    assert repaired_again.to_dict() == repaired.to_dict()


def test_plan_validator_rejects_missing_parent_aggregate_when_intent_requires_it() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {"requires_parent_aggregate": True},
        }
    )
    proposal = _parallel_shape_proposal(
        blocks=[("parallel-a", "integration"), ("parallel-b", "integration")],
        titles={"parallel-a": "First branch", "parallel-b": "Second branch", "integration": "Join work"},
    )

    errors = PlanValidator(intent_spec=intent).validate(proposal)

    assert PlanValidatorError.PARENT_AGGREGATE_MISSING in errors


def test_plan_validator_rejects_unrepaired_required_parallel_shape() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "intent": {
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
                    "downstream_node_ids": ["integration"],
                }
            },
        }
    )
    proposal = _parallel_shape_proposal(
        blocks=[("parallel-a", "integration")],
        titles={"parallel-a": "First branch", "parallel-b": "Second branch", "integration": "Join work"},
    )

    errors = PlanValidator(intent_spec=intent).validate(proposal)

    assert PlanValidatorError.REQUIRED_PARALLEL_SHAPE_MISSING in errors


def test_plan_repair_demotes_model_exact_text_gate_without_injecting_authoritative_steps() -> None:
    intent = IntentSpec.from_dispatch_context(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "description": (
                "Structured intent intentionally carries no shared-file gate guard. "
                "Even if prose mentions grep -q 'model invented marker' SYMPHONY_CONFLICT_SHARED.md, "
                "prose is not authoritative."
            ),
        }
    )
    gate = GateSpecSnapshot.create(
        gate_id="gate-branch-a",
        task_id="branch-a",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["Contains exact marker text."],
            verification_procedure=[
                GateStep("test -f SYMPHONY_CONFLICT_SHARED.md", GateStepSource.ISSUE_REQUIREMENT),
                GateStep("grep -q 'model invented marker' SYMPHONY_CONFLICT_SHARED.md", GateStepSource.ISSUE_REQUIREMENT),
                GateStep("git diff -- SYMPHONY_CONFLICT_SHARED.md | grep -q 'model invented marker'", GateStepSource.ISSUE_REQUIREMENT),
            ],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[GraphNode(node_id="branch-a", title="Branch A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash)],
        blocks=[],
        gates=[gate],
        entry_node_ids=["branch-a"],
        exit_node_ids=["branch-a"],
    )

    repaired = PlanRepair(intent).repair(proposal)

    commands = repaired.gates[0].content.verification_procedure
    assert GateStep("test -f SYMPHONY_CONFLICT_SHARED.md", GateStepSource.ISSUE_REQUIREMENT) in commands
    assert GateStep("grep -q 'model invented marker' SYMPHONY_CONFLICT_SHARED.md", GateStepSource.PLANNER_INFERRED) in commands
    assert GateStep("git diff -- SYMPHONY_CONFLICT_SHARED.md | grep -q 'model invented marker'", GateStepSource.PLANNER_INFERRED) in commands
    assert GateStep('test -n "$(git diff -- SYMPHONY_CONFLICT_SHARED.md)"', GateStepSource.SYSTEM_REPAIR) not in commands


def test_attempt_requests_round_trip_issue_and_task_context() -> None:
    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["Create SYMPHONY_REAL_E2E_RESULT.md"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    plan = PlanAttemptRequest(
        attempt_id="plan-1",
        graph_id="graph-1",
        root_node_id="node-1",
        node_id="node-1",
        issue_id="issue-1",
        issue_identifier="HELL-1",
        title="Real E2E",
        issue_description="Create SYMPHONY_REAL_E2E_RESULT.md and run pytest.",
        graph_revision=1,
        policy_revision=2,
        lease_id="lease-plan",
        fencing_token="fence-plan",
        workspace_path="/repo",
        kind="codex",
    )
    execute = ExecuteAttemptRequest(
        attempt_id="exec-1",
        node_id="node-1",
        task_title="Real E2E",
        issue_identifier="HELL-1",
        issue_description="Create SYMPHONY_REAL_E2E_RESULT.md and run pytest.",
        graph_revision=1,
        policy_revision=2,
        gate_snapshot=gate,
        lease_id="lease-exec",
        fencing_token="fence-exec",
        expected_thread_id="thread-exec",
        kind="claude",
    )

    assert PlanAttemptRequest.from_dict(plan.to_dict()).issue_description == plan.issue_description
    assert PlanAttemptRequest.from_dict(plan.to_dict()).kind == "codex"
    execute_payload = execute.to_dict()
    assert execute_payload["task_title"] == "Real E2E"
    assert execute_payload["issue_identifier"] == "HELL-1"
    assert execute_payload["issue_description"] == "Create SYMPHONY_REAL_E2E_RESULT.md and run pytest."
    assert execute_payload["expected_thread_id"] == "thread-exec"
    assert execute_payload["kind"] == "claude"
    assert ExecuteAttemptRequest.from_dict(execute_payload).issue_description == execute.issue_description
    assert ExecuteAttemptRequest.from_dict(execute_payload).expected_thread_id == "thread-exec"
    assert ExecuteAttemptRequest.from_dict(execute_payload).kind == "claude"


def test_attempt_record_persists_fencing_and_revision_context() -> None:
    attempt = AttemptRecord(
        attempt_id="exec-1",
        node_id="node-1",
        mode=RuntimeMode.EXECUTE,
        state=AttemptState.RUNNING,
        graph_revision=7,
        policy_revision=3,
        lease_id="lease-exec",
        fencing_token="fence-exec",
        gate_snapshot_hash="sha256:gate",
        process_pid=4242,
        thread_id="thread-1",
        kind="codex",
    )

    payload = attempt.to_dict()
    restored = AttemptRecord.from_dict(payload)

    assert payload["graph_revision"] == 7
    assert payload["policy_revision"] == 3
    assert payload["lease_id"] == "lease-exec"
    assert payload["fencing_token"] == "fence-exec"
    assert payload["process_pid"] == 4242
    assert payload["thread_id"] == "thread-1"
    assert payload["kind"] == "codex"
    assert restored.graph_revision == 7
    assert restored.policy_revision == 3
    assert restored.lease_id == "lease-exec"
    assert restored.fencing_token == "fence-exec"
    assert restored.process_pid == 4242
    assert restored.thread_id == "thread-1"
    assert restored.kind == "codex"


def test_attempt_results_persist_thread_id_and_backend_kind_for_resume() -> None:
    plan = PlanAttemptResult(
        attempt_id="plan-1",
        node_id="node-1",
        status=AttemptState.FAILED,
        graph_revision=1,
        policy_revision=2,
        gate_snapshot_hash="",
        lease_id="lease-plan",
        fencing_token="fence-plan",
        thread_id="thread-plan",
        kind="codex",
    )
    execute = ExecuteAttemptResult(
        attempt_id="exec-1",
        node_id="node-1",
        status=AttemptState.FAILED,
        graph_revision=1,
        policy_revision=2,
        gate_snapshot_hash="sha256:gate",
        lease_id="lease-exec",
        fencing_token="fence-exec",
        thread_id="thread-exec",
        kind="claude",
        verification_input={},
    )
    verify = VerifyAttemptResult(
        attempt_id="verify-1",
        node_id="node-1",
        status=AttemptState.FAILED,
        graph_revision=1,
        policy_revision=2,
        gate_snapshot_hash="sha256:gate",
        lease_id="lease-verify",
        fencing_token="fence-verify",
        thread_id="thread-verify",
        kind="local-verifier",
        score=1,
        passed=False,
        execute_attempt_id="exec-1",
    )

    assert PlanAttemptResult.from_dict(plan.to_dict()).thread_id == "thread-plan"
    assert PlanAttemptResult.from_dict(plan.to_dict()).kind == "codex"
    assert ExecuteAttemptResult.from_dict(execute.to_dict()).thread_id == "thread-exec"
    assert ExecuteAttemptResult.from_dict(execute.to_dict()).kind == "claude"
    assert VerifyAttemptResult.from_dict(verify.to_dict()).thread_id == "thread-verify"
    assert VerifyAttemptResult.from_dict(verify.to_dict()).kind == "local-verifier"


def test_plan_validator_rejects_cycles_missing_gates_and_incomplete_rubrics() -> None:
    valid_gate = GateSpecContent(
        acceptance_criteria=["criterion"],
        verification_procedure=["pytest -q"],
        rubric={str(score): f"score {score}" for score in range(5)},
        pass_threshold=3,
    )
    broken_gate = GateSpecContent(
        acceptance_criteria=["criterion"],
        verification_procedure=["pytest -q"],
        rubric={"0": "nope", "3": "pass"},
        pass_threshold=3,
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash="gate-a"),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash="gate-b"),
            GraphNode(node_id="c", title="C", state=GraphNodeState.PLANNED),
        ],
        blocks=[("a", "b"), ("b", "a")],
        gates=[
            GateSpecSnapshot.create(
                gate_id="gate-a",
                task_id="a",
                created_by="plan-1",
                created_at="2026-07-06T00:00:00Z",
                content=valid_gate,
            ),
            GateSpecSnapshot.create(
                gate_id="gate-b",
                task_id="b",
                created_by="plan-1",
                created_at="2026-07-06T00:00:00Z",
                content=broken_gate,
            ),
        ],
        entry_node_ids=["a"],
        exit_node_ids=["b"],
    )

    errors = PlanValidator(max_subtasks=10).validate(proposal)

    assert PlanValidatorError.CYCLE_DETECTED in errors
    assert PlanValidatorError.MISSING_GATE in errors
    assert PlanValidatorError.INCOMPLETE_RUBRIC in errors


def test_runtime_config_validation_requires_complete_three_mode_profiles() -> None:
    policy = SchedulerPolicy(
        policy_id="policy-1",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=3, by_mode={mode: 1 for mode in RuntimeMode}),
        dependency_policy=DependencySatisfactionPolicy.VERIFY_PASSED,
        max_rework_attempts=1,
    )
    incomplete = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=1,
        scheduler_policy=policy,
        profiles={
            RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
        },
    )

    assert incomplete.validation_errors() == ["runtime_profiles_missing:execute,verify"]

    complete = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=1,
        scheduler_policy=policy,
        profiles={
            mode: RuntimeProfile(name=f"codex-{mode.value}", backend="codex", mode=mode)
            for mode in RuntimeMode
        },
    )

    complete.validate()


def test_runtime_config_validation_enforces_mode_backend_eligibility() -> None:
    policy = SchedulerPolicy(
        policy_id="policy-1",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=3, by_mode={mode: 1 for mode in RuntimeMode}),
        dependency_policy=DependencySatisfactionPolicy.VERIFY_PASSED,
        max_rework_attempts=1,
    )
    local_verify = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=1,
        scheduler_policy=policy,
        profiles={
            RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
            RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            RuntimeMode.VERIFY: RuntimeProfile(name="verifier", backend="local-verifier", mode=RuntimeMode.VERIFY),
        },
    )
    invalid_plan_backend = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=1,
        scheduler_policy=policy,
        profiles={
            RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="local-verifier", mode=RuntimeMode.PLAN),
            RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            RuntimeMode.VERIFY: RuntimeProfile(name="verifier", backend="local-verifier", mode=RuntimeMode.VERIFY),
        },
    )

    local_verify.validate()
    assert invalid_plan_backend.validation_errors() == ["runtime_profile_backend_unsupported:plan:local-verifier"]


def test_plan_validator_rejects_bad_or_unfrozen_gate_hashes() -> None:
    content = GateSpecContent(
        acceptance_criteria=["criterion"],
        verification_procedure=["pytest -q"],
        rubric={str(score): f"score {score}" for score in range(5)},
        pass_threshold=3,
    )
    bad_gate = GateSpecSnapshot(
        gate_id="gate-a",
        task_id="a",
        version=1,
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=content,
        hash="sha256:not-canonical",
        frozen=True,
    )
    unfrozen_gate = GateSpecSnapshot(
        gate_id="gate-b",
        task_id="b",
        version=1,
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=content,
        hash=canonical_gate_hash(content),
        frozen=False,
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=bad_gate.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=unfrozen_gate.hash),
        ],
        blocks=[],
        gates=[bad_gate, unfrozen_gate],
        entry_node_ids=["a", "b"],
        exit_node_ids=["a", "b"],
    )

    errors = PlanValidator().validate(proposal)

    assert PlanValidatorError.MISSING_GATE in errors


def test_plan_validator_rejects_entry_exit_sets_that_do_not_match_graph_topology() -> None:
    gate_a = GateSpecSnapshot.create(
        gate_id="gate-a",
        task_id="a",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["a works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    gate_b = GateSpecSnapshot.create(
        gate_id="gate-b",
        task_id="b",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["b works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[("a", "b")],
        gates=[gate_a, gate_b],
        entry_node_ids=["b"],
        exit_node_ids=["a"],
    )

    errors = PlanValidator().validate(proposal)

    assert PlanValidatorError.MISSING_ENTRY_EXIT in errors


def test_plan_validator_rejects_prose_verification_procedure_steps() -> None:
    gate = GateSpecSnapshot.create(
        gate_id="gate-a",
        task_id="a",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["a works"],
            verification_procedure=[
                "From the workspace root, verify `SYMPHONY_REAL_E2E_RESULT.md` exists.",
                "Run `pytest tests/test_smoke.py -q` and confirm exit code 0.",
            ],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="a",
        nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash)],
        blocks=[],
        gates=[gate],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )

    errors = PlanValidator().validate(proposal)

    assert PlanValidatorError.GATE_UNEXECUTABLE in errors


def test_plan_validator_rejects_empty_and_duplicate_graphs() -> None:
    gate_a = GateSpecSnapshot.create(
        gate_id="gate-a",
        task_id="a",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["a works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    duplicate = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="a", title="A again", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a.hash),
        ],
        blocks=[],
        gates=[gate_a, gate_a],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )
    empty = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[],
        blocks=[],
        gates=[],
        entry_node_ids=[],
        exit_node_ids=[],
    )

    duplicate_errors = PlanValidator().validate(duplicate)
    empty_errors = PlanValidator().validate(empty)

    assert PlanValidatorError.ILLEGAL_EDGE in duplicate_errors
    assert PlanValidatorError.MISSING_ENTRY_EXIT in empty_errors


def test_plan_validator_rejects_parent_blocking_its_own_child() -> None:
    gate_parent = GateSpecSnapshot.create(
        gate_id="gate-parent",
        task_id="parent",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["parent aggregate"],
            verification_procedure=["test -f result.txt"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    gate_child = GateSpecSnapshot.create(
        gate_id="gate-child",
        task_id="child",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["child work"],
            verification_procedure=["test -f child.txt"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    proposal = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="parent",
        nodes=[
            GraphNode(node_id="parent", title="Parent", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_parent.hash),
            GraphNode(
                node_id="child",
                title="Child",
                state=GraphNodeState.PLANNED,
                parent_node_id="parent",
                gate_snapshot_hash=gate_child.hash,
            ),
        ],
        blocks=[("parent", "child")],
        gates=[gate_parent, gate_child],
        entry_node_ids=["parent"],
        exit_node_ids=["child"],
    )

    errors = PlanValidator().validate(proposal)

    assert PlanValidatorError.ILLEGAL_EDGE in errors


def test_scheduler_policy_capacity_and_lease_fencing() -> None:
    capacity = SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.PLAN: 1, RuntimeMode.EXECUTE: None})
    policy = SchedulerPolicy(
        policy_id="policy-1",
        version=4,
        effective_at="2026-07-06T00:00:00Z",
        capacity=capacity,
    )

    assert policy.remaining_for_mode(RuntimeMode.PLAN, active_global=2, active_by_mode={RuntimeMode.PLAN: 0}) == 1
    assert policy.remaining_for_mode(RuntimeMode.PLAN, active_global=2, active_by_mode={RuntimeMode.PLAN: 1}) == 0
    assert policy.remaining_for_mode(RuntimeMode.EXECUTE, active_global=2, active_by_mode={RuntimeMode.EXECUTE: 99}) == 1
    assert policy.accepts_update(policy) is False
    assert policy.accepts_update(policy.with_version(5)) is True

    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = WorkerLease.create(
        lease_id="lease-1",
        mode=RuntimeMode.EXECUTE,
        node_id="node-1",
        attempt_id="attempt-1",
        acquired_at=now,
        ttl_seconds=30,
    )

    assert lease.is_active(now + timedelta(seconds=29), fencing_token=lease.fencing_token)
    assert not lease.is_active(now + timedelta(seconds=31), fencing_token=lease.fencing_token)
    assert not lease.is_active(now, fencing_token="stale")


def test_runtime_profile_and_artifact_manifests_round_trip_without_secrets() -> None:
    profile = RuntimeProfile(
        name="codex-plan",
        backend="codex",
        mode=RuntimeMode.PLAN,
        settings={"model": "gpt-5.3-codex", "token": "secret", "temperature": 0},
    )
    sanitized = profile.sanitized()

    assert sanitized.to_dict()["settings"] == {"model": "gpt-5.3-codex", "temperature": 0}

    snapshot = VerificationInputSnapshot(
        task_id="node-1",
        execute_attempt_id="exec-1",
        base_revision="base",
        patch_uri="artifact://patch.diff",
        patch_hash="sha256:patch",
        expected_result_tree="tree",
        artifact_uris=[{"uri": "artifact://evidence", "sha256": "abc", "type": "log"}],
        declared_commands=["pytest -q"],
        evidence_uri="artifact://evidence",
        gate_snapshot_hash="gate-hash",
        repository_path="/repo",
        workspace_path="/workspace",
    )
    manifest = TaskOutputManifest(
        node_id="node-1",
        verify_attempt_id="verify-1",
        gate_snapshot_hash="gate-hash",
        score=3,
        code={
            "base_revision": snapshot.base_revision,
            "patch_uri": snapshot.patch_uri,
            "expected_result_tree": snapshot.expected_result_tree,
        },
    )

    assert VerificationInputSnapshot.from_dict(snapshot.to_dict()) == snapshot
    assert TaskOutputManifest.from_dict(manifest.to_dict()) == manifest
    assert AttemptState.SUCCEEDED.value == "succeeded"
    assert HumanEscalationReason.PLAN_INVALID.value == "PLAN_INVALID"
    assert HumanEscalationReason.THREAD_LOST.value == "THREAD_LOST"


def test_verification_input_snapshot_preserves_repository_and_workspace_paths() -> None:
    payload = {
        "task_id": "node-1",
        "execute_attempt_id": "exec-1",
        "base_revision": "base",
        "patch_uri": "file:///workspace/.symphony/pipeline/exec-1/patch.diff",
        "patch_hash": "sha256:patch",
        "expected_result_tree": "tree",
        "artifact_uris": [],
        "declared_commands": ["pytest -q"],
        "evidence_uri": "file:///workspace/.symphony/pipeline/exec-1/evidence.json",
        "gate_snapshot_hash": "gate-hash",
        "repository_path": "/source/repo",
        "workspace_path": "/execute/workspace",
    }

    snapshot = VerificationInputSnapshot.from_dict(payload)

    assert snapshot.repository_path == "/source/repo"
    assert snapshot.workspace_path == "/execute/workspace"
    assert VerificationInputSnapshot.from_dict(snapshot.to_dict()) == snapshot


def test_verification_input_snapshot_prefers_branch_commit_handoff() -> None:
    snapshot = VerificationInputSnapshot(
        task_id="node-1",
        execute_attempt_id="exec-1",
        base_revision="base",
        branch_name="symphony/node-1",
        commit_sha="commit-sha",
        artifact_uris=[],
        declared_commands=["pytest -q"],
        evidence_uri="file:///workspace/.symphony/pipeline/exec-1/evidence.json",
        gate_snapshot_hash="gate-hash",
        repository_path="/source/repo",
        workspace_path="/execute/workspace",
    )

    payload = snapshot.to_dict()

    assert payload["branch_name"] == "symphony/node-1"
    assert payload["commit_sha"] == "commit-sha"
    assert "patch_hash" not in payload
    assert "expected_result_tree" not in payload
    assert VerificationInputSnapshot.from_dict(payload) == snapshot


def test_graph_node_state_uses_need_human_with_legacy_awaiting_human_compatibility() -> None:
    states = {state.value for state in GraphNodeState}

    assert "need_human" in states
    assert "awaiting_human" not in states
    assert GraphNodeState.from_value("awaiting_human") is GraphNodeState.NEED_HUMAN


def test_scheduler_policy_defaults_to_verify_passed_dependencies() -> None:
    policy = SchedulerPolicy(
        policy_id="policy-verify-only",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=None),
    )

    assert policy.dependency_policy is DependencySatisfactionPolicy.VERIFY_PASSED
    assert SchedulerPolicy.from_dict(policy.to_dict()).dependency_policy is DependencySatisfactionPolicy.VERIFY_PASSED


def test_execute_and_verify_requests_carry_frozen_gate_revision_and_artifacts() -> None:
    gate = GateSpecSnapshot.create(
        gate_id="gate-node-1",
        task_id="node-1",
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    execute = ExecuteAttemptRequest(
        attempt_id="exec-1",
        node_id="node-1",
        graph_revision=7,
        policy_revision=3,
        gate_snapshot=gate,
        lease_id="lease-exec",
        fencing_token="token-exec",
        base_revision="base-sha",
        repository={"url": "https://example/repo.git", "branch": "main"},
        artifact_paths={"workspace": "/tmp/workspace", "patch": "/tmp/patch.diff"},
        reason="ready",
    )
    verify = VerifyAttemptRequest(
        attempt_id="verify-1",
        node_id="node-1",
        execute_attempt_id="exec-1",
        graph_revision=7,
        policy_revision=3,
        gate_snapshot=gate,
        lease_id="lease-verify",
        fencing_token="token-verify",
        verification_input={"task_id": "node-1", "patch_uri": "artifact://patch"},
        artifact_paths={"workspace": "/tmp/verify"},
        reason="execute_succeeded",
        kind="local-verifier",
    )

    assert ExecuteAttemptRequest.from_dict(execute.to_dict()) == execute
    assert VerifyAttemptRequest.from_dict(verify.to_dict()) == verify
    assert execute.to_dict()["gate_snapshot"]["hash"] == gate.hash
    assert verify.to_dict()["gate_snapshot_hash"] == gate.hash


def test_plan_request_carries_replan_failure_context() -> None:
    request = PlanAttemptRequest(
        attempt_id="plan-2",
        graph_id="graph-node-1",
        root_node_id="node-1",
        node_id="node-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        title="Fix verifier failure",
        graph_revision=7,
        policy_revision=3,
        lease_id="lease-plan",
        fencing_token="token-plan",
        workspace_path="/repo",
        failure_context={
            "reason": "verify_failed",
            "failed_attempt_id": "verify-1",
            "score": 1,
            "error": "assertion failed",
        },
    )

    round_tripped = PlanAttemptRequest.from_dict(request.to_dict())

    assert round_tripped == request
    assert round_tripped.failure_context["failed_attempt_id"] == "verify-1"


def _parallel_shape_proposal(
    *,
    blocks: list[tuple[str, str]],
    titles: dict[str, str] | None = None,
) -> PlanProposal:
    titles = titles or {}
    gates: list[GateSpecSnapshot] = []
    nodes: list[GraphNode] = []
    for node_id, title in (
        ("parallel-a", "Parallel A"),
        ("parallel-b", "Parallel B"),
        ("integration", "Integration downstream"),
    ):
        gate = GateSpecSnapshot.create(
            gate_id=f"gate-{node_id}",
            task_id=node_id,
            created_by="plan-1",
            created_at="2026-07-06T00:00:00Z",
            content=GateSpecContent(
                acceptance_criteria=["authoritative check"],
                verification_procedure=[GateStep("true", GateStepSource.ISSUE_REQUIREMENT)],
                rubric={str(score): f"score {score}" for score in range(5)},
                pass_threshold=3,
            ),
        )
        gates.append(gate)
        nodes.append(
            GraphNode(
                node_id=node_id,
                title=titles.get(node_id, title),
                state=GraphNodeState.PLANNED,
                gate_snapshot_hash=gate.hash,
            )
        )
    return PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=nodes,
        blocks=blocks,
        gates=gates,
        entry_node_ids=["parallel-b", "integration"] if blocks == [] else ["parallel-a", "parallel-b"],
        exit_node_ids=["parallel-b", "integration"] if blocks == [("parallel-a", "integration")] else ["integration"],
    )
