from test_conductor_service_support import *  # noqa: F401,F403

async def test_managed_background_projects_linear_phase_through_podium_proxy(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
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

    result = await service.coordinate_background_once()

    assert result["linear_phase_projections"] == 1
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/review", "state_name": "In Review"}
    ]

async def test_managed_phase_cycle_runs_without_conductor_linear_credentials_or_calls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    monkeypatch.setenv("LINEAR_API_KEY", "linear-secret-that-managed-mode-must-ignore")
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )

    dispatch = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
        }
    )
    background_before_result = await service.coordinate_background_once()
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
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))

    background_after_result = await service.coordinate_background_once()

    completed = service.store.get_orchestration_run(run.run_id)
    assert dispatch["status"] == "accepted"
    assert background_before_result["direct_dispatches_received"] == 0
    assert background_before_result["phase_human_actions_completed"] == 0
    assert background_after_result["phase_results_applied"] == 1
    assert completed is not None
    assert completed.phase is RunPhase.DONE
    assert completed.status == "completed"
    assert tracker.phase_projections
    assert runtime.env == {"PODIUM_PROXY_TOKEN": "proxy-token"}
    assert "LINEAR_API_KEY" not in (runtime.env or {})

async def test_dispatch_podium_event_passes_codex_profile_per_run_without_rewriting_workflow(tmp_path: Path) -> None:
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
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )

    workflow_before = Path(instance.workflow_path).read_text(encoding="utf-8")

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
            "codex_profile": {
                "model": "gpt-5-codex",
                "sandbox": "workspace_write",
                "config_overrides": [
                    "model_provider=openai",
                    "model_providers.openai.api_key=$OPENAI_API_KEY",
                ],
            },
        }
    )
    updated = service.store.get_instance(instance.id)
    assert runtime.advance_request_path is not None
    request_payload = json.loads(Path(runtime.advance_request_path).read_text(encoding="utf-8"))

    assert result["status"] == "accepted"
    assert updated is not None
    assert "codex_profile" not in updated.workflow_inputs
    assert request_payload["codex_profile"]["model"] == "gpt-5-codex"
    assert request_payload["codex_profile"]["sandbox"] == "workspace_write"
    assert request_payload["codex_profile"]["config_overrides"] == [
        "model_provider=openai",
        "model_providers.openai.api_key=$OPENAI_API_KEY",
    ]
    workflow_content = Path(updated.workflow_path).read_text(encoding="utf-8")
    assert workflow_content == workflow_before
    assert "model: gpt-5-codex" not in workflow_content
    assert "sandbox: workspace_write" not in workflow_content
    assert "sk-" not in workflow_content
    assert "$LINEAR_API_KEY" not in instance.workflow_content
    assert "linear-secret-that-managed-mode-must-ignore" not in instance.workflow_content

async def test_background_requeues_phase_run_after_result_retry_without_persistence(tmp_path: Path) -> None:
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
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert runtime.phase_result_path is not None
    Path(runtime.phase_result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.QUEUED,
                status="upstream_overloaded",
                reason="temporary failure",
                retry_delay_seconds=0,
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))

    first = await service.coordinate_background_once()
    delayed = service.store.get_orchestration_run(run.run_id)
    assert delayed is not None
    assert delayed.next_run_at is not None
    service.store.update_orchestration_run(run.run_id, next_run_at="1970-01-01T00:00:00Z")
    second = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)

    assert first["phase_results_applied"] == 1
    assert second["phase_runs_started"] == 1
    assert runtime.started_phase_issue_ids == ["issue-1", "issue-1"]
    assert updated is not None
    assert updated.attempt == 2

async def test_background_records_phase_crash_without_performer_persistence(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=1))

    result = await service.coordinate_background_once()
    crashed = service.store.get_orchestration_run(run.run_id)

    assert result["phase_crash_retries"] == 1
    assert crashed is not None
    assert crashed.phase is RunPhase.QUEUED
    assert crashed.status == "queued"
    assert crashed.crash_count == 1
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase process exited" in tracker.comments[0][1]
    assert "crash_count: 1" in tracker.comments[0][1]

async def test_background_does_not_record_phase_crash_when_result_file_exists(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert run.result_path is not None
    Path(run.result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.QUEUED,
                status="upstream_overloaded",
                reason="upstream_overloaded_exhausted",
                detail="upstream 502: server overloaded raw body",
                http_status=502,
                retry_delay_seconds=5,
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=1))

    result = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)

    assert result["phase_results_applied"] == 1
    assert result["phase_crash_retries"] == 0
    assert updated is not None
    assert updated.retry_count == 0
    assert updated.crash_count == 0
    assert updated.overload_count == 1
    assert "performer.upstream_overloaded" in [event.event_type for event in events]
    assert "linear.diagnostic_commented" in [event.event_type for event in events]
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase reported upstream_overloaded" in tracker.comments[0][1]
    assert "reason: upstream_overloaded_exhausted" in tracker.comments[0][1]
    assert "detail: upstream 502: server overloaded raw body" in tracker.comments[0][1]
    assert "http_status: 502" in tracker.comments[0][1]
    assert "overload_count: 1" in tracker.comments[0][1]

async def test_managed_background_does_not_resume_from_performer_persistence_without_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.store.update_instance(instance.with_updates(process_status="running", pid=4242))
    runtime.refreshed_instance = instance.with_updates(process_status="exited", pid=None, last_exit_code=0)
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="legacy retry",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()

    assert "resumed" not in result.to_dict()
    assert runtime.started_phase_issue_ids == []

async def test_direct_background_resumes_done_human_action_child_from_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="runtime error needs review",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "kind": "runtime_error",
            },
        )
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1",
            "description": "Human response:\nFixed the Codex state directory.\n\nWhen finished, move this child issue to Done.",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
            "url": "https://linear.test/ENG-2",
        }
    )

    result = await service.coordinate_background_once()

    updated = service.store.get_orchestration_run(run.run_id)
    assert result["phase_human_actions_completed"] == 1
    assert result["phase_runs_started"] == 1
    assert updated is not None
    assert updated.phase is RunPhase.IMPLEMENTING
    assert updated.human_response == "Fixed the Codex state directory."
    assert runtime.started_phase_issue_ids == ["issue-1"]
    assert runtime.advance_request_path is not None

async def test_background_creates_human_action_child_for_failed_upstream_overload(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.FAILED,
            status="failed",
            reason="upstream_overloaded_exhausted",
            detail="JSON-RPC error -32000: upstream 502: server overloaded raw body",
            http_status=502,
        )
    )

    result = await service.coordinate_background_once()

    assert result["phase_failure_human_actions_created"] == 1
    assert len(tracker.children) == 1
    child = tracker.children[0]
    assert child["title"] == "[Human Action] ENG-1: Runtime error needs review"
    assert child["labels"] == ["performer:type/human-action"]
    assert "Upstream HTTP status: 502" in child["description"]
    assert "Last error:\nJSON-RPC error -32000: upstream 502: server overloaded raw body" in child["description"]
    updated = service.store.get_orchestration_run(run.run_id)
    assert updated is not None
    assert updated.human_action["child_issue_id"] == child["id"]
    assert updated.phase is RunPhase.FAILED

async def test_background_remediates_orchestration_projection_drift(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    with service.store.connect() as connection:
        connection.execute("UPDATE orchestration_runs SET phase = ? WHERE run_id = ?", (RunPhase.FAILED.value, run.run_id))

    result = await service.coordinate_background_once()

    repaired = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)
    assert result["remediations"]["repaired"] == 1
    assert repaired is not None
    assert repaired.phase is RunPhase.QUEUED
    assert any(event.event_type == "remediation.projection_rebuilt" for event in events)

async def test_direct_background_dispatches_new_work_from_poll_into_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    tracker.candidate_issues.append(
        {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Build the direct mode task",
            "state": "Todo",
        }
    )

    result = await service.coordinate_background_once()

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert result["direct_dispatches_received"] == 1
    assert result["phase_runs_started"] == 1
    assert run is not None
    assert run.phase is RunPhase.IMPLEMENTING
    assert runtime.started_phase_issue_ids == ["issue-1"]

async def test_direct_background_does_not_dispatch_system_child_issues_from_poll(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"active_states": ["Todo", "In Progress"]},
        )
    )
    tracker.candidate_issues.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1: Runtime error needs review",
            "state": "Todo",
            "labels": ["performer:type/human-action"],
        }
    )

    result = await service.coordinate_background_once()

    run = service.store.get_orchestration_run_by_issue(instance.id, "child-1")
    assert result["direct_dispatches_received"] == 0
    assert result["phase_runs_started"] == 0
    assert run is None
    assert runtime.started_phase_issue_ids == []

async def test_direct_default_tracker_fetches_candidate_issues_from_linear_proxy(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.example",
            podium_proxy_token="proxy-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    transport = RecordingConductorLinearTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-1",
                                "identifier": "ENG-1",
                                "title": "Build the direct task",
                                "description": "Do it",
                                "url": "https://linear.test/ENG-1",
                                "state": {"name": "Todo", "type": "started"},
                                "delegate": {"id": "app-user-1"},
                                "labels": {"nodes": [{"name": "performer:phase/queued"}]},
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    tracker = service._repository_handoff_tracker(instance, transport=transport)

    issues = await tracker.fetch_candidate_issues()

    assert issues == [
        {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Build the direct task",
            "description": "Do it",
            "url": "https://linear.test/ENG-1",
            "state": "Todo",
            "state_type": "started",
            "delegate_id": "app-user-1",
            "parent_issue_id": None,
            "parent_identifier": None,
            "blocked_by": [],
            "labels": ["performer:phase/queued"],
        }
    ]
    request = transport.requests[0]
    assert request["url"] == "https://podium.example/api/v1/linear/graphql"
    assert request["headers"]["authorization"] == "proxy-token"
    variables = request["json"]["variables"]
    assert variables["projectSlug"] == "ENG"
    assert variables["stateNames"] == ["Todo", "In Progress"]
    assert variables["delegateId"] == "app-user-1"
    assert "$delegateId: ID" in request["json"]["query"]
    assert "delegate: { id: { eq: $delegateId } }" in request["json"]["query"]
