from test_conductor_service_support import *  # noqa: F401,F403

async def test_direct_background_does_not_resume_required_human_action_without_response(tmp_path: Path) -> None:
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
            reason="need scope",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "kind": "preflight_needs_input",
            },
        )
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1",
            "description": "Human response:\n\n(Add the answer or decision here when information is required.)\n\nWhen finished, move this child issue to Done.",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
            "url": "https://linear.test/ENG-2",
        }
    )

    result = await service.coordinate_background_once()

    updated = service.store.get_orchestration_run(run.run_id)
    assert result["phase_human_actions_completed"] == 0
    assert result["phase_human_actions_missing_response"] == 1
    assert updated is not None
    assert updated.phase is RunPhase.AWAITING_HUMAN
    assert runtime.started_phase_issue_ids == []
    assert tracker.comments == [
        (
            "child-1",
            "This human action is marked Done, but the `Human response` section is empty. Add the response there, then keep this child issue in Done.",
        )
    ]

async def test_background_restarts_crashed_performer_with_pending_work(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.store.update_instance(instance.with_updates(process_status="running", pid=4242))
    runtime.refreshed_instance = instance.with_updates(process_status="exited", pid=None, last_exit_code=1)
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="worker crashed",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()
    restarted = service.store.get_instance(instance.id)

    assert result["crash_restarts"] == 1
    assert restarted is not None
    assert restarted.process_status == "running"
    assert restarted.restart_count == 1
    assert restarted.restart_window_started_at
    assert restarted.restart_next_at
    assert runtime.started_phase_issue_ids == ["issue-1"]

async def test_background_marks_crash_loop_after_repeated_crashes(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    crashed = instance.with_updates(
        process_status="exited",
        pid=None,
        last_exit_code=1,
        restart_count=3,
        restart_window_started_at=utc_now().isoformat().replace("+00:00", "Z"),
        restart_next_at=None,
    )
    service.store.update_instance(crashed)
    runtime.refreshed_instance = crashed
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="worker crashed",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()
    updated = service.store.get_instance(instance.id)

    assert result["crash_loops"] == 1
    assert updated is not None
    assert updated.process_status == "crash_loop"
    assert updated.restart_count == 4
    assert "crashed more than 3 times" in (updated.last_error or "")
    assert runtime.started_phase_issue_ids == []

async def test_dispatch_podium_event_skips_when_no_instance_matches_project(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))

    result = await service.dispatch_podium_event(
        {"issue_id": "issue-1", "issue_identifier": "OPS-1", "project_slug": "OPS", "agent_app_user_id": "app-user-1"}
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "OPS-1",
        "reason": "no_matching_instance",
    }
    assert runtime.phase_issue_id is None

async def test_dispatch_podium_event_requires_linear_agent_app_user(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {"issue_id": "issue-1", "issue_identifier": "ENG-1", "project_slug": "ENG", "agent_session_id": "session-1"}
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "reason": "missing_linear_agent_app_user",
    }
    assert runtime.phase_issue_id is None

async def test_dispatch_podium_event_skips_when_linear_agent_app_user_does_not_match_instance(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "other-app-user",
        }
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "reason": "no_matching_instance",
    }
    assert runtime.phase_issue_id is None
