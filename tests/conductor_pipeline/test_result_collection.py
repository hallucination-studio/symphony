from __future__ import annotations

from .conftest import *  # noqa: F403

async def test_dispatch_queue_drain_surfaces_failed_dispatch_acceptance(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )

    async def fail_dispatch(_event):
        raise RuntimeError("token=dispatch-secret malformed payload")

    service.dispatch_podium_event = fail_dispatch  # type: ignore[method-assign]

    queued = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "agent_app_user_id": "agent-1",
        }
    )
    result = await service.coordinate_background_once()

    assert queued == {"status": "queued", "issue_id": "issue-1", "issue_identifier": "ENG-1", "agent_session_id": None}
    assert result.dispatch_acks == {"acked": 0, "failed": 1, "skipped": 0}
    assert result.reconcile_findings == [
        {
            "event": "podium_dispatch_drain_failed",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "token=[REDACTED] malformed payload",
            "action_required": "retry_dispatch_drain",
            "retryable": True,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
        }
    ]


async def test_background_coordination_fails_running_attempt_when_process_exits_without_result(tmp_path: Path) -> None:
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
    )
    instance = instance.with_updates(process_status="running", pid=1234)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text(
        "performer startup failed: unexpected status 401 Unauthorized: Missing bearer authentication\n",
        encoding="utf-8",
    )
    store.save_instance(instance)
    exited_at = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat().replace("+00:00", "Z")

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=1, updated_at=exited_at)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
            },
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )

    result = await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    node = service.pipeline_store.get_node("issue-1")
    waits = service.pipeline_store.list_human_waits()
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert result.pipeline_crash_failures == 1
    assert attempt.state is AttemptState.FAILED
    assert "401 Unauthorized" in str(attempt.error)
    assert service.pipeline_store.active_lease("issue-1", RuntimeMode.PLAN) is None
    assert node.state is GraphNodeState.NEED_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["lease_id"] == lease.lease_id
    assert "401 Unauthorized" in waits[0]["details"]["error"]
    assert "pipeline_attempt_process_exited" in log_text
    assert "attempt_id=plan-1" in log_text


async def test_background_coordination_starts_due_attempts_while_instance_already_running(tmp_path: Path) -> None:
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
    ).with_updates(process_status="running", pid=1234)
    store.save_instance(instance)

    class RunningRuntime:
        def __init__(self) -> None:
            self.starts: list[dict[str, object]] = []

        def refresh(self, record):
            return record

        async def start(self, record, **kwargs):
            self.starts.append(kwargs)
            return record.with_updates(process_status="running", pid=1234)

    runtime = RunningRuntime()
    service = ConductorService(store=store, data_root=data_root, runtime_manager=runtime)  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
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

    result = await service.coordinate_background_once()

    assert result.pipeline_attempts_started == 2
    assert [start["mode"] for start in runtime.starts] == ["execute", "execute"]
    assert sorted(lease.node_id for lease in service.pipeline_store.list_active_leases()) == ["a", "b"]
    assert sorted(
        attempt.process_pid for attempt in service.pipeline_store.list_attempts() if attempt.mode is RuntimeMode.EXECUTE
    ) == [1234, 1234]
    assert all(
        attempt["process_pid"] == 1234
        for attempt in service.pipeline_store.pipeline_view().to_dict()["attempts"]
        if attempt["mode"] == "execute"
    )


async def test_background_coordination_fails_only_drained_exited_attempt(tmp_path: Path) -> None:
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
    ).with_updates(process_status="running", pid=2222)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text("attempt exec-a exited while exec-b kept running\n", encoding="utf-8")
    store.save_instance(instance)

    class AttemptExitRuntime:
        def __init__(self) -> None:
            self._drained = False

        def refresh(self, record):
            return record

        def drain_exited_attempts(self, record):
            if self._drained:
                return []
            self._drained = True
            return [
                {
                    "instance_id": record.id,
                    "attempt_id": "exec-a",
                    "mode": "execute",
                    "lease_id": lease_a.lease_id,
                    "pid": 1111,
                    "exit_code": 7,
                }
            ]

        async def start(self, record, **_kwargs):
            return record.with_updates(process_status="running", pid=2222)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=AttemptExitRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
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
    now = datetime.now(timezone.utc)
    lease_a = service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now)
    lease_b = service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="b", attempt_id="exec-b", now=now)

    result = await service.coordinate_background_once()

    assert result.pipeline_crash_failures == 1
    assert service.pipeline_store.get_attempt("exec-a").state is AttemptState.FAILED
    assert service.pipeline_store.get_attempt("exec-b").state is AttemptState.RUNNING
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert service.pipeline_store.active_lease("b", RuntimeMode.EXECUTE).lease_id == lease_b.lease_id  # type: ignore[union-attr]
    assert "process exited with code 7" in str(service.pipeline_store.get_attempt("exec-a").error)
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_process_exited" in log_text
    assert "attempt_id=exec-a" in log_text
    assert "attempt_id=exec-b" not in log_text


def test_startup_reconcile_handles_dead_current_exited_and_live_attempts(tmp_path: Path) -> None:
    class DeadRuntime:
        def refresh(self, record):
            return record

        def recover_attempt(self, record, attempt):
            return None

    class CurrentExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=99999, last_exit_code=0)

        def recover_attempt(self, record, attempt):
            return None

    class LiveRuntime:
        def __init__(self) -> None:
            self.recovered: list[str] = []

        def refresh(self, record):
            return record

        def recover_attempt(self, record, attempt):
            self.recovered.append(attempt.attempt_id)
            return record.with_updates(process_status="running", pid=attempt.process_pid)

    def make_service(case: str, runtime, *, process_pid: int) -> tuple[ConductorService, InstanceRecord]:
        data_root = tmp_path / case / "conductor-data"
        repo = tmp_path / case / "repo"
        repo.mkdir(parents=True)
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
        ).with_updates(process_status="running", pid=process_pid)
        store.save_instance(instance)

        service = ConductorService(store=store, data_root=data_root, runtime_manager=runtime)  # type: ignore[arg-type]
        service.pipeline_store.apply_runtime_config(
            RuntimeConfigEnvelope(
                "group-1",
                1,
                _policy(1),
                profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
            )
        )
        service.pipeline_store.commit_plan(_proposal())
        return service, instance

    service, instance = make_service("dead", DeadRuntime(), process_pid=99999)
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-dead",
        now=datetime.now(timezone.utc),
    )
    service.pipeline_store.record_attempt_process_pid("exec-dead", 99999)

    reconciled = service.reconcile_pipeline_attempts_on_startup()

    assert reconciled == 1
    assert service.pipeline_store.get_attempt("exec-dead").state is AttemptState.FAILED
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE) is None
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_orphan_reconciled" in log_text
    assert "attempt_id=exec-dead" in log_text
    assert "process_pid=99999" in log_text
    assert lease.lease_id in log_text

    service, _ = make_service("current-exited", CurrentExitedRuntime(), process_pid=99999)
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-current-exited",
        now=datetime.now(timezone.utc),
    )
    service.pipeline_store.record_attempt_process_pid("exec-current-exited", 99999)

    reconciled = service.reconcile_pipeline_attempts_on_startup()

    assert reconciled == 0
    assert service.pipeline_store.get_attempt("exec-current-exited").state is AttemptState.RUNNING
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE).lease_id == lease.lease_id  # type: ignore[union-attr]

    live_runtime = LiveRuntime()
    service, _ = make_service("live", live_runtime, process_pid=2222)
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-live",
        now=datetime.now(timezone.utc),
    )
    service.pipeline_store.record_attempt_process_pid("exec-live", 2222)

    reconciled = service.reconcile_pipeline_attempts_on_startup()

    assert reconciled == 0
    assert live_runtime.recovered == ["exec-live"]
    assert service.pipeline_store.get_attempt("exec-live").state is AttemptState.RUNNING
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE).lease_id == lease.lease_id  # type: ignore[union-attr]


async def test_restart_instance_resumes_existing_graph_without_manual_replan(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    runtime = _RecordingRuntime()
    service = ConductorService(store=store, data_root=data_root, runtime_manager=runtime)  # type: ignore[arg-type]
    instance = service.create_instance(_create_request(repo))
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    service.pipeline_store.commit_plan(_proposal())

    restarted = await service.restart_instance(instance.id)

    assert restarted.id == instance.id
    assert len(runtime.stops) == 1
    assert len(runtime.starts) == 1
    assert runtime.starts[0]["mode"] == "execute"
    assert "manual-restart-request.json" not in str(runtime.starts[0].get("attempt_request_path"))
    assert not (Path(instance.instance_dir) / "state" / "pipeline" / "manual-restart-request.json").exists()
    assert service.pipeline_store.current_graph_revision() == 1


def test_process_exit_failure_defers_for_result_file_and_recent_exit(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "result-present")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate.hash)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=datetime.now(timezone.utc))
    verification_input = _publish_verification_input(store, "a", execute_attempt_id="exec-a")
    result_path = tmp_path / "result-present" / "inst-1" / "state" / "pipeline" / "exec-a" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    graph_revision = store.current_graph_revision()
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id="exec-a",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=graph_revision,
                policy_revision=1,
                gate_snapshot_hash=gate.hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                verification_input=verification_input.to_dict(),
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class Instance:
        instance_dir = str(tmp_path / "result-present" / "inst-1")
        log_path = str(tmp_path / "result-present" / "inst-1" / "logs" / "performer.log")
        process_status = "exited"
        last_exit_code = 0

    coordinator = PipelineCoordinator(store=store, runtime_manager=None)

    failed = coordinator.fail_exited_attempt_snapshot(
        Instance,
        {
            "attempt_id": "exec-a",
            "mode": "execute",
            "lease_id": lease.lease_id,
            "result_path": str(result_path),
            "exit_code": 0,
        },
    )

    assert failed == 0
    assert coordinator.fail_running_attempts_for_exited_process(Instance) == 0
    assert store.get_attempt("exec-a").state is AttemptState.RUNNING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is not None
    assert coordinator.collect_result_files(Instance) == 1
    assert store.get_attempt("exec-a").state is AttemptState.SUCCEEDED

    store = ConductorPipelineStore(tmp_path / "recent-exit")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)},
        )
    )
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.REPLANNING)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="a", attempt_id="plan-a", now=datetime.now(timezone.utc))

    class RecentExitInstance:
        instance_dir = str(tmp_path / "recent-exit" / "inst-1")
        log_path = str(tmp_path / "recent-exit" / "inst-1" / "logs" / "performer.log")
        process_status = "exited"
        last_exit_code = 0
        updated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    coordinator = PipelineCoordinator(store=store, runtime_manager=None)

    failed = coordinator.fail_running_attempts_for_exited_process(RecentExitInstance)

    assert failed == 0
    assert store.get_attempt("plan-a").state is AttemptState.RUNNING
    assert store.active_lease("a", RuntimeMode.PLAN).lease_id == lease.lease_id  # type: ignore[union-attr]


async def test_process_exit_error_uses_current_generation_log_tail(tmp_path: Path) -> None:
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
    ).with_updates(process_status="running", pid=1234)
    logs_dir = instance_dir / "logs"
    logs_dir.mkdir(parents=True)
    current_log = logs_dir / "performer-000001.log"
    current_log.write_text("event=performer_stream message=401 Unauthorized from current generation\n", encoding="utf-8")
    (logs_dir / "current.log").write_text(str(current_log), encoding="utf-8")
    Path(instance.log_path).write_text("stale start line only\n", encoding="utf-8")
    store.save_instance(instance)
    exited_at = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat().replace("+00:00", "Z")

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=1, updated_at=exited_at)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)},
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "ENG-1", "title": "Plan feature"},
        instance_id="inst-1",
    )
    service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )

    await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    assert "401 Unauthorized from current generation" in str(attempt.error)


async def test_background_coordination_applies_result_file_before_process_exit_fallback(tmp_path: Path) -> None:
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
    )
    instance = instance.with_updates(process_status="running", pid=1234)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text("performer exited after writing fenced failure\n", encoding="utf-8")
    store.save_instance(instance)

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=0)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
            },
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )
    result_path = instance_dir / "state" / "pipeline" / "plan-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
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
                error="unexpected status 401 Unauthorized: Missing bearer authentication",
            ).to_dict()
        ),
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    waits = service.pipeline_store.list_human_waits()
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert result.pipeline_results_applied == 1
    assert result.pipeline_crash_failures == 0
    assert attempt.state is AttemptState.FAILED
    assert attempt.error == "unexpected status 401 Unauthorized: Missing bearer authentication"
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["error"] == "unexpected status 401 Unauthorized: Missing bearer authentication"
    assert "pipeline_attempt_process_exited" not in log_text
    assert result_path.with_suffix(".json.applied").exists()


def test_pipeline_coordinator_collects_result_files_with_fencing(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            },
        )
    )
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    class Runtime:
        async def start(self, instance, **kwargs):
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    import asyncio

    asyncio.run(coordinator.start_due_attempts(Instance(), now=now))
    attempt = store.active_lease("a", RuntimeMode.EXECUTE)
    assert attempt is not None
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id=attempt.attempt_id,
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
                lease_id=attempt.lease_id,
                fencing_token=attempt.fencing_token,
                verification_input={
                    "task_id": "a",
                    "execute_attempt_id": attempt.attempt_id,
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
            ).to_dict()
        ),
        encoding="utf-8",
    )

    assert coordinator.collect_result_files(Instance(), now=now) == 1
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_result_applied" in log_text
    assert f"attempt_id={attempt.attempt_id}" in log_text
    assert "node_id=a" in log_text
    assert "mode=execute" in log_text
    assert f"lease_id={attempt.lease_id}" in log_text
    assert f"result_path={result_path.with_suffix('.json.applied')}" in log_text


def test_pipeline_coordinator_logs_rejected_result_files(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            },
        )
    )
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    class Runtime:
        async def start(self, instance, **kwargs):
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    import asyncio

    asyncio.run(coordinator.start_due_attempts(Instance(), now=now))
    attempt = store.active_lease("a", RuntimeMode.EXECUTE)
    assert attempt is not None
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id=attempt.attempt_id,
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
                lease_id=attempt.lease_id,
                fencing_token="stale-token",
                verification_input={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    assert coordinator.collect_result_files(Instance(), now=now) == 0
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_result_rejected" in log_text
    assert "sanitized_reason=result_fencing_or_state_mismatch" in log_text
    assert result_path.exists()


def test_pipeline_coordinator_logs_verify_manifest_and_integration_events(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    snapshot = _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    store.update_node_state("a", GraphNodeState.VERIFYING)
    lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    result_path = Path(Instance.instance_dir) / "state" / "pipeline" / "verify-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
            VerifyAttemptResult(
                attempt_id="verify-1",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=snapshot.gate_snapshot_hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                score=3,
                passed=True,
                execute_attempt_id="exec-1",
            ).to_dict()
        ),
        encoding="utf-8",
    )

    assert coordinator.collect_result_files(Instance(), now=now) == 1

    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_result_applied" in log_text
    assert "event=pipeline_manifest_published" in log_text
    assert "event=pipeline_integration_queued" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "node_id=a" in log_text
    assert "mode=verify" in log_text
    assert f"lease_id={lease.lease_id}" in log_text
    assert "integration_id=integration-a-verify-1" in log_text


def test_pipeline_coordinator_logs_invalid_result_file(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / "attempt-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    result_path.write_text("{not-json", encoding="utf-8")
    log_path = tmp_path / "inst-1" / "logs" / "performer.log"

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")

    Instance.log_path = str(log_path)

    assert coordinator.collect_result_files(Instance()) == 0

    log_text = log_path.read_text(encoding="utf-8")
    assert "event=pipeline_result_file_invalid" in log_text
    assert "attempt_id=attempt-1" in log_text
    assert "result_path=" in log_text
