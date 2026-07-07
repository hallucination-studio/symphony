from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    canonical_gate_hash,
    DependencySatisfactionPolicy,
    GateSpecContent,
    GateSpecSnapshot,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanProposal,
    PlanAttemptRequest,
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
    WorkerLease,
)


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
    )

    assert PlanAttemptRequest.from_dict(plan.to_dict()).issue_description == plan.issue_description
    execute_payload = execute.to_dict()
    assert execute_payload["task_title"] == "Real E2E"
    assert execute_payload["issue_identifier"] == "HELL-1"
    assert execute_payload["issue_description"] == "Create SYMPHONY_REAL_E2E_RESULT.md and run pytest."
    assert ExecuteAttemptRequest.from_dict(execute_payload).issue_description == execute.issue_description


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
    )

    payload = attempt.to_dict()
    restored = AttemptRecord.from_dict(payload)

    assert payload["graph_revision"] == 7
    assert payload["policy_revision"] == 3
    assert payload["lease_id"] == "lease-exec"
    assert payload["fencing_token"] == "fence-exec"
    assert restored.graph_revision == 7
    assert restored.policy_revision == 3
    assert restored.lease_id == "lease-exec"
    assert restored.fencing_token == "fence-exec"


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
