from __future__ import annotations

from .conftest import *  # noqa: F403

def test_verify_pass_publishes_branch_manifest_and_enqueues_integration(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    execute_lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=execute_lease.lease_id,
            fencing_token=execute_lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "base",
                "branch_name": "symphony/a",
                "commit_sha": "commit-a",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now,
    )
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now,
    )

    manifest = store.list_task_output_manifests()[0]
    queue = store.list_integration_queue()
    assert len(queue) == 1
    assert queue[0]["integration_id"] == "integration-a-verify-1"
    assert queue[0]["node_id"] == "a"
    assert queue[0]["verify_attempt_id"] == "verify-1"
    assert queue[0]["status"] == "queued"
    assert manifest.code["base_revision"] == "base"
    assert manifest.code["branch_name"] == "symphony/a"
    assert manifest.code["commit_sha"] == "commit-a"


def test_verify_pass_requires_matching_execute_snapshot_before_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    with store.connect() as connection:
        connection.execute("DELETE FROM verification_inputs WHERE node_id = ?", ("a",))

    assert not store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now,
    )
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_verify_pass_requires_matching_execute_attempt_id_before_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-current")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert not store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-stale",
        ),
        at=now,
    )
    assert store.get_attempt("verify-1").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_verification_input_for_node_returns_latest_inserted_snapshot_not_uuid_order(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    _publish_verification_input(store, "a", execute_attempt_id="execute-z-old")
    _publish_verification_input(store, "a", execute_attempt_id="execute-a-new")

    snapshot = store.verification_input_for_node("a")

    assert snapshot is not None
    assert snapshot.execute_attempt_id == "execute-a-new"


def test_expired_verify_lease_refuses_passed_verdict_and_publishes_no_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-expired", now=now, ttl_seconds=1)

    accepted = store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-expired",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now + timedelta(seconds=2),
    )

    assert accepted is False
    assert store.get_attempt("verify-expired").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_failed_plan_attempt_result_creates_structured_human_wait(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="issue-1", attempt_id="plan-1", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-1",
            node_id="issue-1",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=None,
            error="unexpected status 401 Unauthorized",
        ),
        at=now,
    )

    node = store.get_node("issue-1")
    waits = store.list_human_waits()
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["lease_id"] == lease.lease_id
    assert waits[0]["details"]["error"] == "unexpected status 401 Unauthorized"


def test_invalid_initial_plan_result_escalates_plan_invalid_without_failed_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-invalid", now=now, ttl_seconds=30)
    gate = _gate("a")
    invalid = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-invalid",
        root_node_id=accepted.node_id,
        nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash)],
        blocks=[("missing", "a")],
        gates=[gate],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=invalid,
        ),
        at=now,
    )

    node = store.get_node(accepted.node_id)
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.PLAN_INVALID
    assert waits[-1]["reason"] == HumanEscalationReason.PLAN_INVALID.value
    assert store.get_attempt("plan-invalid").state is AttemptState.FAILED


def test_failed_invalid_initial_plan_result_escalates_plan_invalid_without_backend_collapse(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-invalid", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:missing_gate",
        ),
        at=now,
    )

    node = store.get_node(accepted.node_id)
    waits = store.list_human_waits()
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.PLAN_INVALID
    assert waits[-1]["reason"] == HumanEscalationReason.PLAN_INVALID.value
    assert waits[-1]["details"]["error"] == "invalid_plan_proposal:missing_gate"
    assert store.get_attempt("plan-invalid").state is AttemptState.FAILED


def test_invalid_plan_gate_and_credentials_map_to_specific_human_reasons(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "title": "Plan feature"}, instance_id="inst-1")
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    prose_gate = GateSpecSnapshot.create(
        gate_id="gate-a",
        task_id="a",
        created_by="plan-gate",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["a works"],
            verification_procedure=["verify the feature manually"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-gate", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-gate",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=PlanProposal(
                graph_id=accepted.graph_id,
                plan_attempt_id="plan-gate",
                root_node_id=accepted.node_id,
                nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=prose_gate.hash)],
                blocks=[],
                gates=[prose_gate],
                entry_node_ids=["a"],
                exit_node_ids=["a"],
            ),
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.GATE_UNEXECUTABLE

    store.update_node_state(accepted.node_id, GraphNodeState.REPLANNING, human_reason=None)
    credential_gate = GateSpecSnapshot.create(
        gate_id="gate-b",
        task_id="b",
        created_by="plan-credential",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["b works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
            verifier_credentials=["LINEAR_TOKEN"],
        ),
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-credential", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-credential",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=PlanProposal(
                graph_id=accepted.graph_id,
                plan_attempt_id="plan-credential",
                root_node_id=accepted.node_id,
                nodes=[GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=credential_gate.hash)],
                blocks=[],
                gates=[credential_gate],
                entry_node_ids=["b"],
                exit_node_ids=["b"],
            ),
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.CREDENTIAL_REQUIRED


def test_failed_invalid_plan_gate_and_credentials_map_to_specific_human_reasons(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "title": "Plan feature"}, instance_id="inst-1")
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-gate", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-gate",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:gate_unexecutable",
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.GATE_UNEXECUTABLE

    store.update_node_state(accepted.node_id, GraphNodeState.REPLANNING, human_reason=None)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-credential", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-credential",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:verifier_credential_unavailable",
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.CREDENTIAL_REQUIRED


def test_conductor_repairs_plan_from_structured_dispatch_intent_at_commit_time(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
            "intent": {
                "required_gate_steps": [
                    {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["branch-a", "branch-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gates = [_gate("branch-a"), _gate("branch-b"), _gate("integration")]
    proposal = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-raw",
        root_node_id=accepted.node_id,
        nodes=[
            GraphNode(node_id="branch-a", title="First branch", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[0].hash),
            GraphNode(node_id="branch-b", title="Second branch", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[1].hash),
            GraphNode(node_id="integration", title="Join work", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[2].hash),
        ],
        blocks=[("branch-a", "integration")],
        gates=gates,
        entry_node_ids=["branch-a", "branch-b"],
        exit_node_ids=["branch-b", "integration"],
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-raw", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-raw",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=proposal,
        ),
        at=now,
    )

    assert ("branch-a", "integration") in store.current_blocks()
    assert ("branch-b", "integration") in store.current_blocks()
    integration_gate = store.gate_for_node("integration")
    assert integration_gate is not None
    assert GateStep("pytest tests/test_smoke.py -q", GateStepSource.APPENDIX_HARNESS) in integration_gate.content.verification_procedure


def test_verify_failure_moves_node_to_replanning_without_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-verify-fail")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-fail", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-fail",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=2,
            passed=False,
            execute_attempt_id="exec-for-verify-fail",
        ),
        at=now,
    )

    node = store.get_node("a")
    assert node.state is GraphNodeState.REPLANNING
    assert node.verify_score == 2
    assert node.rework_count == 0
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_same_stage_verify_attempt_failure_at_retry_limit_moves_node_to_need_human(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=2)))
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate.hash, rework_count=1)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-verify-crash")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-crash", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-crash",
            node_id="a",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate.hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=None,
            passed=False,
            execute_attempt_id="exec-for-verify-crash",
            error="verifier process crashed",
        ),
        at=now,
    )

    node = store.get_node("a")
    wait = store.list_human_waits()[0]
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.GATE_UNEXECUTABLE
    assert node.rework_count == 2
    assert wait["node_id"] == "a"
    assert wait["reason"] == HumanEscalationReason.GATE_UNEXECUTABLE.value
    assert wait["details"]["mode"] == RuntimeMode.VERIFY.value


def test_replanning_attempt_request_includes_failed_verify_context(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1, max_rework_attempts=1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex"},
                ),
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex"},
                ),
                RuntimeMode.VERIFY: RuntimeProfile(
                    name="local-verifier",
                    backend="local-verifier",
                    mode=RuntimeMode.VERIFY,
                    settings={},
                ),
            },
        )
    )
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate.hash)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-replan")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-fail", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-fail",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate.hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=1,
            passed=False,
            execute_attempt_id="exec-for-replan",
            error="assertion failed",
        ),
        at=now,
    )
    captured: dict[str, object] = {}

    class Runtime:
        async def start(self, instance, **kwargs):
            captured.update(kwargs)
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    import asyncio

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 1
    request = json.loads(Path(str(captured["attempt_request_path"])).read_text(encoding="utf-8"))

    assert request["failure_context"]["reason"] == "verify_failed"
    assert request["failure_context"]["failed_attempt_id"] == "verify-fail"
    assert request["failure_context"]["score"] == 1
    assert request["failure_context"]["error"] == "assertion failed"


