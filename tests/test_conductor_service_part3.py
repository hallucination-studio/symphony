from test_conductor_service_support import *  # noqa: F401,F403

def test_update_instance_rejects_invalid_raw_workflow(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    with pytest.raises(ConductorServiceError) as exc:
        service.update_instance(instance.id, InstancePatchRequest(workflow_content="---\ntracker: [\n---"))

    assert exc.value.code == "workflow_parse_error"

def test_validate_workflow_returns_diagnostics_without_saving(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    result = service.validate_workflow(instance.id, "---\ntracker: [\n---")

    assert result.ok is False
    reloaded = service.get_instance(instance.id)
    assert reloaded is not None
    assert reloaded.workflow_generation_status == "valid"

def test_delete_instance_removes_record_when_stopped(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    service.delete_instance(instance.id)

    assert service.get_instance(instance.id) is None

def test_inspect_repo_reports_local_directory_context(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)

    result = service.inspect_repo("local_path", str(repo))

    assert result["exists"] is True
    assert result["git"] is True
    assert result["resolved_path"] == str(repo.resolve())
    assert "README.md" in result["files"]

def test_service_initialization_marks_stale_running_instances_stopped(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
        workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
        workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
        persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "performer.json"),
        log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
        workflow_profile="default",
        workflow_inputs={},
    ).with_updates(process_status="running", pid=999999)
    store.save_instance(instance)

    ConductorService(store=store, data_root=tmp_path / "conductor-data")

    reloaded = store.get_instance("inst-1")
    assert reloaded is not None
    assert reloaded.process_status == "stopped"
    assert reloaded.pid is None

async def test_service_initialization_recovers_live_running_instance_pid(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "performer"])
    try:
        instance = InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
            workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
            workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
            persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "performer-000001.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        ).with_updates(process_status="running", pid=process.pid)
        store.save_instance(instance)

        service = ConductorService(store=store, data_root=tmp_path / "conductor-data")

        reloaded = store.get_instance("inst-1")
        assert reloaded is not None
        assert reloaded.process_status == "running"
        assert reloaded.pid == process.pid
        stopped = await service.stop_instance("inst-1")
        assert stopped.process_status == "stopped"
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)

def test_service_initialization_rejects_reused_pid_with_non_performer_cmdline(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        instance = InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
            workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
            workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
            persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "performer-000001.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        ).with_updates(process_status="running", pid=process.pid)
        store.save_instance(instance)

        ConductorService(store=store, data_root=tmp_path / "conductor-data")

        reloaded = store.get_instance("inst-1")
        assert reloaded is not None
        assert reloaded.process_status == "stopped"
        assert reloaded.pid is None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)

async def test_start_instance_passes_podium_proxy_token_to_runtime_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    store = ConductorStore(tmp_path / "conductor-data")
    runtime = CapturingRuntime()
    service = ConductorService(store=store, data_root=tmp_path / "conductor-data", runtime_manager=runtime)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.example",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-token",
            podium_proxy_token="proxy-token",
            runtime_group_id="group-1",
        )
    )

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {
        "PODIUM_PROXY_TOKEN": "proxy-token",
        "PODIUM_RUNTIME_GROUP_ID": "group-1",
        "PODIUM_RUNTIME_ID": "runtime-1",
        "PODIUM_RUNTIME_TOKEN": "runtime-token",
    }

async def test_start_instance_does_not_require_conductor_linear_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {}

async def test_direct_start_instance_passes_linear_api_key_explicitly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False))
    monkeypatch.setenv("LINEAR_API_KEY", "direct-linear-token")
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {"LINEAR_API_KEY": "direct-linear-token"}

async def test_dispatch_podium_event_starts_one_shot_performer_for_matching_linear_agent_app_user(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(podium_proxy_token="proxy-token"))
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
            "assignee_id": "human-user-1",
        }
    )

    assert result == {
        "status": "accepted",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "instance_id": instance.id,
        "agent_session_id": "session-1",
        "agent_app_user_id": "app-user-1",
    }
    assert runtime.phase_issue_id == "issue-1"
    assert runtime.env == {"PODIUM_PROXY_TOKEN": "proxy-token"}
    assert runtime.advance_request_path is not None
    assert runtime.phase_result_path is not None
    request_payload = json.loads(Path(runtime.advance_request_path).read_text(encoding="utf-8"))
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert run.phase is RunPhase.IMPLEMENTING
    assert run.status == "running"
    assert run.request_path == runtime.advance_request_path
    assert run.result_path == runtime.phase_result_path
    assert request_payload["run_id"] == run.run_id
    assert request_payload["current_phase"] == "queued"
    assert request_payload["workspace_context"]["workspace_root"] == instance.workspace_root

async def test_podium_ws_dispatch_available_queues_until_scheduler_tick(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1"},
        )
    )

    queued = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "dispatch": {
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "project_slug": "ENG",
                "agent_session_id": "session-1",
                "agent_app_user_id": "app-user-1",
            },
        }
    )

    run_before_tick = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert queued["status"] == "queued"
    assert run_before_tick is None
    assert runtime.started_phase_issue_ids == []

    tick = await service.coordinate_background_once()
    run_after_tick = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")

    assert tick["phase_runs_started"] == 1
    assert run_after_tick is not None
    assert run_after_tick.phase is RunPhase.IMPLEMENTING
    assert runtime.started_phase_issue_ids == ["issue-1"]

async def test_dispatch_podium_event_keeps_blocked_run_queued_at_scheduler_gate(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-2",
            "issue_identifier": "ENG-2",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
            "blocked_by": [{"id": "issue-1", "identifier": "ENG-1", "state": "In Progress"}],
            "parent_issue_id": "parent-1",
        }
    )

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-2")
    assert result["status"] == "accepted"
    assert run is not None
    assert run.phase is RunPhase.QUEUED
    assert run.blocked_by == ["issue-1"]
    assert run.parent_issue_id == "parent-1"
    assert runtime.started_phase_issue_ids == []

async def test_dispatch_podium_event_accepts_project_bound_instance_without_agent_filter(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"active_states": ["Todo", "In Progress"]})
    )

    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-1",
            "fencing_token": 7,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
            "instance_id": instance.id,
        }
    )

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert result["status"] == "accepted"
    assert run is not None
    assert runtime.started_phase_issue_ids == ["issue-1"]

async def test_dispatch_podium_event_leaves_new_run_queued_when_instance_is_busy(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    first = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    second = await service.dispatch_podium_event(
        {
            "issue_id": "issue-2",
            "issue_identifier": "ENG-2",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )

    assert first["status"] == "accepted"
    assert second["status"] == "accepted"
    assert runtime.started_phase_issue_ids == ["issue-1"]
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-2")
    assert run is not None
    assert run.phase is RunPhase.QUEUED
    assert run.status == "queued"

async def test_dispatch_podium_event_does_not_restart_retry_before_next_run_at(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.QUEUED,
        status="queued",
        retry_count=1,
        next_run_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
    )

    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-2",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )

    assert result["status"] == "accepted"
    assert runtime.started_phase_issue_ids == []
    updated = service.store.get_orchestration_run(run.run_id)
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.dispatch_id == "dispatch-2"

async def test_completed_phase_result_file_drives_podium_ack_without_performer_persistence(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-1",
            "fencing_token": 7,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    assert result["status"] == "accepted"
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert runtime.phase_result_path is not None
    Path(runtime.phase_result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
                workspace_path=str(Path(instance.workspace_root) / "ENG-1"),
                ops_snapshot_path=str(Path(instance.persistence_path).parent / "ops.json"),
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    captured: dict[str, object] = {}

    def handler(request):
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"dispatch": {"status": "completed"}})

    ack = await service.ack_completed_podium_dispatches(transport=httpx.MockTransport(handler))
    completed = service.store.get_orchestration_run(run.run_id)

    assert ack == {"acked": 1, "failed": 0, "skipped": 0}
    assert completed is not None
    assert completed.phase is RunPhase.DONE
    assert completed.status == "completed"
    assert completed.ack_status == "acked"
    assert captured["body"] == {
        "dispatch_id": "dispatch-1",
        "status": "completed",
        "reason": "completed_by_runtime",
        "runtime_phase": "done",
        "fencing_token": 7,
    }

async def test_background_projects_linear_phase_from_conductor_run_events(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
            reason="implementation_ready_for_review",
        )
    )

    first = await service.coordinate_background_once()
    second = await service.coordinate_background_once()
    events = service.store.list_orchestration_events(run.run_id)

    assert first["linear_phase_projections"] == 1
    assert second["linear_phase_projections"] == 0
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/review", "state_name": "In Review"}
    ]
    assert "linear.projected_review_state" in [event.event_type for event in events]

async def test_background_replays_linear_phase_projection_when_linear_drifts(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    await service.coordinate_background_once()
    tracker.drifted_phase_issues.add("issue-1")

    result = await service.coordinate_background_once()

    assert result["linear_phase_projections"] == 1
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/done", "state_name": "Done"},
        {"issue_id": "issue-1", "phase_label": "performer:phase/done", "state_name": "Done"},
    ]

async def test_linear_phase_projection_failures_back_off_and_escalate(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FailingProjectionTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )

    first = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:00Z")
    skipped = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:10Z")
    second = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:31Z")
    third = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:01:32Z")
    escalated = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:03:33Z")

    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)
    failed_events = [event for event in events if event.event_type == "linear.phase_projection_failed"]
    assert [first, skipped, second, third, escalated] == [0, 0, 0, 0, 0]
    assert tracker.project_attempts == 4
    assert [event.payload["failure_count"] for event in failed_events] == [1, 2, 3]
    assert failed_events[0].payload["next_run_at"] == "2026-07-05T00:00:30Z"
    assert failed_events[1].payload["next_run_at"] == "2026-07-05T00:01:31Z"
    assert failed_events[2].payload["next_run_at"] == "2026-07-05T00:03:32Z"
    assert updated is not None
    assert updated.phase is RunPhase.FAILED
    assert updated.ack_status == "pending"
    assert events[-1].event_type == "linear.phase_projection_escalated"
