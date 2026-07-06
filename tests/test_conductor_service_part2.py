from test_conductor_service_support import *  # noqa: F401,F403

def test_create_instance_from_local_path_generates_valid_workflow(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    data_root = repo / ".custom-conductor-data"
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    (repo / "src.txt").write_text("source\n", encoding="utf-8")
    (data_root / "must-not-copy.txt").write_text("no\n", encoding="utf-8")
    for excluded in [".conductor", "conductor-data", ".venv", "workspaces", ".codex-runtime", ".test-real-flow"]:
        (repo / excluded).mkdir()
        (repo / excluded / "excluded.txt").write_text("no\n", encoding="utf-8")

    instance = service.create_instance(make_request(repo))

    assert instance.repo_source_type == "local_path"
    assert instance.resolved_repo_path == str(repo.resolve())
    assert instance.workspace_root == str((Path(instance.instance_dir) / "workspace" / "repo").resolve())
    assert instance.workflow_generation_status == "valid"
    assert Path(instance.workflow_path).exists()
    assert Path(instance.log_path).parent.exists()
    assert (Path(instance.workspace_root) / "src.txt").read_text(encoding="utf-8") == "source\n"
    assert (Path(instance.workspace_root) / ".git").exists()
    for excluded in [".conductor", "conductor-data", ".venv", "workspaces", ".codex-runtime", ".test-real-flow"]:
        assert not (Path(instance.workspace_root) / excluded).exists()
    assert not (Path(instance.workspace_root) / ".custom-conductor-data").exists()
    assert "Handle tasks" in instance.workflow_content

def test_create_instance_uses_configured_podium_proxy_endpoint(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(podium_url="https://podium.internal/"))

    instance = service.create_instance(make_request(repo))

    assert "endpoint: https://podium.internal/api/v1/linear/graphql" in instance.workflow_content
    assert "api_key: $PODIUM_PROXY_TOKEN" in instance.workflow_content

def test_create_instance_uses_podium_proxy_even_without_proxy_token_configured(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            podium_url="http://127.0.0.1:8090",
        )
    )

    instance = service.create_instance(make_request(repo))

    assert "endpoint: http://127.0.0.1:8090/api/v1/linear/graphql" in instance.workflow_content
    assert "api_key: $PODIUM_PROXY_TOKEN" in instance.workflow_content
    assert "$LINEAR_API_KEY" not in instance.workflow_content

def test_create_instance_reuses_existing_workspace_without_resyncing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")

    instance = service.create_instance(
        make_request(repo).with_overrides(
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"
    assert not (workspace_root / "README.md").exists()

def test_create_instance_clones_git_source_only_when_workspace_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        target = Path(command[-1])
        target.mkdir(parents=True, exist_ok=True)
        (target / ".git").mkdir()
        (target / "README.md").write_text("cloned\n", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        )
    )

    assert instance.resolved_repo_path == "https://example.com/acme/repo.git"
    assert calls == [["git", "clone", "--", "https://example.com/acme/repo.git", instance.workspace_root]]
    assert (Path(instance.workspace_root) / "README.md").read_text(encoding="utf-8") == "cloned\n"

def test_create_instance_reuses_non_empty_git_workspace_without_cloning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert calls == []
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"

def test_instance_runtime_includes_persisted_performer_issue_details(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    store = PersistenceStore(Path(instance.persistence_path))
    started_at = utc_now() - timedelta(seconds=9)
    store.save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url="https://linear.app/x/issue/ENG-1",
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=started_at,
                    last_event="notification",
                    last_message="working",
                    last_raw_message="item/agentMessage/delta",
                    phase="running",
                    status_label="performer:phase/implementation",
                    workspace_path=str(Path(instance.workspace_root) / "ENG-1"),
                    recent_events=[
                        {
                            "at": "2026-06-30T00:00:00Z",
                            "event": "notification",
                            "message": "working",
                            "raw_method": "item/agentMessage/delta",
                            "raw_event": {
                                "event": "notification",
                                "raw_method": "item/agentMessage/delta",
                                "payload": {"delta": "working"},
                            },
                        }
                    ],
                    turn_count=3,
                    tokens=RuntimeTokens(input_tokens=20, output_tokens=8, cached_tokens=5, total_tokens=33),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url="https://linear.app/x/issue/ENG-2",
                    phase="retrying",
                    status_label="performer:phase/implementation",
                )
            ],
            continuations=[
                ContinuationEntry(
                    issue_id="issue-3",
                    identifier="ENG-3",
                    attempt=3,
                    due_at=utc_now() + timedelta(seconds=90),
                    due_at_ms=234567,
                    issue_url="https://linear.app/x/issue/ENG-3",
                    last_message="continuing",
                )
            ],
            blocked=[
                BlockedEntry(
                    issue_id="issue-4",
                    identifier="ENG-4",
                    attempt=4,
                    blocked_at=utc_now(),
                    error="runtime_permission_blocked: writing outside of the project",
                    issue_url="https://linear.app/x/issue/ENG-4",
                )
            ],
            human_interventions=[
                HumanInterventionEntry(
                    issue_id="issue-5",
                    identifier="ENG-5",
                    child_issue_id="issue-5h",
                    child_identifier="ENG-H1",
                    child_url="https://linear.app/x/issue/ENG-H1",
                    kind="runtime_permission",
                    attempt=5,
                    created_at=utc_now(),
                    error="runtime_permission_blocked: approval required",
                    issue_url="https://linear.app/x/issue/ENG-5",
                )
            ],
        )
    )

    runtime = service.instance_runtime(instance.id)

    assert runtime["workspace"]["root"] == instance.workspace_root
    assert runtime["workspace"]["strategy"] == "instance_repo_workspace"
    assert "reuses the prepared repository workspace" in runtime["workspace"]["description"]
    assert runtime["performer"]["source"] == "persistence"
    assert runtime["performer"]["counts"] == {
        "running": 1,
        "retrying": 1,
        "continuing": 1,
        "blocked": 1,
        "pending_human": 1,
    }
    assert runtime["performer"]["running"][0]["issue_identifier"] == "ENG-1"
    assert runtime["performer"]["running"][0]["phase"] == "running"
    assert runtime["performer"]["running"][0]["status_label"] == "performer:phase/implementation"
    assert "thread_id" not in runtime["performer"]["running"][0]
    assert runtime["performer"]["running"][0]["turn_count"] == 3
    assert runtime["performer"]["running"][0]["tokens"]["cached_tokens"] == 5
    assert runtime["performer"]["running"][0]["tokens"]["total_tokens"] == 33
    assert runtime["performer"]["running"][0]["recent_events"][0]["raw_event"]["payload"]["delta"] == "working"
    assert runtime["performer"]["retrying"][0]["issue_identifier"] == "ENG-2"
    assert runtime["performer"]["retrying"][0]["error"] == "worker exited: boom"
    assert runtime["performer"]["continuing"][0]["issue_identifier"] == "ENG-3"
    assert runtime["performer"]["continuing"][0]["phase"] == "continuing"
    assert runtime["performer"]["continuing"][0]["status_label"] == "performer:phase/implementation"
    assert runtime["performer"]["blocked"][0]["issue_identifier"] == "ENG-4"
    assert runtime["performer"]["blocked"][0]["phase"] == "error"
    assert runtime["performer"]["blocked"][0]["status_label"] == "performer:phase/blocked"
    assert runtime["performer"]["human_interventions"][0]["issue_identifier"] == "ENG-5"
    assert runtime["performer"]["human_interventions"][0]["child_identifier"] == "ENG-H1"
    assert runtime["performer"]["human_interventions"][0]["child_url"] == "https://linear.app/x/issue/ENG-H1"
    assert runtime["metrics"]["tokens"]["cached_tokens"] == 5
    assert runtime["metrics"]["tokens"]["total_tokens"] == 33
    assert runtime["metrics"]["turns"] == 3
    assert runtime["metrics"]["retrying"] == 1
    assert runtime["metrics"]["blocked"] == 1
    assert runtime["metrics"]["pending_human"] == 1

def test_instance_runtime_includes_conductor_phase_runs_without_persistence(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.AWAITING_HUMAN,
        status="waiting",
        human_action={"child_issue_id": "child-1", "child_identifier": "ENG-2"},
    )

    runtime = service.instance_runtime(instance.id)

    assert runtime["performer"]["source"] == "conductor_phase"
    assert runtime["performer"]["counts"]["pending_human"] == 1
    assert runtime["performer"]["issues"][0]["phase"] == "awaiting_human"
    assert runtime["performer"]["issues"][0]["status"] == "waiting"
    assert runtime["performer"]["issues"][0]["human_action"]["child_identifier"] == "ENG-2"

def test_phase_runtime_recovers_from_conductor_events_when_performer_json_is_deleted(tmp_path: Path) -> None:
    service = make_service(tmp_path)
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
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    Path(instance.persistence_path).unlink(missing_ok=True)

    runtime = service.instance_runtime(instance.id)
    rebuilt = service.store.rebuild_run(run.run_id)

    assert rebuilt.phase is RunPhase.DONE
    assert runtime["performer"]["source"] == "conductor_phase"
    assert runtime["performer"]["completed"][0]["run_id"] == run.run_id
    assert runtime["performer"]["telemetry"]["source"] == "persistence"

def test_dashboard_aggregates_persisted_runtime_metrics(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url=None,
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=utc_now() - timedelta(seconds=20),
                    turn_count=2,
                    tokens=RuntimeTokens(input_tokens=30, output_tokens=12, total_tokens=42),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url=None,
                )
            ],
            continuations=[
                ContinuationEntry(
                    issue_id="issue-3",
                    identifier="ENG-3",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=234567,
                    issue_url=None,
                )
            ],
            human_interventions=[
                HumanInterventionEntry(
                    issue_id="issue-4",
                    identifier="ENG-4",
                    child_issue_id="issue-4h",
                    child_identifier="ENG-H1",
                    child_url=None,
                    kind="runtime_error",
                    attempt=1,
                    created_at=utc_now(),
                )
            ],
        )
    )

    dashboard = service.dashboard()

    assert dashboard["totals"]["tokens"] == 42
    assert dashboard["totals"]["runtime_seconds"] >= 19
    assert dashboard["totals"]["failures"] == 1
    assert dashboard["totals"]["retries"] == 1
    assert dashboard["totals"]["continuations"] == 1
    assert dashboard["totals"]["pending_human"] == 1

def test_dashboard_aggregates_phase_run_status_counts(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    waiting = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    failed = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.store.update_orchestration_run(waiting.run_id, phase=RunPhase.AWAITING_HUMAN, status="waiting")
    service.store.update_orchestration_run(failed.run_id, phase=RunPhase.FAILED, status="failed", retry_count=2)

    dashboard = service.dashboard()

    assert dashboard["totals"]["failures"] == 1
    assert dashboard["totals"]["retries"] == 2
    assert dashboard["totals"]["blocked"] == 1
    assert dashboard["totals"]["pending_human"] == 1

def test_query_instance_logs_returns_structured_query_result(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("line-1\nline-2\nline-3\n", encoding="utf-8")
    updated = instance.with_updates(log_path=str(current))
    service.store.update_instance(updated)

    result = service.query_instance_logs(instance.id, tail=2, order="desc")

    assert result["instance_id"] == instance.id
    assert result["generation"] == 1
    assert result["order"] == "desc"
    assert result["lines"] == ["line-3", "line-2"]
    assert result["logs"] == "line-3\nline-2\n"

def test_instance_logs_preserves_legacy_text_result(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("line-1\nline-2\n", encoding="utf-8")
    service.store.update_instance(instance.with_updates(log_path=str(current)))

    assert service.instance_logs(instance.id) == "line-1\nline-2\n"

def test_create_instance_rejects_duplicate_workspace_resources(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo_a = make_repo(tmp_path, "repo-a")
    repo_b = make_repo(tmp_path, "repo-b")
    first = service.create_instance(make_request(repo_a, name="Alpha", port=8801))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(
            make_request(repo_b, name="Beta", port=first.http_port).with_overrides(
                workspace_root=first.workspace_root
            )
        )

    assert exc.value.code == "resource_collision"

def test_create_instance_rejects_same_local_repo_binding(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo, name="Alpha"))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(make_request(repo, name="Beta"))

    assert exc.value.code == "resource_collision"

def test_create_instance_rejects_duplicate_name(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo_a = make_repo(tmp_path, "repo-a")
    repo_b = make_repo(tmp_path, "repo-b")
    service.create_instance(make_request(repo_a, name="Alpha"))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(make_request(repo_b, name="Alpha"))

    assert exc.value.code == "resource_collision"
    assert any("name collides" in diag for diag in exc.value.diagnostics)

async def test_sync_instance_project_labels_merges_managed_namespace(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(existing=["team-owned", "symphony:performer/old"])
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha").with_overrides(workflow_profile="task"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "synced"
    # User label preserved; stale managed label dropped; new managed labels added.
    assert "team-owned" in proxy.labels
    assert "symphony:performer/Alpha" in proxy.labels
    assert "symphony:profile/task" in proxy.labels
    assert "symphony:performer/old" not in proxy.labels

async def test_sync_instance_project_labels_noop_when_unchanged(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(
        existing=["symphony:performer/Alpha", "symphony:profile/task", "keep"]
    )
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha").with_overrides(workflow_profile="task"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "unchanged"
    assert proxy.set_calls == []

async def test_sync_project_labels_once_debounces_after_first_sync(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(existing=[])
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo, name="Alpha"))

    first = await service.sync_project_labels_once()
    second = await service.sync_project_labels_once()

    assert first == 1
    assert second == 0
    assert len(proxy.set_calls) == 1

async def test_sync_instance_project_labels_skips_without_proxy_token(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "skipped"
    assert result["reason"] == "proxy_not_configured"

async def test_managed_background_does_not_call_conductor_linear_proxy_factories(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            managed_mode=True,
            podium_proxy_token="proxy-token",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    OpsStore(Path(instance.persistence_path).parent / "ops.json").save(
        OpsSnapshot(
            events=[
                TraceEvent(
                    event_id="evt-managed-handoff",
                    event_type="repository_handoff_report.v1",
                    timestamp="2026-07-03T00:00:00Z",
                    issue_id="issue-1",
                    retention_tier="summary",
                    payload={
                        "issue_id": "issue-1",
                        "issue_identifier": "ENG-1",
                        "workspace_path": instance.workspace_root,
                    },
                )
            ]
        )
    )

    def fail_repository_proxy(instance):
        raise AssertionError("managed background must not create a Conductor Linear repository proxy")

    def fail_project_proxy(instance):
        raise AssertionError("managed background must not create a Conductor Linear project-label proxy")

    service.repository_handoff_tracker_factory = fail_repository_proxy
    service.project_label_proxy_factory = fail_project_proxy

    result = await service.coordinate_background_once()

    assert result["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 0}
    assert result["project_labels_synced"] == 0

async def test_direct_background_throttles_low_frequency_linear_work_between_ticks(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo))
    closeout_calls = 0
    project_label_calls = 0

    async def closeouts() -> dict[str, int]:
        nonlocal closeout_calls
        closeout_calls += 1
        return {"closed_out": 0, "failed": 0, "skipped": 0}

    async def project_labels() -> int:
        nonlocal project_label_calls
        project_label_calls += 1
        return 0

    service.coordinate_repository_handoff_closeouts = closeouts
    service.sync_project_labels_once = project_labels

    first = await service.coordinate_background_once()
    second = await service.coordinate_background_once()

    assert first["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 0}
    assert second["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 1}
    assert first["project_labels_synced"] == 0
    assert second["project_labels_synced"] == 0
    assert closeout_calls == 1
    assert project_label_calls == 1

def test_update_instance_revalidates_workflow_and_persists_raw_edits(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(
            workflow_content=instance.workflow_content.replace("Handle tasks", "Updated goal"),
        ),
    )

    assert updated.workflow_generation_status == "valid"
    assert "Updated goal" in Path(updated.workflow_path).read_text(encoding="utf-8")

def test_update_instance_persists_replaced_workflow_content_in_metadata(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    replacement = instance.workflow_content.replace(
        "https://podium.example/api/v1/linear/graphql",
        "http://127.0.0.1:9999/graphql",
    )

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(workflow_content=replacement),
    )

    stored = service.get_instance(instance.id)
    assert stored is not None
    assert "http://127.0.0.1:9999/graphql" in updated.workflow_content
    assert "http://127.0.0.1:9999/graphql" in stored.workflow_content
