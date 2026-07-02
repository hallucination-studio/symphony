from __future__ import annotations

from pathlib import Path

import pytest

from performer import cli
from podium.cli import parse_args as parse_podium_args
from performer.cli import (
    apply_runtime_config,
    build_config_from_path,
    build_acceptance_runner,
    default_workflow_path,
    persistence_store_from_config,
    parse_args,
)
from performer.codex_client import CodexAppServerClient
from conductor.conductor_cli import parse_args as parse_conductor_args
from performer_api.config import (
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    AcceptanceConfig,
    WorkspaceConfig,
)
from performer.acceptance import CodexAcceptanceRunner
from performer.linear import LinearTracker
from performer.orchestrator import Orchestrator
from performer.runner import AgentRunner
from performer.workspace import WorkspaceManager


def test_default_workflow_path_uses_cwd(tmp_path: Path) -> None:
    assert default_workflow_path(tmp_path) == tmp_path / "WORKFLOW.md"


def test_conductor_default_data_root_is_dot_performer() -> None:
    args = parse_conductor_args([])

    assert args.data_root == ".conductor"


def test_parse_args_accepts_positional_workflow_path() -> None:
    args = parse_args(["custom/WORKFLOW.md", "--once"])

    assert args.workflow == "custom/WORKFLOW.md"
    assert args.once is True


def test_parse_args_accepts_event_dispatch_issue_id() -> None:
    args = parse_args(["custom/WORKFLOW.md", "--dispatch-issue-id", "issue-123"])

    assert args.workflow == "custom/WORKFLOW.md"
    assert args.dispatch_issue_id == "issue-123"


def test_podium_parse_args_accepts_helpful_defaults() -> None:
    args = parse_podium_args([])

    assert args.command == "api"
    assert args.host == "127.0.0.1"
    assert args.port == 8090



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


def make_service_config(tmp_path: Path, *, project_slug: str, api_key: str, workspace: str, command: str) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug=project_slug,
            api_key=api_key,
            required_labels=["codex"],
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path / workspace),
        hooks=HooksConfig(timeout_ms=1234),
        agent=AgentConfig(max_turns=3),
        codex=CodexConfig(command=command),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


def test_apply_runtime_config_updates_tracker_workspace_and_codex(tmp_path: Path) -> None:
    first = make_service_config(tmp_path, project_slug="OLD", api_key="old-token", workspace="old", command="old-codex")
    second = make_service_config(tmp_path, project_slug="NEW", api_key="new-token", workspace="new", command="new-codex")
    tracker = LinearTracker(first.tracker)
    workspace_manager = WorkspaceManager(first.workspace, first.hooks)
    codex_client = CodexAppServerClient(first.codex)
    runner = AgentRunner(first, workspace_manager, codex_client, tracker=tracker)

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
    runner = AgentRunner(first, workspace_manager, CodexAppServerClient(first.codex), tracker=tracker)

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


@pytest.mark.asyncio
async def test_run_dispatch_issue_invokes_event_dispatch_without_polling(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    calls: list[object] = []

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

    class DispatchOnlyOrchestrator:
        def __init__(self, *args, **kwargs):
            pass

        def load_persisted_state(self):
            calls.append("load")

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            calls.append("cleanup")

        async def dispatch_issue_by_id(self, issue_id):
            calls.append(("dispatch_issue_by_id", issue_id))
            return {"status": "dispatched", "issue_id": issue_id}

        async def tick(self):
            calls.append("tick")

        async def wait_for_idle(self):
            calls.append("idle")

    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: Tracker())
    monkeypatch.setattr(cli, "WorkspaceManager", Workspace)
    monkeypatch.setattr(cli, "AgentRunner", Runner)
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: Store())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", DispatchOnlyOrchestrator)

    result = await cli.run_dispatch_issue(workflow, "issue-123")

    assert result == {"status": "dispatched", "issue_id": "issue-123"}
    assert calls == ["load", "cleanup", ("dispatch_issue_by_id", "issue-123"), "idle"]


def test_main_returns_nonzero_on_startup_failure(monkeypatch) -> None:
    async def failing_daemon(path, *, once=False):
        raise RuntimeError("boom")

    monkeypatch.setattr(cli, "run_reloading_daemon", failing_daemon)

    assert cli.main(["WORKFLOW.md", "--once"]) == 1


def test_main_returns_zero_on_normal_shutdown(monkeypatch) -> None:
    captured = {}

    async def successful_daemon(path, *, once=False):
        captured["once"] = once
        return None

    monkeypatch.setattr(cli, "run_reloading_daemon", successful_daemon)

    assert cli.main(["WORKFLOW.md", "--once"]) == 0
    assert captured["once"] is True
