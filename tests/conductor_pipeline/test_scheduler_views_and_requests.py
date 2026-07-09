from __future__ import annotations

from .conftest import *  # noqa: F403

def test_scheduler_finds_stuck_nonterminal_nodes_without_live_driver(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.FAILED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    scheduler = PipelineScheduler(store)

    assert scheduler.find_stuck_nodes() == ["b"]
    store.create_human_wait("b", reason="CAPACITY_STARVED", details={"source": "test"})
    assert scheduler.find_stuck_nodes() == []


def test_scheduler_does_not_mark_promotable_or_live_blocked_planned_nodes_stuck(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("parallel-a")
    gate_b = _gate("parallel-b")
    gate_downstream = _gate("downstream")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="parallel-a",
                    title="Parallel A",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_a.hash,
                ),
                GraphNode(
                    node_id="parallel-b",
                    title="Parallel B",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_b.hash,
                ),
                GraphNode(
                    node_id="downstream",
                    title="Downstream",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_downstream.hash,
                ),
            ],
            blocks=[("parallel-a", "downstream"), ("parallel-b", "downstream")],
            gates=[gate_a, gate_b, gate_downstream],
            entry_node_ids=["parallel-a", "parallel-b"],
            exit_node_ids=["downstream"],
        )
    )
    scheduler = PipelineScheduler(store)

    assert scheduler.find_stuck_nodes() == []
    assert scheduler.promote_ready_nodes() == ["parallel-a", "parallel-b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["parallel-a", "parallel-b"]


async def test_coordinate_surfaces_stuck_pipeline_nodes_as_reconcile_findings_and_human_wait(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.FAILED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )

    first = await service.coordinate_background_once()

    assert any(finding.get("event") == "pipeline_node_stuck" and finding.get("node_id") == "b" for finding in first.reconcile_findings)
    waits = service.pipeline_store.list_human_waits()
    assert waits[-1]["node_id"] == "b"
    assert waits[-1]["reason"] == HumanEscalationReason.CAPACITY_STARVED.value
    assert waits[-1]["details"]["blocked_by"] == ["a: failed"]
    assert waits[-1]["details"]["error"] == "pipeline node has no live driver: a: failed"
    observations = service.pipeline_store.pipeline_view().to_dict()["stuck_observations"]
    assert observations == [
        {
            "count": 1,
            "first_seen_at": observations[0]["first_seen_at"],
            "graph_revision": 1,
            "last_seen_at": observations[0]["last_seen_at"],
            "node_id": "b",
            "reason": "a: failed",
        }
    ]


def test_predicted_call_order_uses_topological_dependency_order_not_node_id_sort(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("z-a")
    gate_b = _gate("m-b")
    gate_c = _gate("a-c")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="z-a",
            nodes=[
                GraphNode(node_id="a-c", title="C", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="m-b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="z-a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            ],
            blocks=[("z-a", "m-b"), ("m-b", "a-c")],
            gates=[gate_a, gate_b, gate_c],
            entry_node_ids=["z-a"],
            exit_node_ids=["a-c"],
        )
    )

    payload = store.pipeline_view().to_dict()

    assert payload["blocks"] == [["z-a", "m-b"], ["m-b", "a-c"]]
    assert [call["node"] for call in payload["predicted_call_order"]] == ["z-a", "m-b", "a-c"]


def test_pipeline_view_exposes_gate_step_provenance_for_shape_checkpoint(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    payload = store.pipeline_view().to_dict()

    assert payload["blocks"] == [["a", "b"]]
    assert payload["gates"]
    steps = payload["gates"][0]["content"]["verification_procedure"]
    assert steps == [{"step": "pytest -q", "source": "issue_requirement"}]


def test_predicted_call_positions_share_capacity_wave_for_same_mode_ready_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = SchedulerPolicy(
        policy_id="policy-capacity",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.EXECUTE: 2}),
    )
    gate_a = _gate("ready-a")
    gate_b = _gate("ready-b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, policy))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="ready-b",
            nodes=[
                GraphNode(node_id="ready-b", title="Ready B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="ready-a", title="Ready A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["ready-a", "ready-b"],
            exit_node_ids=["ready-a", "ready-b"],
        )
    )

    payload = store.pipeline_view().to_dict()
    positions = {call["node"]: call["predicted_position"] for call in payload["predicted_call_order"]}

    assert positions == {"ready-a": 1, "ready-b": 1}


def test_predicted_call_positions_account_for_active_leases(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = SchedulerPolicy(
        policy_id="policy-capacity",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=1, by_mode={RuntimeMode.EXECUTE: 1}),
    )
    gate_a = _gate("ready-a")
    gate_b = _gate("ready-b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, policy))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="ready-a",
            nodes=[
                GraphNode(node_id="ready-a", title="Ready A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="ready-b", title="Ready B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["ready-a", "ready-b"],
            exit_node_ids=["ready-a", "ready-b"],
        )
    )
    store.start_attempt(RuntimeMode.EXECUTE, node_id="ready-a", attempt_id="exec-a", now=datetime(2026, 7, 6, tzinfo=timezone.utc))

    payload = store.pipeline_view().to_dict()
    positions = {call["node"]: call["predicted_position"] for call in payload["predicted_call_order"]}

    assert positions["ready-b"] == 2


def test_pipeline_view_includes_mode_counts_and_conditional_prediction(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex", "token": "secret"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    wait = store.create_human_wait("b", reason="LINEAR_SYNC_CONFLICT", child_issue_id="child-1")
    store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={
            "graph_id": "graph-1",
            "node_id": "a",
            "plan_attempt_id": "plan-1",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash,
            "conductor_revision": 1,
        },
    )

    view = store.pipeline_view()
    payload = view.to_dict()

    execute = next(mode for mode in payload["modes"] if mode["mode"] == "execute")
    assert execute["active"] == 1
    assert execute["limit"] is None
    assert payload["predicted_call_order"][0]["node"] == "a"
    assert payload["predicted_call_order"][1]["blocked_by"] == ["b: awaiting human (LINEAR_SYNC_CONFLICT)"]
    assert payload["predicted_call_order"][1]["predicted_position"] is None
    assert payload["capacity"]["global"] == 2
    assert payload["policy_id"] == "policy-1"
    assert payload["policy_source"] == "podium_pushed"
    assert payload["leases"][0]["lease_id"] == lease.lease_id
    assert payload["attempts"][0]["attempt_id"] == "exec-1"
    assert payload["integration_queue"] == []
    assert payload["manifests"] == []
    assert payload["human_waits"][0]["wait_id"] == wait["wait_id"]
    assert payload["linear_projections"][0]["metadata"]["conductor_revision"] == 1
    assert payload["prediction_basis"]["graph_revision"] == 1
    assert payload["prediction_basis"]["policy_revision"] == 1
    assert payload["prediction_basis"]["assumption"] == "unknown verifies pass"
    assert payload["prediction_basis"]["generated_at"]
    node_a = next(node for node in payload["nodes"] if node["node_id"] == "a")
    assert node_a["progress_measure"] == {
        "replan_depth": 0,
        "rework_count": 0,
        "max_rework_attempts": 3,
        "terminal": False,
        "next_action": "wait_for_execute_result",
    }
    assert payload["runtime_config"]["profiles"]["execute"]["settings"] == {"model": "gpt-5.3-codex"}
    assert "secret" not in str(payload)


def test_pipeline_view_marks_local_default_policy_source(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)

    payload = store.pipeline_view().to_dict()

    assert payload["policy_id"] == "local-default"
    assert payload["policy_source"] == "local_default"
    assert payload["last_scheduler_policy_id"] == ""
    assert payload["last_scheduler_policy_version"] == 0
    assert payload["last_scheduler_policy_source"] == "no_scheduler_tick"
    assert payload["last_scheduler_tick_at"] == ""
    assert payload["prediction_basis"]["policy_id"] == "local-default"
    assert payload["prediction_basis"]["policy_source"] == "no_scheduler_tick"


def test_start_due_attempts_records_scheduler_tick_policy_used_by_view(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = _policy(4)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 4, policy))
    store.commit_plan(_proposal())

    class Runtime:
        async def start(self, instance, **_kwargs):
            return instance

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **_changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    asyncio.run(coordinator.start_due_attempts(Instance()))
    payload = store.pipeline_view().to_dict()

    assert payload["last_scheduler_policy_id"] == policy.policy_id
    assert payload["last_scheduler_policy_version"] == policy.version
    assert payload["last_scheduler_policy_source"] == "podium_pushed"
    assert payload["last_scheduler_tick_at"]
    assert payload["prediction_basis"]["policy_id"] == policy.policy_id
    assert payload["prediction_basis"]["policy_version"] == policy.version
    assert payload["prediction_basis"]["policy_source"] == "podium_pushed"


def test_pipeline_view_excludes_terminal_and_human_wait_nodes_from_mode_queues(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.NEED_HUMAN, human_reason=HumanEscalationReason.BACKEND_UNAVAILABLE)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)

    payload = store.pipeline_view().to_dict()

    assert all("a" not in mode["node_ids"] for mode in payload["modes"])
    assert all("b" not in mode["node_ids"] for mode in payload["modes"])
    assert all(mode["queued"] == 0 for mode in payload["modes"])
    predictions = {call["node"]: call for call in payload["predicted_call_order"]}
    assert predictions["a"]["earliest_mode"] is None
    assert predictions["b"]["earliest_mode"] is None


def test_pipeline_prediction_blocks_on_unintegrated_verified_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            score=3,
            code={"base_revision": "base-a", "patch_uri": "artifact://patch-a"},
        )
    )

    payload = store.pipeline_view().to_dict()
    prediction_b = next(call for call in payload["predicted_call_order"] if call["node"] == "b")

    assert prediction_b["predicted_position"] is None
    assert prediction_b["blocked_by"] == ["a: verified branch output missing"]


def test_pipeline_prediction_does_not_rank_non_dispatchable_terminal_or_human_wait_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.NEED_HUMAN, human_reason=HumanEscalationReason.BACKEND_UNAVAILABLE)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)

    payload = store.pipeline_view().to_dict()
    predictions = {call["node"]: call for call in payload["predicted_call_order"]}

    assert predictions["a"]["predicted_position"] is None
    assert predictions["a"]["earliest_mode"] is None
    assert predictions["a"]["blocked_by"] == ["a: awaiting human (BACKEND_UNAVAILABLE)"]
    assert predictions["b"]["predicted_position"] is None
    assert predictions["b"]["earliest_mode"] is None
    assert predictions["b"]["blocked_by"] == ["b: verify_passed is not dispatchable"]


def test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    attempt = store.get_attempt("exec-1")
    assert attempt.graph_revision == 1
    assert attempt.policy_revision == 1
    assert attempt.lease_id == lease.lease_id
    assert attempt.fencing_token == lease.fencing_token
    view_attempt = store.pipeline_view().to_dict()["attempts"][0]
    assert view_attempt["graph_revision"] == 1
    assert view_attempt["policy_revision"] == 1
    assert view_attempt["lease_id"] == lease.lease_id
    assert view_attempt["fencing_token"] == lease.fencing_token

    stale = ExecuteAttemptResult(
        attempt_id="exec-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=lease.lease_id,
        fencing_token="stale",
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

    assert store.complete_attempt_with_fencing(stale, at=now) is False
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING

    accepted = ExecuteAttemptResult.from_dict({**stale.to_dict(), "fencing_token": lease.fencing_token})
    assert store.complete_attempt_with_fencing(accepted, at=now) is True
    assert store.get_attempt("exec-1").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    with pytest.raises(ValueError, match="terminal_attempt_immutable"):
        store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)

    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)
    verdict = VerifyAttemptResult(
        attempt_id="verify-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=verify_lease.lease_id,
        fencing_token=verify_lease.fencing_token,
        score=3,
        passed=True,
        execute_attempt_id="exec-1",
    )

    assert store.complete_attempt_with_fencing(verdict, at=now) is True
    assert store.get_node("a").state is GraphNodeState.VERIFY_PASSED
    assert store.list_task_output_manifests()[0].verify_attempt_id == "verify-1"


def test_failed_attempt_result_without_error_is_made_visible(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime.now(timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="a", attempt_id="plan-1", now=now, ttl_seconds=30)

    accepted = store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-1",
            node_id="a",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=None,
            error=None,
        ),
        at=now,
    )

    attempt = store.get_attempt("plan-1")
    wait = store.list_human_waits()[0]
    assert accepted is True
    assert attempt.state is AttemptState.FAILED
    assert attempt.error == "attempt_failed_without_reason"
    assert wait["details"]["error"] == "attempt_failed_without_reason"


def test_pipeline_coordinator_launches_planner_for_new_dispatch_with_mode_isolation(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex", "token": "secret"},
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

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    started = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )

    assert started.node_id == "issue-1"
    assert store.get_node("issue-1").state is GraphNodeState.REPLANNING

    import asyncio

    asyncio.run(coordinator.start_due_attempts(Instance()))

    assert captured["mode"] == "plan"
    assert "advance_request_path" not in captured
    assert "phase_result_path" not in captured
    assert captured["attempt_request_path"] is not None
    assert captured["attempt_result_path"] is not None
    assert "CODEX_HOME" in captured["env"]
    assert "secret" not in str(captured["env"])
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_started" in log_text
    assert "mode=plan" in log_text
    assert "node_id=issue-1" in log_text
    assert "attempt_id=plan-" in log_text
    assert "lease_id=issue-1-plan-plan-" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "request_path=" in log_text
    assert "result_path=" in log_text


def test_pipeline_planner_request_preserves_dispatch_graph_metadata(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("source repo\n", encoding="utf-8")
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    captured: dict[str, object] = {}

    class Runtime:
        async def start(self, instance, **kwargs):
            captured.update(kwargs)
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Root",
            "graph_id": "graph-from-dispatch",
            "plan_attempt_id": "plan-from-dispatch",
        },
        instance_id="inst-1",
    )

    asyncio.run(coordinator.start_due_attempts(Instance()))

    request = json.loads(Path(str(captured["attempt_request_path"])).read_text(encoding="utf-8"))
    workspace_path = Path(request["workspace_path"])
    attempt_dir = Path(str(captured["attempt_request_path"])).parent
    assert accepted.graph_id == "graph-from-dispatch"
    assert accepted.plan_attempt_id == "plan-from-dispatch"
    assert request["graph_id"] == "graph-from-dispatch"
    assert request["root_node_id"] == "issue-1"
    assert request["node_id"] == "issue-1"
    assert workspace_path == attempt_dir / "planner-workspace"
    assert request["thread_state_workspace_path"] == str(repo)
    assert workspace_path.is_dir()
    assert (workspace_path / "README.md").read_text(encoding="utf-8") == "source repo\n"
    assert request["issue_description"] == ""


def test_planner_workspace_materialization_isolates_source_repo_writes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    source_file = repo / "README.md"
    source_file.write_text("source repo\n", encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
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
    lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan",
    )
    workspace_path = Path(request["workspace_path"])

    (workspace_path / "README.md").write_text("planner draft\n", encoding="utf-8")

    assert workspace_path == tmp_path / "attempt-plan" / "planner-workspace"
    assert source_file.read_text(encoding="utf-8") == "source repo\n"


def test_pipeline_attempt_requests_include_dispatch_issue_description(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("baseline\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
                RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            },
        )
    )
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    issue_description = (
        "Real Symphony e2e task. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, "
        "include this Linear issue identifier, and run pytest tests/test_smoke.py -q."
    )
    coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "title": "Real E2E",
            "description": issue_description,
            "pipeline_intent": {
                "required_gate_steps": [
                    {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
                    "downstream_node_ids": ["hell-downstream-integration"],
                },
            },
        },
        instance_id="inst-1",
    )
    plan_lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    plan_request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        lease=plan_lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan",
    )
    gate = _gate("issue-1")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-issue-1",
            plan_attempt_id="plan-1",
            root_node_id="issue-1",
            nodes=[
                GraphNode(
                    node_id="issue-1",
                    title="Real E2E",
                    state=GraphNodeState.READY,
                    issue_id="issue-1",
                    issue_identifier="HELL-1",
                    gate_snapshot_hash=gate.hash,
                )
            ],
            blocks=[],
            gates=[gate],
            entry_node_ids=["issue-1"],
            exit_node_ids=["issue-1"],
        )
    )
    execute_lease = store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="issue-1",
        attempt_id="exec-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    execute_request = coordinator._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="issue-1",
        attempt_id="exec-1",
        lease=execute_lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-exec",
    )

    assert plan_request["issue_description"] == issue_description
    assert plan_request["kind"] == "codex"
    assert plan_request["pipeline_intent"]["parallel_dependency_shape"] == {
        "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
        "downstream_node_ids": ["hell-downstream-integration"],
    }
    assert plan_request["pipeline_intent"]["required_gate_steps"] == [
        {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
    ]
    assert execute_request["task_title"] == "Real E2E"
    assert execute_request["issue_identifier"] == "HELL-1"
    assert execute_request["issue_description"] == issue_description
    assert execute_request["kind"] == "codex"


def test_child_replan_attempt_request_falls_back_to_root_dispatch_context(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    root_context = {
        "issue_id": "issue-root",
        "issue_identifier": "HELL-42",
        "title": "Root issue",
        "description": "Root issue description with acceptance context.",
        "pipeline_intent": {
            "requires_parent_aggregate": True,
            "required_gate_steps": [{"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}],
        },
    }
    store.record_dispatch_context("root", root_context)
    store.commit_plan(_parent_proposal(), intent_spec=_parent_intent())
    lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="a",
        attempt_id="plan-child",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="a",
        attempt_id="plan-child",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan-child",
    )

    assert request["issue_id"] == "issue-root"
    assert request["issue_identifier"] == "HELL-42"
    assert request["issue_description"] == "Root issue description with acceptance context."
    assert request["pipeline_intent"]["requires_parent_aggregate"] is True
    assert request["pipeline_intent"]["required_gate_steps"] == [
        {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
    ]


def test_execute_attempt_request_prepares_worktree_from_verified_blocker_branch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "-b", "symphony/a"], cwd=repo, check=True, capture_output=True, text=True)
    (repo / "a.txt").write_text("from blocker\n", encoding="utf-8")
    subprocess.run(["git", "add", "a.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "execute a"], cwd=repo, check=True, capture_output=True, text=True)
    blocker_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "--quiet", base_revision], cwd=repo, check=True)

    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-a",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "branch_name": "symphony/a",
            "commit_sha": blocker_commit,
        },
    )
    store.publish_task_output_manifest(manifest)
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="b", attempt_id="exec-b", now=now, ttl_seconds=30)

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    request = coordinator._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="b",
        attempt_id="exec-b",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    workspace_path = Path(request["artifact_paths"]["workspace_path"])
    assert request["base_revision"] == base_revision
    assert request["repository"]["branch_name"] == "symphony/b"
    assert workspace_path.is_dir()
    assert (workspace_path / "a.txt").read_text(encoding="utf-8") == "from blocker\n"
    assert subprocess.check_output(["git", "branch", "--show-current"], cwd=workspace_path, text=True).strip() == "symphony/b"
    assert request["upstream_manifests"][0]["node_id"] == "a"
    assert request["upstream_manifests"][0]["code"]["commit_sha"] == blocker_commit


def test_deliver_completed_graph_pushes_final_branch_and_invokes_gh_pr_create(tmp_path: Path) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True, text=True)
    repo = tmp_path / "repo"
    subprocess.run(["git", "clone", str(remote), str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "push", "origin", "HEAD:main"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "-b", "symphony/a"], cwd=repo, check=True, capture_output=True, text=True)
    (repo / "RESULT.md").write_text("done\n", encoding="utf-8")
    subprocess.run(["git", "add", "RESULT.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "execute a"], cwd=repo, check=True, capture_output=True, text=True)
    commit_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "--quiet", base_revision], cwd=repo, check=True)

    gate = _gate("a")
    store = ConductorPipelineStore(tmp_path / "store")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="issue-1",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, verify_score=3, gate_snapshot_hash=gate.hash)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=gate.hash,
            score=3,
            code={"base_revision": base_revision, "branch_name": "symphony/a", "commit_sha": commit_sha},
        )
    )
    gh_calls: list[list[str]] = []

    def fake_run(args, **kwargs):
        gh_calls.append(list(args))
        return subprocess.CompletedProcess(args, 0, stdout="https://github.example/pr/1\n", stderr="")

    result = deliver_completed_graph_with_gh(
        store,
        repository_path=repo,
        issue_identifier="HELL-1",
        run_command=fake_run,
    )

    pushed = subprocess.check_output(["git", "--git-dir", str(remote), "rev-parse", "symphony/HELL-1:RESULT.md"], text=True).strip()
    local_blob = subprocess.check_output(["git", "rev-parse", "symphony/HELL-1:RESULT.md"], cwd=repo, text=True).strip()
    assert pushed == local_blob
    assert result["status"] == "delivered"
    assert result["branch_name"] == "symphony/HELL-1"
    assert gh_calls == [["gh", "pr", "create", "--fill", "--head", "symphony/HELL-1"]]
    deliveries = store.pipeline_view().to_dict()["graph_deliveries"]
    assert deliveries[-1]["status"] == "delivered"
    assert deliveries[-1]["branch_name"] == "symphony/HELL-1"
    assert deliveries[-1]["pr_url"] == "https://github.example/pr/1"


@pytest.mark.asyncio
async def test_execute_join_conflict_inserts_resolver_node_before_dispatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "shared.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "shared.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    commits: dict[str, str] = {}
    for node_id, content in {"a": "branch a\n", "c": "branch c\n"}.items():
        subprocess.run(["git", "checkout", "-B", f"symphony/{node_id}", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        (repo / "shared.txt").write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", "shared.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", f"execute {node_id}"], cwd=repo, check=True, capture_output=True, text=True)
        commits[node_id] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "--quiet", base_revision], cwd=repo, check=True)

    gate_a = _gate("a")
    gate_c = _gate("c")
    gate_d = _gate("d")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="d",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, verify_score=3, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.VERIFY_PASSED, verify_score=3, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="d", title="D", state=GraphNodeState.READY, gate_snapshot_hash=gate_d.hash),
            ],
            blocks=[("a", "d"), ("c", "d")],
            gates=[gate_a, gate_c, gate_d],
            entry_node_ids=["a", "c"],
            exit_node_ids=["d"],
        )
    )
    for node_id in ("a", "c"):
        store.publish_task_output_manifest(
            TaskOutputManifest(
                node_id=node_id,
                verify_attempt_id=f"verify-{node_id}",
                gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
                score=3,
                code={"base_revision": base_revision, "branch_name": f"symphony/{node_id}", "commit_sha": commits[node_id]},
            )
        )

    class Runtime:
        calls = 0

        async def start(self, instance, **kwargs):
            self.calls += 1
            return instance

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    runtime = Runtime()
    started = await PipelineCoordinator(store=store, runtime_manager=runtime).start_due_attempts(Instance())

    resolver_ids = [node.node_id for node in store.list_nodes() if node.node_id.startswith("d-merge-conflict")]
    assert started == 0
    assert runtime.calls == 0
    assert len(resolver_ids) == 1
    assert sorted(store.blockers_for(resolver_ids[0])) == ["a", "c"]
    assert store.blockers_for("d") == [resolver_ids[0]]


def test_execute_attempt_request_with_two_blockers_joins_verified_branches(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "a.txt").write_text("a before\n", encoding="utf-8")
    (repo / "c.txt").write_text("c before\n", encoding="utf-8")
    subprocess.run(["git", "add", "a.txt", "c.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    commits: dict[str, str] = {}
    for node_id, filename, content in (("c", "c.txt", "c after\n"), ("a", "a.txt", "a after\n")):
        subprocess.run(["git", "checkout", "-B", f"symphony/{node_id}", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        (repo / filename).write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", filename], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", f"execute {node_id}"], cwd=repo, check=True, capture_output=True, text=True)
        commits[node_id] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "checkout", "--quiet", base_revision], cwd=repo, check=True)

    gate_a = _gate("a")
    gate_c = _gate("c")
    gate_d = _gate("d")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="d",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="d", title="D", state=GraphNodeState.READY, gate_snapshot_hash=gate_d.hash),
            ],
            blocks=[("a", "d"), ("c", "d")],
            gates=[gate_a, gate_c, gate_d],
            entry_node_ids=["a", "c"],
            exit_node_ids=["d"],
        )
    )
    for node_id in ("c", "a"):
        manifest = TaskOutputManifest(
            node_id=node_id,
            verify_attempt_id=f"verify-{node_id}",
            gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
            score=3,
            code={
                "base_revision": base_revision,
                "branch_name": f"symphony/{node_id}",
                "commit_sha": commits[node_id],
            },
        )
        store.publish_task_output_manifest(manifest)

    lease = WorkerLease.create(
        lease_id="lease-exec",
        mode=RuntimeMode.EXECUTE,
        node_id="d",
        attempt_id="exec-d",
        acquired_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        ttl_seconds=30,
    )

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = PipelineCoordinator(store=store, runtime_manager=object())._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="d",
        attempt_id="exec-d",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    workspace = tmp_path / "attempt" / "workspace"
    assert request["base_revision"] == base_revision
    assert request["repository"]["branch_name"] == "symphony/d"
    assert request["artifact_paths"]["workspace_path"] == str(workspace)
    assert (workspace / "a.txt").read_text(encoding="utf-8") == "a after\n"
    assert (workspace / "c.txt").read_text(encoding="utf-8") == "c after\n"
    assert [manifest["node_id"] for manifest in request["upstream_manifests"]] == ["a", "c"]
    assert [manifest["code"]["branch_name"] for manifest in request["upstream_manifests"]] == ["symphony/a", "symphony/c"]
    assert all(manifest["code"]["commit_sha"] for manifest in request["upstream_manifests"])


def test_execute_attempt_request_freezes_entry_baseline_revision(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("baseline\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    lease = WorkerLease.create(
        lease_id="lease-exec",
        mode=RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-1",
        acquired_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        ttl_seconds=30,
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = PipelineCoordinator(store=store, runtime_manager=object())._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-1",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    assert request["base_revision"] == baseline
    assert request["repository"]["resolved_repo_path"] == str(repo)


def test_pipeline_coordinator_resumes_existing_root_planning_node_for_duplicate_dispatch(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    first = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    store.update_node_state("issue-1", GraphNodeState.NEED_HUMAN)

    second = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Updated webhook title should not replace durable graph",
        },
        instance_id="inst-1",
    )

    node = store.get_node("issue-1")
    assert second == first
    assert store.current_graph_revision() == 1
    assert node.title == "Plan feature"
    assert node.state is GraphNodeState.NEED_HUMAN


def test_pipeline_coordinator_resumes_existing_root_by_issue_identifier(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    first = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )

    second = coordinator.accept_dispatch(
        {
            "issue_identifier": "ENG-1",
            "title": "Plan feature duplicate",
        },
        instance_id="inst-1",
    )

    node = store.get_node("issue-1")
    assert second == first
    assert store.current_graph_revision() == 1
    assert node.issue_identifier == "ENG-1"


async def test_dispatch_podium_event_syncs_runtime_config_before_starting_attempt(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    store.save_instance(
        InstanceRecord.create(
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
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 0, _policy(0), profiles={}))
    calls: list[str] = []

    async def fake_report():
        calls.append("report")
        service.pipeline_store.apply_runtime_config(
            RuntimeConfigEnvelope(
                "group-1",
                1,
                _policy(1),
                profiles={
                    RuntimeMode.PLAN: RuntimeProfile(
                        name="planner",
                        backend="codex",
                        mode=RuntimeMode.PLAN,
                        settings={"model": "gpt-5.3-codex"},
                    )
                },
            )
        )
        return {"status": "ok", "config": service.pipeline_store.active_runtime_config().to_dict()}

    async def fake_start(instance, **kwargs):
        calls.append("start")
        return instance.with_updates(process_status="running", pid=1234)

    service.post_podium_report = fake_report  # type: ignore[method-assign]
    service.runtime_manager.start = fake_start  # type: ignore[method-assign]

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
            "project_slug": "ENG",
            "agent_app_user_id": "agent-1",
        }
    )

    assert result["status"] == "accepted"
    assert calls[:2] == ["report", "start"]
    attempt = service.pipeline_store.list_attempts()[0]
    lease = service.pipeline_store.active_lease("issue-1", RuntimeMode.PLAN)
    assert attempt.state is AttemptState.RUNNING
    assert lease is not None
    assert result["node_id"] == "issue-1"
    assert result["mode"] == "plan"
    assert result["attempt_id"] == attempt.attempt_id
    assert result["attempt_status"] == "running"
    assert result["graph_revision"] == 1
    assert result["policy_revision"] == 1
    assert result["lease_id"] == lease.lease_id


def test_conductor_runtime_config_ingest_surfaces_invalid_config(tmp_path: Path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )

    applied = service._apply_runtime_config_payload(
        {
            "runtime_group_id": "group-1",
            "version": 2,
            "scheduler_policy": {
                "policy_id": "policy-2",
                "version": 2,
                "effective_at": "2026-07-06T00:00:00Z",
                "capacity": {"global": 3, "by_mode": {"plan": 1, "execute": 1, "verify": 1}},
            },
            "profiles": {
                "plan": {"name": "planner", "backend": "codex", "mode": "plan", "settings": {"model": "gpt-5.3-codex"}}
            },
        }
    )

    assert applied is False
    assert service._pipeline_reconcile_findings == [
        {
            "event": "runtime_config_apply_failed",
            "severity": "warning",
            "error_type": "ValueError",
            "sanitized_reason": "invalid runtime config: runtime_profiles_missing:execute,verify",
            "action_required": "fix_runtime_config",
            "retryable": True,
            "runtime_group_id": "group-1",
            "version": 2,
        }
    ]
    assert service.pipeline_store.active_runtime_config().version == 1


async def test_dispatch_available_wakeup_leases_dispatch_before_pipeline_accept(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    store.save_instance(
        InstanceRecord.create(
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
        )
    )
    class Runtime:
        async def start(self, instance, **kwargs):
            return instance.with_updates(process_status="running", pid=1234)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=Runtime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)},
        )
    )
    calls: list[str] = []

    async def fake_poll():
        calls.append("lease")
        await service.dispatch_podium_event(
            {
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Plan feature",
                "project_slug": "ENG",
                "agent_app_user_id": "agent-1",
            }
        )
        return {"status": "leased"}

    service.poll_podium_dispatch_once = fake_poll  # type: ignore[method-assign]

    queued = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "project_binding_id": "binding-1",
            "instance_id": "inst-1",
        }
    )
    result = await service.coordinate_background_once()

    assert queued == {"status": "queued", "issue_id": None, "issue_identifier": None, "agent_session_id": None}
    assert calls == ["lease"]
    assert service.pipeline_store.get_node("issue-1").state is GraphNodeState.REPLANNING
    assert result.dispatch_acks["acked"] == 1


