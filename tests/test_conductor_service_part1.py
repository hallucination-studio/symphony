from test_conductor_service_support import *  # noqa: F401,F403

def test_direct_linear_proxy_classes_are_not_defined_in_conductor_service() -> None:
    import conductor.conductor_service as conductor_service_module

    source = inspect.getsource(conductor_service_module)

    assert "class RepositoryHandoffLinearProxy" not in source
    assert "class ProjectLabelLinearProxy" not in source
    assert RepositoryHandoffLinearProxy.__module__ == "conductor.conductor_linear_direct"
    assert ProjectLabelLinearProxy.__module__ == "conductor.conductor_linear_direct"

def test_conductor_service_constructs_long_lived_collaborators(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    assert service.scheduler is service.scheduler
    assert service.linear_projector is service.linear_projector
    assert service.direct_ingress is service.direct_ingress
    assert service.performer_supervisor is service.performer_supervisor
    assert service.phase_human_actions is service.phase_human_actions
    assert service.orchestration_remediator is service.orchestration_remediator

async def test_repository_handoff_proxy_returns_dependency_metadata_from_linear_candidates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-2",
                                "identifier": "ENG-2",
                                "title": "Blocked child",
                                "description": "",
                                "url": "https://linear.test/ENG-2",
                                "state": {"name": "Todo", "type": "unstarted"},
                                "parent": {"id": "parent-1", "identifier": "ENG-0"},
                                "delegate": {"id": "app-user-1"},
                                "labels": {"nodes": [{"name": "codex"}]},
                                "inverseRelations": {
                                    "nodes": [
                                        {
                                            "type": "blocks",
                                            "issue": {
                                                "id": "issue-1",
                                                "identifier": "ENG-1",
                                                "state": {"name": "In Progress"},
                                            },
                                        }
                                    ]
                                },
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    proxy = RepositoryHandoffLinearProxy(
        endpoint="https://linear.test/graphql",
        api_key="linear-token",
        project_slug="ENG",
        transport=httpx.MockTransport(handler),
    )

    issues = await proxy.fetch_candidate_issues()

    assert issues[0]["parent_issue_id"] == "parent-1"
    assert issues[0]["blocked_by"] == [
        {"id": "issue-1", "identifier": "ENG-1", "state": "In Progress"}
    ]

async def test_repository_handoff_proxy_uses_partial_success_data() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-2",
                                "identifier": "ENG-2",
                                "title": "Child",
                                "state": {"name": "Todo"},
                                "labels": {"nodes": []},
                                "inverseRelations": {"nodes": []},
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                },
                "errors": [{"message": "optional relation field failed"}],
            },
        )

    proxy = RepositoryHandoffLinearProxy(
        endpoint="https://linear.test/graphql",
        api_key="linear-token",
        project_slug="ENG",
        transport=httpx.MockTransport(handler),
    )

    issues = await proxy.fetch_candidate_issues()

    assert [issue["identifier"] for issue in issues] == ["ENG-2"]

def test_conductor_service_lists_issue_run_trace_and_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    Path(instance.workflow_path).write_text(
        "config:\n  codex:\n    hard_turn_timeout_ms: 1\n    read_timeout_ms: 0\n",
        encoding="utf-8",
    )
    write_sample_ops_snapshot(instance)

    issues = service.list_issues()
    runs = service.list_runs()
    traces = service.list_trace_events(issue_id="issue-1", run_id=None)
    retention = service.retention_status()

    assert issues[0]["issue_identifier"] == "ENG-1"
    assert issues[0]["instance_id"] == instance.id
    assert "no Codex output" in service.get_issue("issue-1")["state_explanation"]
    assert runs[0]["turn_count"] == 7
    assert service.get_run("run-1")["run"]["run_id"] == "run-1"
    assert traces[0]["event_type"] == "issue_dispatched"
    assert retention["pinned_issue_count"] == 0

def test_list_runs_uses_conductor_phase_rows_with_ops_enrichment(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    phase_run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        phase_run.run_id,
        phase=RunPhase.DONE,
        status="completed",
        workspace_path="/tmp/workspace/ENG-1",
        ops_snapshot_path=str(Path(instance.persistence_path).parent / "ops.json"),
        last_reason="completed_by_runtime",
        ack_status="acked",
    )
    write_sample_ops_snapshot(instance)

    runs = service.list_runs()
    detail = service.get_run(phase_run.run_id)

    assert runs == [
        {
            "run_id": phase_run.run_id,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "instance_id": instance.id,
            "phase": "done",
            "status": "completed",
            "attempt": 1,
            "workflow_profile": "default",
            "dispatch_id": "dispatch-1",
            "workspace_path": "/tmp/workspace/ENG-1",
            "ops_snapshot_path": str(Path(instance.persistence_path).parent / "ops.json"),
            "human_action": {},
            "human_response": None,
            "last_reason": "completed_by_runtime",
            "last_error": None,
            "process_pid": None,
            "ack_status": "acked",
            "retry_count": 0,
            "crash_count": 0,
            "init_failure_count": 0,
            "overload_count": 0,
            "next_run_at": None,
            "turn_count": 7,
            "total_tokens": 188240,
            "estimated_cost_usd": 0.97,
            "last_activity_at": "2026-06-30T00:10:00Z",
        }
    ]
    assert detail["run"]["run_id"] == phase_run.run_id
    assert detail["run"]["phase"] == "done"
    assert detail["run"]["init_failure_count"] == 0
    assert detail["telemetry"]["run"]["run_id"] == "run-1"

def test_list_runs_exposes_human_action_metadata_from_phase_rows(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    phase_run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        phase_run.run_id,
        phase=RunPhase.AWAITING_HUMAN,
        status="waiting",
        human_action={
            "child_issue_id": "child-1",
            "child_identifier": "ENG-2",
            "child_url": "https://linear.test/ENG-2",
            "kind": "runtime_error",
        },
    )

    runs = service.list_runs()

    assert runs[0]["phase"] == "awaiting_human"
    assert runs[0]["human_action"] == {
        "child_issue_id": "child-1",
        "child_identifier": "ENG-2",
        "child_url": "https://linear.test/ENG-2",
        "kind": "runtime_error",
    }

async def test_coordinate_background_times_out_hung_phase_process_as_retry(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service.runtime_manager = runtime
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    instance = await service._start_direct_phase_issue(
        instance,
        issue_id="issue-1",
        issue_identifier="ENG-1",
    )
    service.store.update_instance(instance)
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    with service.store.connect() as connection:
        connection.execute(
            """
            UPDATE orchestration_events
            SET created_at = CASE event_type
              WHEN 'dispatch.created' THEN '2026-07-04T00:00:00Z'
              WHEN 'performer.started' THEN '2026-07-04T00:00:01Z'
              ELSE created_at
            END
            WHERE run_id = ?
            """,
            (run.run_id,),
        )

    result = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)

    assert result["phase_timeouts"] == 1
    assert result["remediations"]["escalated"] == 0
    assert result["phase_failure_human_actions_created"] == 0
    assert runtime.stop_calls == [instance.id]
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.status == "queued"
    assert updated.retry_count == 1
    assert updated.crash_count == 0
    assert updated.overload_count == 0
    assert updated.init_failure_count == 0
    assert updated.last_reason == "turn_timeout"
    result_event = next(event for event in events if event.event_type == "performer.result")
    assert result_event.payload["status"] == "retry"
    assert result_event.payload["reason"] == "turn_timeout"
    assert "linear.diagnostic_commented" in [event.event_type for event in events]
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase timed out" in tracker.comments[0][1]
    assert "retry_count: 1" in tracker.comments[0][1]
    assert "crash_count: 0" in tracker.comments[0][1]

async def test_coordinate_background_returns_structured_result_without_legacy_resumed_field(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    result = await service.coordinate_background_once()

    assert isinstance(result, CoordinationResult)
    assert result["phase_runs_started"] == result.phase_runs_started
    assert result["dispatchable"] == 0
    assert result["blocked_waiting"] == 0
    assert "resumed" not in result.to_dict()
    with pytest.raises(KeyError):
        _ = result["resumed"]

async def test_coordinate_background_reports_dependency_readiness_breakdown(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-ready",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=["missing-blocker"],
    )

    result = await service.coordinate_background_once()

    assert result["dispatchable"] == 0
    assert result["blocked_waiting"] == 1
    assert result["phase_runs_started"] == 1

async def test_managed_background_fails_fast_when_proxy_token_missing_for_linear_projection(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(managed_mode=True))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
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

    with pytest.raises(ConductorServiceError) as exc:
        await service.coordinate_background_once()

    assert exc.value.code == "managed_podium_proxy_token_required"

async def test_repository_handoff_closeout_creates_child_once_and_updates_on_rerun(tmp_path: Path) -> None:
    tracker = FakeRepositoryHandoffTracker()
    service = make_service(tmp_path)
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_filters={
                "linear_agent_app_user_id": "app-user-1",
                "integration_agent_mention": "@integration-agent",
            }
        )
    )
    ops_store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
    ops_store.save(
        OpsSnapshot(
            events=[
                TraceEvent(
                    event_id="evt-1",
                    event_type="repository_handoff_report.v1",
                    timestamp="2026-07-03T00:00:00Z",
                    issue_id="issue-1",
                    retention_tier="summary",
                    payload={
                        "issue_id": "issue-1",
                        "issue_identifier": "ENG-1",
                        "workspace_path": instance.workspace_root,
                        "structured_result": {
                            "implementation_summary": "Changed README",
                            "test_commands_and_exact_output": "pytest -q\n1 passed",
                            "remaining_risks": "none",
                        },
                        "git_snapshot": {
                            "is_git_repo": True,
                            "repo_root": instance.workspace_root,
                            "branch": "main",
                            "head_sha": "abc123",
                            "status_porcelain": " M README.md",
                            "diff_stat": "README.md | 2 +",
                            "changed_files": ["README.md"],
                        },
                        "artifact_manifest": [{"path": "changes.patch", "size": 12, "sha256": "abc"}],
                        "bundle": {
                            "type": "local_bundle",
                            "path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1"),
                            "changes_patch_path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1" / "changes.patch"),
                            "manifest_path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1" / "manifest.json"),
                        },
                        "recommended_next_action": "create_repository_integration_issue",
                        "generated_at": "2026-07-03T00:00:00Z",
                    },
                )
            ]
        )
    )

    first = await service.coordinate_repository_handoff_closeouts()
    second = await service.coordinate_repository_handoff_closeouts()

    assert first["closed_out"] == 1
    assert second["closed_out"] == 0
    assert len(tracker.children) == 1
    child = tracker.children[0]
    assert child["title"] == "Integrate ENG-1 implementation"
    assert child["delegate_id"] == "app-user-1"
    assert "performer:type/repository-integration" in child["labels"]
    assert "<!-- SYMPHONY REPOSITORY HANDOFF source_issue_id=issue-1 -->" in str(child["description"])
    assert "changes.patch" in str(child["description"])
    assert tracker.comments
    assert "@integration-agent" in tracker.comments[0][1]
    snapshot = ops_store.load()
    closeouts = [event for event in snapshot.events if event.event_type == "repository_handoff_closeout.v1"]
    assert len(closeouts) == 1
    assert closeouts[0].payload["status"] == "completed"
    assert closeouts[0].payload["child_issue_id"] == "child-1"

def test_get_instance_refreshes_exited_runtime_state(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    running = instance.with_updates(process_status="running", pid=4242)
    service.store.update_instance(running)
    runtime.refreshed_instance = running.with_updates(process_status="exited", pid=None, last_exit_code=0)

    refreshed = service.get_instance(instance.id)

    assert refreshed is not None
    assert refreshed.process_status == "exited"
    assert refreshed.pid is None
    assert refreshed.last_exit_code == 0
    assert service.store.get_instance(instance.id).process_status == "exited"

def test_service_startup_clears_orphaned_running_instance_and_run(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=CapturingRuntime(),
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(
        run.run_id,
        request_path="/tmp/request.json",
        result_path="/tmp/result.json",
        pid=999999,
    )
    store.update_instance(instance.with_updates(process_status="running", pid=999999))

    restarted = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=NonRecoveringRuntime(),
    )

    refreshed_instance = restarted.store.get_instance(instance.id)
    refreshed_run = restarted.store.get_orchestration_run(run.run_id)
    assert refreshed_instance is not None
    assert refreshed_instance.process_status == "stopped"
    assert refreshed_instance.pid is None
    assert refreshed_run is not None
    assert refreshed_run.phase is RunPhase.QUEUED
    assert refreshed_run.status == "queued"
    assert refreshed_run.process_pid is None
    assert refreshed_run.last_error == "orphaned performer process was not recoverable"

def test_service_startup_clears_only_runs_with_unrecoverable_pid(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=CapturingRuntime(),
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    orphaned = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    live = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-2",
    )
    service.phase_reducer.performer_started(
        orphaned.run_id,
        request_path="/tmp/request-1.json",
        result_path="/tmp/result-1.json",
        pid=1111,
    )
    service.phase_reducer.performer_started(
        live.run_id,
        request_path="/tmp/request-2.json",
        result_path="/tmp/result-2.json",
        pid=2222,
    )
    store.update_instance(instance.with_updates(process_status="running", pid=1111))

    ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=PidRecoveringRuntime({2222}),
    )

    orphaned_run = store.get_orchestration_run(orphaned.run_id)
    live_run = store.get_orchestration_run(live.run_id)
    assert orphaned_run is not None
    assert orphaned_run.phase is RunPhase.QUEUED
    assert orphaned_run.process_pid is None
    assert live_run is not None
    assert live_run.phase is RunPhase.IMPLEMENTING
    assert live_run.process_pid == 2222

async def test_phase_timeout_stops_only_matching_run_pid(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    Path(instance.workflow_path).write_text(
        "config:\n  codex:\n    hard_turn_timeout_ms: 1\n    read_timeout_ms: 0\n",
        encoding="utf-8",
    )
    instance = instance.with_updates(process_status="running", pid=2222)
    service.store.update_instance(instance)
    first = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    second = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-2",
    )
    service.phase_reducer.performer_started(
        first.run_id,
        request_path="/tmp/request-1.json",
        result_path="/tmp/result-1.json",
        pid=1111,
    )
    service.phase_reducer.performer_started(
        second.run_id,
        request_path="/tmp/request-2.json",
        result_path="/tmp/result-2.json",
        pid=2222,
    )
    old_started_at = "2026-07-04T00:00:01Z"
    with service.store.connect() as connection:
        connection.execute(
            "UPDATE orchestration_events SET created_at = ? WHERE run_id = ? AND event_type = 'performer.started'",
            (old_started_at, first.run_id),
        )
        connection.execute(
            "UPDATE orchestration_events SET created_at = ? WHERE run_id = ? AND event_type = 'performer.started'",
            (old_started_at, second.run_id),
        )

    timed_out = await service._record_phase_timeouts()

    assert timed_out == 1
    assert runtime.stopped_pids == [2222]
    refreshed_first = service.store.get_orchestration_run(first.run_id)
    refreshed_second = service.store.get_orchestration_run(second.run_id)
    assert refreshed_first is not None
    assert refreshed_first.phase is RunPhase.IMPLEMENTING
    assert refreshed_first.process_pid == 1111
    assert refreshed_second is not None
    assert refreshed_second.phase is RunPhase.QUEUED
    assert refreshed_second.process_pid is None

def test_phase_timeout_zero_codex_timeouts_keeps_conductor_stall_floor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=CapturingRuntime(),
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    class LoadedWorkflow:
        config = {"codex": {"turn_timeout_ms": 0, "hard_turn_timeout_ms": 0, "read_timeout_ms": 0}}

    monkeypatch.setattr("conductor.conductor_service.load_workflow", lambda path: LoadedWorkflow())

    timeout_seconds = service._phase_timeout_seconds(instance)

    assert timeout_seconds == 305

def test_conductor_service_pins_issue_and_collects_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    write_sample_ops_snapshot(instance)

    service.pin_issue("issue-1")
    retention = service.retention_status()
    service.collect_retention()

    assert retention["pinned_issue_count"] == 1
    assert "issue-1" in retention["pinned_issue_ids"]
    snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
    assert "issue-1" in snapshot.retention.pinned_issue_ids
