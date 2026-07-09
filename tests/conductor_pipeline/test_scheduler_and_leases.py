from __future__ import annotations

from .conftest import *  # noqa: F403

def test_dependency_requires_verified_branch_output_by_default(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]

    store.update_node_state("a", GraphNodeState.FAILED)
    assert scheduler.is_dependency_satisfied("a") is False

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=2)
    assert scheduler.is_dependency_satisfied("a") is False

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            score=3,
            code={"base_revision": "base", "branch_name": "symphony/a", "commit_sha": "commit-a"},
        )
    )
    assert scheduler.is_dependency_satisfied("a") is True
    assert scheduler.promote_ready_nodes() == ["b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_need_human_projects_to_blocked_linear_state() -> None:
    node = GraphNode(
        node_id="a",
        title="A",
        state=GraphNodeState.NEED_HUMAN,
        human_reason=HumanEscalationReason.BACKEND_UNAVAILABLE,
    )

    assert _linear_workflow_state_target_for_node(node) == (["Blocked", "Needs Human", "Need Human"], "")


def test_dependency_satisfaction_requires_verified_manifest_for_downstream(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    store.update_node_state("a", GraphNodeState.FAILED)
    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.promote_ready_nodes() == []
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    _publish_branch_manifest(store, "a", verify_attempt_id="verify-a")
    assert scheduler.is_dependency_satisfied("a") is True
    assert scheduler.promote_ready_nodes() == ["b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_planned_nodes_do_not_execute_until_promoted_to_ready(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    assert store.get_node("b").state is GraphNodeState.PLANNED
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    _publish_branch_manifest(store, "a", verify_attempt_id="verify-a", commit_sha="commit-a")

    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []
    assert scheduler.promote_ready_nodes() == ["b"]
    assert store.get_node("b").state is GraphNodeState.READY
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_verifier_dispatch_requires_execute_snapshot_and_skips_active_verify_lease(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    store.update_node_state("a", GraphNodeState.VERIFYING)

    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == []

    execute_lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    accepted = ExecuteAttemptResult(
        attempt_id="exec-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=execute_lease.lease_id,
        fencing_token=execute_lease.fencing_token,
        verification_input={
            "task_id": "a",
            "execute_attempt_id": "exec-1",
            "base_revision": "base",
            "patch_uri": "artifact://patch",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
            "artifact_uris": [],
            "declared_commands": ["pytest -q"],
            "evidence_uri": "artifact://evidence",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash or "",
            "repository_path": "/repo",
            "workspace_path": "/workspace",
        },
    )
    assert store.complete_attempt_with_fencing(accepted, at=now)
    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == ["a"]

    store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == []


def test_execute_completion_requires_matching_complete_verification_input_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "other-exec",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
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
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.verification_input_for_node("a") is None

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "",
                "patch_uri": "",
                "patch_hash": "",
                "expected_result_tree": "",
                "artifact_uris": [],
                "declared_commands": [],
                "evidence_uri": "",
                "gate_snapshot_hash": gate_hash,
            },
        ),
        at=now,
    )
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.verification_input_for_node("a") is None


def test_leases_expire_and_fence_stale_attempt_results(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    lease = store.acquire_lease(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.active_lease("a", RuntimeMode.EXECUTE) == lease
    assert store.validate_fencing_token("a", RuntimeMode.EXECUTE, lease.fencing_token, at=now + timedelta(seconds=4))
    assert not store.validate_fencing_token("a", RuntimeMode.EXECUTE, lease.fencing_token, at=now + timedelta(seconds=6))

    store.reclaim_expired_leases(now + timedelta(seconds=6))
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None


def test_lowered_policy_limit_stops_new_dispatch_without_preempting_active_lease(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-1",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.EXECUTE: 2}),
            ),
        )
    )
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    active = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now)
    assert store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            2,
            SchedulerPolicy(
                policy_id="policy-2",
                version=2,
                effective_at="2026-07-06T00:00:01Z",
                capacity=SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.EXECUTE: 1}),
            ),
        )
    )

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("new execute dispatch must be stopped while lowered limit is saturated")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance(), now=now + timedelta(seconds=1))) == 0
    assert store.active_lease("a", RuntimeMode.EXECUTE) == active
    assert store.active_lease("b", RuntimeMode.EXECUTE) is None
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.get_node("b").state is GraphNodeState.READY
    assert store.list_human_waits() == []


def test_result_fence_accepts_inflight_attempt_after_policy_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=600)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 2, _policy(2)))

    result_path = tmp_path / "inst-1" / "state" / "pipeline" / "exec-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id="exec-1",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=gate_hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                verification_input={
                    "task_id": "a",
                    "execute_attempt_id": "exec-1",
                    "base_revision": "base",
                    "patch_uri": "artifact://patch",
                    "patch_hash": "sha256:patch",
                    "expected_result_tree": "tree",
                    "artifact_uris": [],
                    "declared_commands": ["pytest -q"],
                    "evidence_uri": "artifact://evidence",
                    "gate_snapshot_hash": gate_hash,
                    "repository_path": "/repo",
                    "workspace_path": "/workspace",
                },
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    assert coordinator.collect_result_files(Instance(), now=now + timedelta(seconds=60)) == 1
    assert store.get_attempt("exec-1").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert result_path.with_suffix(".json.applied").exists()


def test_result_fence_rejects_policy_revision_mismatched_to_attempt(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=600)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 2, _policy(2)))

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=2,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is not None


def test_result_fence_accepts_inflight_attempt_after_unrelated_graph_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a", "t"],
            exit_node_ids=["a", "b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now, ttl_seconds=600)
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-rewrite",
            root_node_id="root",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.READY, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-a",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_a.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-a",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_a.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-a").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING


def test_result_fence_rejects_result_with_graph_revision_mismatching_attempt_record(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash)],
            blocks=[],
            gates=[gate_a],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now, ttl_seconds=600)

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-a",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=2,
            policy_revision=1,
            gate_snapshot_hash=gate_a.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-a",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_a.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-a").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.EXECUTING


def test_result_fence_rejects_superseded_node_attempt_after_graph_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_t = _gate("t")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="t",
            nodes=[GraphNode(node_id="t", title="T", state=GraphNodeState.READY, gate_snapshot_hash=gate_t.hash)],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="t", attempt_id="exec-t", now=now, ttl_seconds=600)
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-rewrite",
            root_node_id="t1",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.READY, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )

    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "t",
                "execute_attempt_id": "exec-t",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_t.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-t").state is AttemptState.RUNNING


def test_reclaiming_expired_execute_lease_times_out_attempt_and_allows_retry(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.reclaim_expired_leases(now + timedelta(seconds=6)) == 1

    attempt = store.get_attempt("exec-1")
    node = store.get_node("a")
    waits = store.list_human_waits()
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert attempt.state is AttemptState.TIMED_OUT
    assert attempt.completed_at == "2026-07-06T00:00:06Z"
    assert attempt.error == "worker lease expired before attempt result was published"
    assert node.state is GraphNodeState.READY
    assert node.human_reason is None
    assert waits == []
    assert PipelineScheduler(store).dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]


def test_reclaiming_expired_lease_is_idempotent_without_double_count_or_leak(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    first = store.reclaim_expired_leases(now + timedelta(seconds=6))
    second = store.reclaim_expired_leases(now + timedelta(seconds=7))

    assert first == 1
    assert second == 0
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert store.list_human_waits() == []
    assert store.get_attempt("exec-1").state is AttemptState.TIMED_OUT


def test_lease_heartbeat_extends_active_lease_and_rejects_stale_token(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.acquire_lease(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.heartbeat_lease(lease.lease_id, lease.fencing_token, at=now + timedelta(seconds=4), ttl_seconds=10)
    refreshed = store.active_lease("a", RuntimeMode.EXECUTE)
    assert refreshed is not None
    assert refreshed.heartbeat_at == "2026-07-06T00:00:04Z"
    assert refreshed.expires_at == "2026-07-06T00:00:14Z"
    assert not store.heartbeat_lease(lease.lease_id, "stale", at=now + timedelta(seconds=5), ttl_seconds=10)


def test_pipeline_coordinator_heartbeats_running_attempt_leases(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    assert coordinator.heartbeat_active_leases(at=now + timedelta(seconds=4), ttl_seconds=10) == 1
    assert store.reclaim_expired_leases(now + timedelta(seconds=6)) == 0

    refreshed = store.active_lease("a", RuntimeMode.EXECUTE)
    assert refreshed is not None
    assert refreshed.heartbeat_at == "2026-07-06T00:00:04Z"
    assert refreshed.expires_at == "2026-07-06T00:00:14Z"
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING


def test_background_heartbeat_uses_active_leases_not_instance_process_status(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    ).with_updates(process_status="exited", pid=None, last_exit_code=0)
    store.save_instance(instance)

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=0)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    now = datetime.now(timezone.utc)
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-1",
        now=now,
        ttl_seconds=5,
    )

    assert service._heartbeat_running_pipeline_leases() == 1

    refreshed = service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE)
    assert refreshed is not None
    assert refreshed.expires_at > lease.expires_at
    assert service.pipeline_store.get_attempt("exec-1").state is AttemptState.RUNNING


