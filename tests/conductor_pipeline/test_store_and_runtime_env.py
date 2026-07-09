from __future__ import annotations

from .conftest import *  # noqa: F403

def test_runtime_config_accepts_only_higher_versions_and_sanitizes_profiles(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    envelope = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=2,
        scheduler_policy=_policy(2),
        profiles={
            RuntimeMode.PLAN: RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"model": "gpt-5.3-codex", "token": "secret", "codex_home_source": "$CODEX_HOME_SOURCE"},
            )
        },
    )

    assert store.apply_runtime_config(envelope) is True
    assert store.apply_runtime_config(envelope) is False
    assert store.active_runtime_config() == envelope

    sanitized = store.pipeline_view().to_dict()
    assert sanitized["policy_revision"] == 2
    assert "secret" not in str(sanitized)
    assert "codex_home_source" not in str(sanitized)


def test_dispatch_context_persists_agent_session_id(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)

    store.record_dispatch_context(
        "node-1",
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Do work",
            "description": "Details",
            "agent_session_id": "session-1",
        },
    )

    assert store.dispatch_context_for_node("node-1")["agent_session_id"] == "session-1"


def test_thread_lost_execute_failure_creates_thread_lost_human_wait(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-thread-lost", now=now)

    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-thread-lost",
            node_id="a",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error=HumanEscalationReason.THREAD_LOST.value,
            thread_id="thread-1",
            verification_input={},
        ),
        at=now,
    )

    waits = store.list_human_waits()
    assert waits[0]["reason"] == HumanEscalationReason.THREAD_LOST.value
    assert store.get_attempt("exec-thread-lost").thread_id == "thread-1"


def test_linear_projector_treats_superseded_nodes_as_complete_for_replanned_graph(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_parent_proposal(), intent_spec=_parent_intent())
    store.update_node_state("root", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.update_node_state("a", GraphNodeState.SUPERSEDED)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)
    projector = PipelineLinearProjector(store=store, tracker=object(), root_issue_id="root-linear")

    assert projector._graph_complete() is True


def test_conductor_instance_creation_does_not_generate_or_persist_workflow(
    tmp_path: Path, monkeypatch
) -> None:
    import conductor.conductor_service_views as views

    def fail_legacy_workflow(*_args, **_kwargs):
        raise AssertionError("legacy workflow path was called")

    monkeypatch.setattr(views, "generate_workflow_content", fail_legacy_workflow, raising=False)
    monkeypatch.setattr(views, "validate_instance_workflow", fail_legacy_workflow, raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("fixture\n", encoding="utf-8")
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )

    instance = service.create_instance(_create_request(repo))

    assert not (Path(instance.instance_dir) / "WORKFLOW.md").exists()
    assert Path(instance.log_path).exists()
    assert (Path(instance.workspace_root) / "README.md").read_text(encoding="utf-8") == "fixture\n"


async def test_conductor_start_and_restart_do_not_validate_workflow(
    tmp_path: Path, monkeypatch
) -> None:
    import conductor.conductor_service_views as views

    def fail_legacy_workflow(*_args, **_kwargs):
        raise AssertionError("legacy workflow validation was called")

    monkeypatch.setattr(views, "validate_instance_workflow", fail_legacy_workflow, raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    runtime = _RecordingRuntime()
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=runtime,
    )
    instance = service.create_instance(_create_request(repo))

    started = await service.start_instance(instance.id)
    restarted = await service.restart_instance(instance.id)

    assert started.process_status == "running"
    assert restarted.process_status == "running"
    assert [call["mode"] for call in runtime.starts] == ["plan", "plan"]
    assert all(call["attempt_request_path"] for call in runtime.starts)
    assert all(call["attempt_result_path"] for call in runtime.starts)
    assert not (Path(instance.instance_dir) / "WORKFLOW.md").exists()


def test_conductor_service_no_longer_exposes_legacy_dashboard(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )
    service.create_instance(_create_request(repo))

    assert not hasattr(service, "dashboard")


def test_podium_report_uses_pipeline_state_not_legacy_dashboard_or_persistence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )
    service.create_instance(_create_request(repo))
    service.pipeline_store.commit_plan(_proposal())

    monkeypatch.setattr(
        service,
        "dashboard",
        lambda: (_ for _ in ()).throw(AssertionError("legacy dashboard used")),
        raising=False,
    )
    monkeypatch.setattr(
        service,
        "_performer_runtime_from_persistence",
        lambda _instance: (_ for _ in ()).throw(AssertionError("legacy persistence used")),
        raising=False,
    )

    report = service.build_podium_report(log_tail_lines=5)

    assert report["pipeline"]["graph_revision"] == 1
    assert report["metrics"]["inst-1"]["blocked"] >= 0
    serialized = json.dumps(report, sort_keys=True)
    assert "persistence_path" not in serialized
    assert '"source": "persistence"' not in serialized


def test_graph_commit_persists_revision_nodes_edges_and_gates(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)

    revision = store.commit_plan(_proposal())

    assert revision.revision == 1
    assert store.current_graph_revision() == 1
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.blockers_for("b") == ["a"]
    assert store.gate_for_node("a") is not None


def test_graph_nodes_store_topology_and_node_runtime_state_is_node_keyed(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    with store.connect() as connection:
        topology_payload = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 1 AND node_id = 'a'",
            ).fetchone()["payload_json"]
        )
        runtime_payload = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 'a'",
            ).fetchone()["payload_json"]
        )

    assert "state" not in topology_payload
    assert "verify_score" not in topology_payload
    assert "rework_count" not in topology_payload
    assert "replan_depth" not in topology_payload
    assert "human_reason" not in topology_payload
    assert runtime_payload["state"] == GraphNodeState.READY.value

    before_topology = topology_payload
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3, replan_depth=2)

    with store.connect() as connection:
        after_topology = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 1 AND node_id = 'a'",
            ).fetchone()["payload_json"]
        )
        after_runtime = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 'a'",
            ).fetchone()["payload_json"]
        )

    assert after_topology == before_topology
    assert after_runtime["state"] == GraphNodeState.VERIFY_PASSED.value
    assert after_runtime["verify_score"] == 3
    assert after_runtime["replan_depth"] == 2


def test_graph_revisions_keep_nodes_immutable_when_node_id_is_reused(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    first = _proposal()
    first_revision = store.commit_plan(first)
    second_gate = _gate("a")
    second = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="a",
                title="A revised",
                state=GraphNodeState.REPLANNING,
                gate_snapshot_hash=second_gate.hash,
                rework_count=1,
            )
        ],
        blocks=[],
        gates=[second_gate],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )

    second_revision = store.commit_plan(second)

    assert first_revision.revision == 1
    assert second_revision.revision == 2
    assert store.get_node("a", revision=1).title == "A"
    assert store.get_node("a", revision=1).state is GraphNodeState.REPLANNING
    assert store.get_node("a", revision=2).title == "A revised"
    assert store.get_node("a", revision=2).state is GraphNodeState.REPLANNING
    assert store.get_node("a").title == "A revised"


def test_commit_plan_resets_runtime_state_when_reusing_node_id_in_new_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
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
    store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-a",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    store.commit_plan(
        PlanProposal(
            graph_id="graph-2",
            plan_attempt_id="plan-2",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A replacement", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a.hash)],
            blocks=[],
            gates=[gate_a],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )

    assert store.get_node("a").title == "A replacement"
    assert store.get_node("a").state is GraphNodeState.PLANNED


def test_start_attempt_updates_only_current_graph_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    first = _proposal()
    store.commit_plan(first)
    second_gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="a",
                    title="A revised",
                    state=GraphNodeState.READY,
                    gate_snapshot_hash=second_gate.hash,
                )
            ],
            blocks=[],
            gates=[second_gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )

    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=datetime(2026, 7, 6, tzinfo=timezone.utc))

    assert store.get_node("a", revision=1).state is GraphNodeState.EXECUTING
    assert store.get_node("a", revision=2).state is GraphNodeState.EXECUTING


def test_execute_attempt_cannot_start_without_frozen_gate_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    _corrupt_current_node_gate(store, "a")

    try:
        store.start_attempt(
            RuntimeMode.EXECUTE,
            node_id="a",
            attempt_id="exec-no-gate",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "frozen_gate_required"
    else:
        raise AssertionError("execute attempt started without a frozen gate")

    assert store.get_node("a").state is GraphNodeState.READY
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None


def test_start_due_attempts_does_not_materialize_runtime_home_before_store_gate_passes(tmp_path: Path) -> None:
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
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    _corrupt_current_node_gate(store, "a")

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("runtime must not start when store gate rejects")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    with pytest.raises(ValueError, match="frozen_gate_required"):
        asyncio.run(coordinator.start_due_attempts(Instance()))

    assert not (tmp_path / "inst-1" / "runtime-homes").exists()


def test_start_due_attempts_fail_closed_when_mode_environment_cannot_materialize(tmp_path: Path) -> None:
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
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    blocked_home_parent = tmp_path / "inst-1" / "runtime-homes" / "execute"
    blocked_home_parent.parent.mkdir(parents=True)
    blocked_home_parent.write_text("not a directory", encoding="utf-8")

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("runtime must not start when environment setup fails")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 0
    node = store.get_node("a")
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    attempt = store.list_attempts()[0]
    assert attempt.state is AttemptState.FAILED
    assert "isolated CODEX_HOME" in (attempt.error or "")
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_start_failed" in log_text
    assert "isolated CODEX_HOME" in log_text
    assert "attempt_id=" in log_text


def test_start_due_attempts_refuses_ineligible_backend_before_dispatch(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="bad-executor",
                    backend="local-verifier",
                    mode=RuntimeMode.EXECUTE,
                )
            },
        )
    )
    store.commit_plan(_proposal())

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("ineligible backend must be refused before runtime dispatch")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 0
    assert store.list_attempts() == []
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert store.get_node("a").state is GraphNodeState.NEED_HUMAN
    assert store.get_node("a").human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE


def test_parallel_same_issue_execute_attempts_use_distinct_codex_homes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root")
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
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                )
            },
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
    captured_homes: list[str] = []

    class Runtime:
        async def start(self, _instance, *, env, **_kwargs):
            captured_homes.append(env["CODEX_HOME"])

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 2
    assert len(captured_homes) == 2
    assert len(set(captured_homes)) == 2
    assert all("/runtime-homes/execute/" in home for home in captured_homes)


def test_start_due_attempts_uses_single_graph_revision_snapshot_for_tick(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
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
                capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.EXECUTE: 2}),
            ),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
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

    class Runtime:
        starts = 0

        async def start(self, _instance, **_kwargs):
            self.starts += 1
            if self.starts == 1:
                store.commit_plan(
                    PlanProposal(
                        graph_id="graph-2",
                        plan_attempt_id="plan-2",
                        root_node_id="a",
                        nodes=[
                            GraphNode(node_id="a", title="A", state=GraphNodeState.EXECUTING, gate_snapshot_hash=gate_a.hash),
                            GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                        ],
                        blocks=[],
                        gates=[gate_a, gate_b],
                        entry_node_ids=["a", "b"],
                        exit_node_ids=["a", "b"],
                    )
                )
            return type("Started", (), {"pid": 1234})()

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 2
    request_revisions = [
        json.loads(path.read_text(encoding="utf-8"))["graph_revision"]
        for path in sorted((Path(Instance.instance_dir) / "state" / "pipeline").glob("*/attempt-request.json"))
    ]
    assert request_revisions == [1, 1]


def test_prepare_mode_environment_copies_injected_codex_home_source(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    (source / "history.jsonl").write_text("do not copy\n", encoding="utf-8")
    (source / "sessions").mkdir()
    (source / "sessions" / "session.jsonl").write_text("do not copy\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"model": "gpt-5.3-codex", "codex_home_source": "$CODEX_HOME_SOURCE"},
        ),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert codex_home == tmp_path / "instance" / "runtime-homes" / "plan" / "codex"
    assert env["CODEX_MODEL"] == "gpt-5.3-codex"
    assert (codex_home / "config.toml").read_text(encoding="utf-8") == "model = 'gpt-5.3-codex'\n"
    assert (codex_home / "auth.json").read_text(encoding="utf-8") == '{"token":"secret-token"}\n'
    assert not (codex_home / "history.jsonl").exists()
    assert not (codex_home / "sessions").exists()


def test_prepare_mode_environment_rejects_direct_codex_home_source_path(tmp_path: Path) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="codex_home_source must be injected through an environment variable"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": str(source)},
            ),
        )


def test_prepare_mode_environment_copies_codex_home_source_from_env_only(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
        ),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert (codex_home / "config.toml").is_file()
    assert (codex_home / "auth.json").is_file()


def test_prepare_mode_environment_sanitizes_codex_config_template(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text(
        '\n'.join(
            [
                'model_provider = "custom"',
                'model = "gpt-5.5"',
                '',
                '[model_providers.custom]',
                'name = "custom"',
                'base_url = "http://127.0.0.1:8080"',
                '',
                '[mcp_servers.node_repl.env]',
                'CODEX_HOME = "/Users/murphy/.codex"',
                'NODE_REPL_NODE_PATH = "/Applications/Codex.app/node"',
                '',
                '[desktop]',
                'followUpQueueMode = "queue"',
                '',
                '[plugins."browser@openai-bundled"]',
                'enabled = true',
                '',
                '[projects."/Users/murphy/code/github/symphony"]',
                'trust_level = "trusted"',
                '',
            ]
        ),
        encoding="utf-8",
    )
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
        ),
    )

    config_text = (Path(env["CODEX_HOME"]) / "config.toml").read_text(encoding="utf-8")
    assert "[model_providers.custom]" in config_text
    assert "CODEX_HOME" not in config_text
    assert "NODE_REPL" not in config_text
    assert "mcp_servers" not in config_text
    assert "plugins." not in config_text
    assert "desktop" not in config_text
    assert "projects." not in config_text


def test_prepare_mode_environment_trusts_exact_attempt_workspace(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    workspace = tmp_path / "instance" / "state" / "pipeline" / "execute-1" / "workspace"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="executor",
            backend="codex",
            mode=RuntimeMode.EXECUTE,
            settings={
                "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE",
                "model": "gpt-5.3-codex",
                "hard_turn_timeout_ms": 120000,
            },
        ),
        workspace_path=workspace,
    )

    codex_home = Path(env["CODEX_HOME"])
    config_text = (codex_home / "config.toml").read_text(encoding="utf-8")
    assert f'[projects."{workspace.resolve()}"]' in config_text
    assert 'trust_level = "trusted"' in config_text
    assert env["CODEX_HARD_TURN_TIMEOUT_MS"] == "120000"


def test_prepare_mode_environment_rejects_env_pointing_at_default_codex_home(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / ".codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    with pytest.raises(ValueError, match="fixed copied seed"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
            ),
        )


def test_prepare_mode_environment_rejects_env_symlink_to_default_codex_home(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / ".codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    symlink = tmp_path / "codex-seed"
    symlink.symlink_to(source, target_is_directory=True)
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(symlink))

    with pytest.raises(ValueError, match="fixed copied seed"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
            ),
        )


def test_prepare_mode_environment_does_not_fallback_to_global_codex_home(tmp_path: Path, monkeypatch) -> None:
    global_home = tmp_path / "global-codex"
    global_home.mkdir()
    (global_home / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(global_home))
    monkeypatch.setenv("HOME", str(tmp_path))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN, settings={}),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert codex_home == tmp_path / "instance" / "runtime-homes" / "plan" / "codex"
    assert not (codex_home / "auth.json").exists()


def test_verify_attempt_cannot_start_without_frozen_gate_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFYING)
    _publish_verification_input(store, "a")
    _corrupt_current_node_gate(store, "a")

    try:
        store.start_attempt(
            RuntimeMode.VERIFY,
            node_id="a",
            attempt_id="verify-no-gate",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "frozen_gate_required"
    else:
        raise AssertionError("verify attempt started without a frozen gate")

    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.VERIFY) is None


def test_verify_attempt_cannot_start_without_execute_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFYING)

    try:
        store.start_attempt(
            RuntimeMode.VERIFY,
            node_id="a",
            attempt_id="verify-no-snapshot",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "verification_input_required"
    else:
        raise AssertionError("verify attempt started without an execute snapshot")

    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.VERIFY) is None


def test_pipeline_store_migrates_legacy_node_primary_key(tmp_path: Path) -> None:
    db_path = tmp_path / "pipeline.db"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE graph_nodes (
              node_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO graph_nodes (node_id, revision, payload_json) VALUES (?, ?, ?)",
            ("legacy", 1, json.dumps(GraphNode("legacy", "Legacy", GraphNodeState.READY).to_dict())),
        )

    store = ConductorPipelineStore(tmp_path)

    with store.connect() as connection:
        pk_columns = [
            str(row[1])
            for row in connection.execute("PRAGMA table_info(graph_nodes)").fetchall()
            if int(row[5] or 0) > 0
        ]
    assert pk_columns == ["revision", "node_id"]
    assert store.get_node("legacy", revision=1).title == "Legacy"


