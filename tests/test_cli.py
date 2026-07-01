from __future__ import annotations

from pathlib import Path

import pytest

from symphony import cli
from symphony.cli import (
    apply_runtime_config,
    build_config_from_path,
    build_acceptance_runner,
    default_workflow_path,
    effective_server_port,
    _maybe_start_http_server,
    persistence_store_from_config,
    parse_args,
)
from symphony.codex_client import CodexAppServerClient
from symphony.conductor_cli import parse_args as parse_conductor_args
from symphony.config import (
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    ObservabilityConfig,
    AcceptanceConfig,
    WorkspaceConfig,
)
from symphony.acceptance import CodexAcceptanceRunner
from symphony.linear import LinearTracker
from symphony.orchestrator import Orchestrator
from symphony.runner import AgentRunner
from symphony.workspace import WorkspaceManager


def test_default_workflow_path_uses_cwd(tmp_path: Path) -> None:
    assert default_workflow_path(tmp_path) == tmp_path / "WORKFLOW.md"


def test_conductor_default_data_root_is_dot_symphony() -> None:
    args = parse_conductor_args([])

    assert args.data_root == ".symphony"


def test_parse_args_accepts_positional_workflow_path() -> None:
    args = parse_args(["custom/WORKFLOW.md", "--once"])

    assert args.workflow == "custom/WORKFLOW.md"
    assert args.once is True


def test_parse_args_accepts_port_override() -> None:
    args = parse_args(["custom/WORKFLOW.md", "--port", "0"])

    assert args.workflow == "custom/WORKFLOW.md"
    assert args.port == 0


def test_effective_server_port_prefers_cli_override(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")

    assert effective_server_port(config, 0) == 0


def test_effective_server_port_uses_workflow_server_port(tmp_path: Path) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text(
        """---
tracker:
  kind: linear
  project_slug: MT
  api_key: token
server:
  port: 8181
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )
    config = build_config_from_path(workflow)

    assert effective_server_port(config, None) == 8181


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
  path: ./state/symphony.json
---
Do {{ issue.identifier }}
""",
        encoding="utf-8",
    )
    config = build_config_from_path(workflow)

    store = persistence_store_from_config(config)

    assert store is not None
    assert store.path == (tmp_path / "state" / "symphony.json").resolve()


def test_persistence_store_from_config_returns_none_when_unconfigured(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")

    assert persistence_store_from_config(config) is None


@pytest.mark.asyncio
async def test_observability_disabled_prevents_http_server_start(tmp_path: Path) -> None:
    config = make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex")
    disabled = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        server=type(config.server)(port=0, host=config.server.host),
        observability=ObservabilityConfig(enabled=False),
    )
    tracker = LinearTracker(disabled.tracker)
    workspace_manager = WorkspaceManager(disabled.workspace, disabled.hooks)
    runner = AgentRunner(disabled, workspace_manager, CodexAppServerClient(disabled.codex), tracker=tracker)
    orchestrator = Orchestrator(disabled, tracker, runner, workspace_manager=workspace_manager)

    server = await _maybe_start_http_server(disabled, orchestrator, None)

    assert server is None


def test_main_returns_nonzero_on_startup_failure(monkeypatch) -> None:
    async def failing_daemon(path, *, once=False, port=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(cli, "run_reloading_daemon", failing_daemon)

    assert cli.main(["WORKFLOW.md", "--once"]) == 1


def test_main_returns_zero_on_normal_shutdown(monkeypatch) -> None:
    captured = {}

    async def successful_daemon(path, *, once=False, port=None):
        captured["port"] = port
        return None

    monkeypatch.setattr(cli, "run_reloading_daemon", successful_daemon)

    assert cli.main(["WORKFLOW.md", "--once", "--port", "0"]) == 0
    assert captured["port"] == 0
