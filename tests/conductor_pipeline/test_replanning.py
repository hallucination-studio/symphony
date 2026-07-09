from __future__ import annotations

from .conftest import *  # noqa: F403

def test_replan_replaces_node_with_subgraph_and_rewires_edges_atomically(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
                GraphNode(
                    node_id="a",
                    title="A",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_a.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                    replan_depth=2,
                ),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_root, gate_a, gate_t, gate_b],
            entry_node_ids=["a", "root"],
            exit_node_ids=["b", "root"],
        )
    )
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[("t1", "t2")],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1"],
        exit_node_ids=["t2"],
    )

    revision = store.replace_node_with_subgraph("t", subgraph)

    assert revision.revision == 2
    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t").superseded_by == ["t1", "t2"]
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.get_node("t1").state is GraphNodeState.PLANNED
    assert store.get_node("t2").state is GraphNodeState.PLANNED
    assert store.get_node("t1").replan_depth == 3
    assert store.get_node("t2").replan_depth == 3
    assert store.blockers_for("t1") == ["a"]
    assert store.blockers_for("t2") == ["t1"]
    assert store.blockers_for("b") == ["t2"]
    assert store.get_node("t", revision=1).title == "T"
    assert store.get_node("t", revision=1).state is GraphNodeState.SUPERSEDED
    with store.connect() as connection:
        t1_topology = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 2 AND node_id = 't1'",
            ).fetchone()["payload_json"]
        )
        t1_runtime = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 't1'",
            ).fetchone()["payload_json"]
        )

    assert "state" not in t1_topology
    assert "replan_depth" not in t1_topology
    assert t1_runtime["state"] == GraphNodeState.PLANNED.value
    assert t1_runtime["replan_depth"] == 3


def test_replan_does_not_let_replacement_subgraph_turn_downstream_into_parent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_t1 = _gate("t1")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="t1",
                title="T1",
                state=GraphNodeState.PLANNED,
                parent_node_id="b",
                gate_snapshot_hash=gate_t1.hash,
            ),
        ],
        blocks=[],
        gates=[gate_t1],
        entry_node_ids=["t1"],
        exit_node_ids=["t1"],
    )

    store.replace_node_with_subgraph("t", subgraph)

    assert store.get_node("t1").parent_node_id is None
    assert store.children_for("b") == []
    assert store.blockers_for("b") == ["t1"]


def test_replan_rejects_replacement_subgraph_that_reuses_existing_node_ids(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    reused_gate = _gate("b")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[GraphNode(node_id="b", title="Reused B", state=GraphNodeState.PLANNED, gate_snapshot_hash=reused_gate.hash)],
        blocks=[],
        gates=[reused_gate],
        entry_node_ids=["b"],
        exit_node_ids=["b"],
    )

    with pytest.raises(ValueError, match="replacement subgraph reuses existing node_id"):
        store.replace_node_with_subgraph("t", subgraph)

    assert store.current_graph_revision() == 1
    assert store.get_node("b").title == "B"
    assert store.blockers_for("b") == ["t"]


def test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="t",
            nodes=[GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash)],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    reused_gate = _gate("t")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="t",
        nodes=[GraphNode(node_id="t", title="Replacement T", state=GraphNodeState.PLANNED, gate_snapshot_hash=reused_gate.hash)],
        blocks=[],
        gates=[reused_gate],
        entry_node_ids=["t"],
        exit_node_ids=["t"],
    )

    with pytest.raises(ValueError, match="replacement subgraph reuses superseded node_id"):
        store.replace_node_with_subgraph("t", subgraph)

    assert store.current_graph_revision() == 1
    assert store.get_node("t").state is GraphNodeState.REPLANNING


def test_replanning_plan_attempt_completion_replaces_node_with_subgraph(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
                GraphNode(
                    node_id="a",
                    title="A",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_a.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.VERIFYING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                    rework_count=2,
                ),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_root, gate_a, gate_t, gate_b],
            entry_node_ids=["a", "root"],
            exit_node_ids=["b", "root"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    assert store.get_node("t").state is GraphNodeState.REPLANNING
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-rewrite", now=now, ttl_seconds=30)
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-rewrite",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[("t1", "t2")],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1"],
        exit_node_ids=["t2"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-rewrite",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=subgraph,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t").superseded_by == ["t1", "t2"]
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.blockers_for("t1") == ["a"]
    assert store.blockers_for("t2") == ["t1"]
    assert store.blockers_for("b") == ["t2"]
    assert store.get_attempt("plan-rewrite").state is AttemptState.SUCCEEDED


def test_replanning_replacement_node_completion_replaces_current_node_without_failed_history(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="root",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t1", attempt_id="plan-3", now=now, ttl_seconds=30)
    gate_t1a = _gate("t1a")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-3",
        root_node_id="root",
        nodes=[GraphNode(node_id="t1a", title="T1A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1a.hash)],
        blocks=[],
        gates=[gate_t1a],
        entry_node_ids=["t1a"],
        exit_node_ids=["t1a"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-3",
            node_id="t1",
            status=AttemptState.SUCCEEDED,
            graph_revision=2,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 3
    assert store.get_node("t1").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t1a").replan_depth == 2
    assert store.blockers_for("t1a") == ["a"]
    assert store.blockers_for("b") == ["t1a"]


def test_replanning_replacement_validation_uses_root_parent_intent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    root_intent = {
        "requires_parent_aggregate": True,
        "parallel_dependency_shape": {
            "parallel_branch_node_ids": ["t1", "t2"],
            "downstream_node_ids": [],
        },
    }
    store.record_dispatch_context(
        "root",
        {
            "issue_id": "issue-root",
            "issue_identifier": "HELL-99",
            "description": "Root parent issue",
            "pipeline_intent": root_intent,
        },
    )
    gate_root = _gate("root")
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                ),
            ],
            blocks=[],
            gates=[gate_root, gate_t],
            entry_node_ids=["root", "t"],
            exit_node_ids=["root", "t"],
        ),
        intent_spec=IntentSpec.from_dispatch_context(
            {
                "issue_id": "issue-root",
                "issue_identifier": "HELL-99",
                "description": "Root parent issue",
                "pipeline_intent": root_intent,
            }
        ),
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-parent-repair", now=now, ttl_seconds=30)
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-parent-repair",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1", "t2"],
        exit_node_ids=["t1", "t2"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-parent-repair",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("root").gate_snapshot_hash == gate_root.hash
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.get_attempt("plan-parent-repair").state is AttemptState.SUCCEEDED


def test_replanning_validation_failure_escalates_to_human_without_failed_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    assert store.get_node("t").state is GraphNodeState.REPLANNING
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-invalid-rewrite", now=now, ttl_seconds=30)
    invalid_subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-invalid-rewrite",
        root_node_id="root",
        nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED)],
        blocks=[],
        gates=[],
        entry_node_ids=["t1"],
        exit_node_ids=["t1"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid-rewrite",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=invalid_subgraph,
        ),
        at=now,
    )

    node = store.get_node("t")
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert waits[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value
    assert store.get_attempt("plan-invalid-rewrite").state is AttemptState.FAILED
    assert store.active_lease("t", RuntimeMode.PLAN) is None


def test_replan_depth_limit_escalates_before_rewriting_again(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    gate_snapshot_hash=gate_t.hash,
                    replan_depth=1,
                )
            ],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _record_attempt(
        store,
        "verify-t",
        "t",
        RuntimeMode.VERIFY,
        AttemptState.SUCCEEDED,
        gate_snapshot_hash=gate_t.hash,
        score=0,
    )
    replacement_gate = _gate("t2")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-depth",
        root_node_id="root",
        nodes=[GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=replacement_gate.hash)],
        blocks=[],
        gates=[replacement_gate],
        entry_node_ids=["t2"],
        exit_node_ids=["t2"],
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-depth", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-depth",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    node = store.get_node("t")
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert store.list_human_waits()[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value


def test_failed_invalid_replanning_attempt_escalates_replan_limit_without_backend_collapse(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-invalid-rewrite", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid-rewrite",
            node_id="t",
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

    node = store.get_node("t")
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert waits[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value
    assert waits[-1]["details"]["error"] == "invalid_plan_proposal:missing_gate"
    assert store.get_attempt("plan-invalid-rewrite").state is AttemptState.FAILED
    assert store.active_lease("t", RuntimeMode.PLAN) is None


def test_initial_dispatch_plan_attempt_completion_commits_planner_graph(tmp_path: Path) -> None:
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
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-initial", now=now, ttl_seconds=30)
    gate_a = _gate("a")
    gate_b = _gate("b")
    proposal = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-initial",
        root_node_id=accepted.node_id,
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[("a", "b")],
        gates=[gate_a, gate_b],
        entry_node_ids=["a"],
        exit_node_ids=["b"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-initial",
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

    assert store.current_graph_revision() == 2
    assert {node.node_id for node in store.list_nodes()} == {"a", "b"}
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.blockers_for("b") == ["a"]
    assert store.current_graph_revision_record().root_node_id == accepted.node_id
    assert store.get_attempt("plan-initial").state is AttemptState.SUCCEEDED


def test_diamond_fan_in_uses_graph_edges_without_aggregate_parent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    gate_c = _gate("c")
    gate_d = _gate("d")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="d", title="D", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_d.hash),
            ],
            blocks=[("a", "b"), ("a", "c"), ("b", "d"), ("c", "d")],
            gates=[gate_a, gate_b, gate_c, gate_d],
            entry_node_ids=["a"],
            exit_node_ids=["d"],
        )
    )
    scheduler = PipelineScheduler(store)

    _publish_branch_manifest(store, "a", verify_attempt_id="verify-a")
    assert scheduler.promote_ready_nodes() == ["b", "c"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b", "c"]

    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)
    _publish_branch_manifest(store, "b", verify_attempt_id="verify-b")
    assert scheduler.promote_ready_nodes() == []
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["c"]
    assert store.get_node("d").state is GraphNodeState.PLANNED

    store.update_node_state("c", GraphNodeState.VERIFY_PASSED, verify_score=3)
    _publish_branch_manifest(store, "c", verify_attempt_id="verify-c")
    assert scheduler.promote_ready_nodes() == ["d"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["d"]


