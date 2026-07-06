from test_cli_support import *  # noqa: F401,F403

def test_default_workflow_path_uses_cwd(tmp_path: Path) -> None:
    assert default_workflow_path(tmp_path) == tmp_path / "WORKFLOW.md"

def test_conductor_default_data_root_is_dot_performer() -> None:
    args = parse_conductor_args([])

    assert args.data_root == ".conductor"

def test_conductor_module_exposes_main_entrypoint() -> None:
    assert callable(conductor_cli.main)

def test_conductor_main_does_not_load_dotenv_from_launch_directory(tmp_path: Path, monkeypatch) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("LINEAR_API_KEY=linear-token\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)

    async def fake_run_server(**_kwargs) -> None:
        import os

        assert "LINEAR_API_KEY" not in os.environ

    monkeypatch.setattr(conductor_cli, "run_server", fake_run_server)

    assert conductor_cli.main([]) == 0

def test_parse_args_accepts_positional_workflow_path() -> None:
    args = parse_args(["custom/WORKFLOW.md", "--once"])

    assert args.workflow == "custom/WORKFLOW.md"
    assert args.once is True

def test_parse_args_rejects_legacy_dispatch_issue_id() -> None:
    with pytest.raises(SystemExit):
        parse_args(["custom/WORKFLOW.md", "--dispatch-issue-id", "issue-123"])

def test_parse_args_accepts_phase_request_and_result_paths() -> None:
    args = parse_args(
        [
            "custom/WORKFLOW.md",
            "--advance-request-path",
            "/tmp/request.json",
            "--phase-result-path",
            "/tmp/result.json",
        ]
    )

    assert args.advance_request_path == "/tmp/request.json"
    assert args.phase_result_path == "/tmp/result.json"

def test_podium_parse_args_accepts_helpful_defaults() -> None:
    args = parse_podium_args([])

    assert args.command == "api"
    assert args.host == "127.0.0.1"
    assert args.port == 8090

def test_podium_parse_args_accepts_legacy_top_level_port() -> None:
    args = parse_podium_args(["--port", "8123"])

    assert args.command == "api"
    assert args.port == 8123

def test_build_config_from_explicit_workflow_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("LINEAR_API_KEY", "linear-token")
    workflow = tmp_path / "custom.md"
    workflow.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: $LINEAR_API_KEY
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )

    config = build_config_from_path(workflow)

    assert config.workflow_path == workflow
    assert config.tracker.project_slug == "MT"
    assert config.tracker.api_key == "linear-token"

def test_build_config_loads_env_file_next_to_workflow(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    (tmp_path / ".env").write_text("LINEAR_API_KEY=linear-token-from-file\n", encoding="utf-8")
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: $LINEAR_API_KEY
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )

    config = build_config_from_path(workflow)

    assert config.tracker.api_key == "linear-token-from-file"

def test_env_file_does_not_override_existing_environment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("LINEAR_API_KEY", "linear-token-from-env")
    (tmp_path / ".env").write_text("LINEAR_API_KEY=linear-token-from-file\n", encoding="utf-8")
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: $LINEAR_API_KEY
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )

    config = build_config_from_path(workflow)

    assert config.tracker.api_key == "linear-token-from-env"

def test_apply_runtime_config_updates_tracker_workspace_and_codex(tmp_path: Path) -> None:
    first = make_service_config(tmp_path, project_slug="OLD", api_key="old-token", workspace="old", command="old-codex")
    second = make_service_config(tmp_path, project_slug="NEW", api_key="new-token", workspace="new", command="new-codex")
    tracker = LinearTracker(first.tracker)
    workspace_manager = WorkspaceManager(first.workspace, first.hooks)
    runner = AgentRunner(first, workspace_manager, tracker=tracker)

    class NoopRunner:
        async def run_issue(self, issue, attempt, on_event):
            return None

    orchestrator = Orchestrator(first, tracker, NoopRunner(), workspace_manager=workspace_manager)

    apply_runtime_config(second, tracker=tracker, runner=runner, orchestrator=orchestrator)

    assert orchestrator.config is second
    assert tracker.config is second.tracker
    assert tracker.client.endpoint == "https://api.linear.app/graphql"
    assert tracker.client.api_key == "new-token"
    assert runner.config is second
    assert runner.config.prompt_template == second.prompt_template
    assert runner.workspace_manager.config.root == tmp_path / "new"
    assert orchestrator.workspace_manager is runner.workspace_manager
    assert orchestrator.config.prompt_template == second.prompt_template
    assert runner.codex_client.config.command == "new-codex"

def test_apply_runtime_config_disables_existing_acceptance_runner(tmp_path: Path) -> None:
    first_base = make_service_config(tmp_path, project_slug="OLD", api_key="old-token", workspace="old", command="old-codex")
    first = ServiceConfig(
        tracker=first_base.tracker,
        polling=first_base.polling,
        workspace=first_base.workspace,
        hooks=first_base.hooks,
        agent=first_base.agent,
        codex=first_base.codex,
        prompt_template=first_base.prompt_template,
        workflow_path=first_base.workflow_path,
        acceptance=AcceptanceConfig(enabled=True),
    )
    second = make_service_config(tmp_path, project_slug="NEW", api_key="new-token", workspace="new", command="new-codex")
    tracker = LinearTracker(first.tracker)
    workspace_manager = WorkspaceManager(first.workspace, first.hooks)
    runner = AgentRunner(first, workspace_manager, tracker=tracker)

    class NoopRunner:
        async def run_issue(self, issue, attempt, on_event):
            return None

    orchestrator = Orchestrator(
        first,
        tracker,
        NoopRunner(),
        workspace_manager=workspace_manager,
        acceptance_runner=build_acceptance_runner(first),
    )

    apply_runtime_config(second, tracker=tracker, runner=runner, orchestrator=orchestrator)

    assert orchestrator.acceptance_runner is None

def test_build_acceptance_runner_only_when_enabled(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    enabled = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        acceptance=AcceptanceConfig(enabled=True),
    )

    assert build_acceptance_runner(config) is None
    assert isinstance(build_acceptance_runner(enabled), CodexAcceptanceRunner)

def test_build_acceptance_runner_uses_smoke_runner_for_smoke_gate_mode(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    enabled = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        acceptance=AcceptanceConfig(enabled=True, gate_planner_mode="smoke"),
    )

    assert isinstance(build_acceptance_runner(enabled), SmokeAcceptanceRunner)

def test_persistence_store_from_config_uses_configured_path(tmp_path: Path) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: token
persistence:
  path: ./state/performer.json
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )
    config = build_config_from_path(workflow)

    store = persistence_store_from_config(config)

    assert store is not None
    assert store.path == (tmp_path / "state" / "performer.json").resolve()

def test_persistence_store_from_config_returns_none_when_unconfigured(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")

    assert persistence_store_from_config(config) is None

async def test_run_phase_advance_writes_result_file_atomically(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "nested" / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workflow_profile="default",
                workspace_context={"workspace_root": str(tmp_path / "workspace")},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class Tracker:
        pass

    class Runner:
        def __init__(self, *args, **kwargs):
            pass

    class Workspace:
        def __init__(self, *args, **kwargs):
            pass

    class Store:
        pass

    class AdvanceOnlyOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()
            self.requests = []
            pass

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            self.requests.append(request)
            return cli.PhaseAdvanceResult(
                run_id=request.run_id,
                issue_id=request.issue_id,
                next_phase=RunPhase.REVIEWING,
                status="reviewing",
                reason=f"phase={request.current_phase.value}",
                retry_delay_seconds=None,
                workspace_path=str(tmp_path / "workspace" / "ENG-1"),
                ops_snapshot_path=str(tmp_path / "state" / "ops.json"),
            )

        async def wait_for_idle(self):
            pass

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: Tracker())
    monkeypatch.setattr(cli, "WorkspaceManager", Workspace)
    monkeypatch.setattr(cli, "AgentRunner", Runner)
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: Store())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", AdvanceOnlyOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert result.next_phase is RunPhase.REVIEWING
    assert payload == {
        "run_id": "run-1",
        "issue_id": "issue-123",
        "next_phase": "reviewing",
        "status": "reviewing",
        "reason": "phase=queued",
        "retry_delay_seconds": None,
        "detail": None,
        "http_status": None,
        "human_action": None,
        "workspace_path": str(tmp_path / "workspace" / "ENG-1"),
        "ops_snapshot_path": str(tmp_path / "state" / "ops.json"),
    }
    assert not result_path.with_suffix(".json.tmp").exists()

async def test_run_phase_advance_passes_conductor_human_response_to_advance(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=2,
                human_response="Approved by operator.",
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )
    calls: list[object] = []

    class AdvanceOnlyOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            calls.append("load")

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            calls.append("cleanup")

        async def advance(self, request):
            calls.append(("advance", request.issue_id, request.current_phase, request.human_response))
            return cli.PhaseAdvanceResult(
                run_id=request.run_id,
                issue_id=request.issue_id,
                next_phase=RunPhase.DONE,
                status="completed",
            )

        async def wait_for_idle(self):
            calls.append("idle")

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", AdvanceOnlyOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)

    assert result.next_phase is RunPhase.DONE
    assert calls == [
        "load",
        "cleanup",
        ("advance", "issue-123", RunPhase.QUEUED, "Approved by operator."),
        "idle",
    ]

async def test_run_phase_advance_writes_init_failed_result_when_codex_init_fails(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class InitFailingOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            raise cli.CodexError("codex_init_failed", "sdk_transport_error: injected failure")

        async def wait_for_idle(self):
            pass

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", InitFailingOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "init_failed"
    assert payload["status"] == "init_failed"
    assert payload["reason"] == "codex_init_failed"

async def test_run_phase_advance_preserves_codex_error_detail_and_http_status(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class InitFailingOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            raise cli.CodexError(
                "codex_init_failed",
                "upstream 502: server overloaded raw body",
                http_status=502,
            )

        async def wait_for_idle(self):
            pass

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", InitFailingOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert result.status == "init_failed"
    assert result.reason == "codex_init_failed"
    assert result.detail == "upstream 502: server overloaded raw body"
    assert result.http_status == 502
    assert payload["detail"] == "upstream 502: server overloaded raw body"
    assert payload["http_status"] == 502

async def test_run_phase_advance_maps_exhausted_upstream_overload_to_overload_status(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class OverloadedOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            raise cli.CodexError(
                "upstream_overloaded_exhausted",
                "JSON-RPC error -32000: upstream 502: server overloaded",
                http_status=502,
            )

        async def wait_for_idle(self):
            pass

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", OverloadedOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "upstream_overloaded"
    assert result.reason == "upstream_overloaded_exhausted"
    assert result.detail == "JSON-RPC error -32000: upstream 502: server overloaded"
    assert result.http_status == 502

async def test_run_phase_advance_writes_retry_result_when_codex_turn_times_out(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class TimeoutOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            raise cli.CodexError("timeout", "turn exceeded hard timeout")

        async def wait_for_idle(self):
            pass

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", TimeoutOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "retry"
    assert result.reason == "timeout"
    assert payload["status"] == "retry"
    assert payload["reason"] == "timeout"
