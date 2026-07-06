from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any

import pytest

from performer_api.config import (
    AcceptanceConfig,
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PersistenceConfig,
    PollingConfig,
    RepositoryHandoffConfig,
    ServiceConfig,
    TrackerConfig,
    WorkspaceConfig,
)
from performer_api.models import Issue
from performer_api.ops_store import OpsStore
from performer_api.persistence import ops_snapshot_path_from_persistence_path
from performer_api.persistence import CodexThreadEntry, PersistenceStore, PersistedState
from performer.runner import AgentRunner
from performer.workspace import Workspace, WorkspaceError, WorkspaceManager


class FakeCodex:
    def __init__(self):
        self.workspace_path: Path | None = None
        self.prompt: str | None = None
        self.title: str | None = None
        self.kwargs: dict[str, Any] | None = None

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> None:
        self.workspace_path = workspace_path
        self.prompt = prompt
        self.title = title
        self.kwargs = kwargs


class FakeCodexWithThread(FakeCodex):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any:
        await super().run_session(workspace_path, prompt, title, **kwargs)

        class Result:
            thread_id = "thread-new"
            turn_id = "turn-new"
            final_response = "done"
            structured_result = None

        return Result()


class FailingCodexWithThread(FakeCodex):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any:
        await super().run_session(workspace_path, prompt, title, **kwargs)
        on_event = kwargs["on_event"]
        on_event(
            {
                "event": "session_started",
                "thread_id": "thread-failed",
                "turn_id": "turn-failed",
                "session_id": "thread-failed-turn-failed",
                "cwd": str(workspace_path),
            }
        )
        raise RuntimeError("codex failed")


class FakeCodexWithoutTurnStarted(FakeCodex):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> None:
        await super().run_session(workspace_path, prompt, title, **kwargs)
        on_event = kwargs["on_event"]
        on_event(
            {
                "event": "thread_token_usage_updated",
                "turn_id": "turn_1",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 4,
                    "cached_tokens": 2,
                    "total_tokens": 18,
                },
            }
        )
        on_event({"event": "turn_completed", "turn_id": "turn_1", "message": "completed"})


class FakeTracker:
    def __init__(self, issue: Issue | None = None, *, missing: bool = False):
        self.issue = None if missing else issue or Issue(
            id="mt-1",
            identifier="MT-1",
            title="Build",
            state="Todo",
            labels=["codex"],
            project_slug="MT",
        )

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        if self.issue is None:
            return []
        return [self.issue]


class BadWorkspaceManager:
    def __init__(self, root: Path, bad_path: Path):
        self.config = WorkspaceConfig(root=root)
        self.bad_path = bad_path

    async def create_for_issue(self, identifier: str) -> Workspace:
        return Workspace(path=self.bad_path, workspace_key=identifier, created_now=False)

    async def run_before_run(self, path: Path) -> None:
        return None

    async def run_after_run(self, path: Path) -> None:
        return None

    def validate_workspace_path(self, path: Path) -> None:
        root = self.config.root.resolve()
        candidate = path.resolve()
        if candidate != root and root not in candidate.parents:
            raise WorkspaceError("workspace_path_outside_root", f"Workspace path escapes root: {candidate}")


def make_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_turns=2),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


def make_config_with_persistence(tmp_path: Path) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        persistence=PersistenceConfig(path=tmp_path / "state" / "performer.json"),
    )


def make_config_with_acceptance(tmp_path: Path) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
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


def make_config_with_required_delegate(tmp_path: Path, delegate_id: str) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=TrackerConfig(
            kind=config.tracker.kind,
            endpoint=config.tracker.endpoint,
            project_slug=config.tracker.project_slug,
            api_key=config.tracker.api_key,
            required_delegate_id=delegate_id,
            active_states=config.tracker.active_states,
            terminal_states=config.tracker.terminal_states,
        ),
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )


def test_runner_does_not_expose_linear_graphql_tool(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend="sdk", linear_tool_mode="disabled"),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )

    runner = AgentRunner(
        config,
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
    )

    assert not hasattr(runner.codex_client, "tools")


def test_default_sdk_runner_does_not_expose_linear_tool_for_custom_tracker(tmp_path: Path) -> None:
    config = ServiceConfig(
        tracker=TrackerConfig(
            kind="custom",
            endpoint="https://tracker.example/api",
            project_slug="",
            api_key="",
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )

    runner = AgentRunner(
        config,
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
    )

    assert not hasattr(runner.codex_client, "tools")


@pytest.mark.asyncio
async def test_runner_uses_workspace_root_when_per_issue_workspace_is_disabled(tmp_path: Path) -> None:
    codex = FakeCodex()
    workspace_root = tmp_path / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    config = make_config(workspace_root)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root, per_issue=False),
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.workspace_path == workspace_root
    assert not (workspace_root / "MT-1").exists()


@pytest.mark.asyncio
async def test_runner_ignores_instance_persistence_sdk_thread_id(tmp_path: Path) -> None:
    codex = FakeCodex()
    config = make_config_with_persistence(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=tmp_path, per_issue=False),
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend="sdk", linear_tool_mode="disabled"),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        persistence=config.persistence,
    )
    PersistenceStore(config.persistence.path).save(
        PersistedState(
            codex_threads=[
                CodexThreadEntry(
                    issue_id="mt-1",
                    thread_id="thread-existing",
                    backend="sdk",
                    workspace_path=str(tmp_path),
                    status="resume_pending",
                )
            ]
        )
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        2,
        lambda event: None,
    )

    assert codex.kwargs is not None
    assert codex.kwargs["existing_thread_id"] is None


@pytest.mark.asyncio
async def test_runner_prefers_workspace_owned_sdk_thread_id(tmp_path: Path) -> None:
    codex = FakeCodex()
    workspace_root = tmp_path / "workspace"
    issue_workspace = workspace_root / "MT-1"
    issue_workspace.mkdir(parents=True)
    execution_dir = issue_workspace / ".symphony"
    execution_dir.mkdir()
    (execution_dir / "execution.json").write_text(
        json.dumps(
            {
                "issue_id": "mt-1",
                "thread_id": "thread-workspace",
                "backend": "sdk",
                "workspace_path": str(issue_workspace),
                "status": "resume_pending",
            }
        ),
        encoding="utf-8",
    )
    config = make_config_with_persistence(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root),
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend="sdk", linear_tool_mode="disabled"),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        persistence=config.persistence,
    )
    PersistenceStore(config.persistence.path).save(
        PersistedState(
            codex_threads=[
                CodexThreadEntry(
                    issue_id="mt-1",
                    thread_id="thread-persistence",
                    backend="sdk",
                    workspace_path=str(issue_workspace),
                    status="resume_pending",
                )
            ]
        )
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        2,
        lambda event: None,
    )

    assert codex.kwargs is not None
    assert codex.kwargs["existing_thread_id"] == "thread-workspace"


@pytest.mark.asyncio
async def test_runner_writes_sdk_thread_id_to_issue_workspace(tmp_path: Path) -> None:
    codex = FakeCodexWithThread()
    workspace_root = tmp_path / "workspace"
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root),
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend="sdk", linear_tool_mode="disabled"),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        1,
        lambda event: None,
    )

    payload = json.loads((workspace_root / "MT-1" / ".symphony" / "execution.json").read_text(encoding="utf-8"))
    assert payload["issue_id"] == "mt-1"
    assert payload["thread_id"] == "thread-new"
    assert payload["status"] == "resume_pending"


@pytest.mark.asyncio
async def test_runner_marks_workspace_sdk_thread_failed_on_error(tmp_path: Path) -> None:
    codex = FailingCodexWithThread()
    workspace_root = tmp_path / "workspace"
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root),
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend="sdk", linear_tool_mode="disabled"),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    with pytest.raises(RuntimeError, match="codex failed"):
        await runner.run_issue(
            Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
            1,
            lambda event: None,
        )

    execution_path = workspace_root / "MT-1" / ".symphony" / "execution.json"
    payload = json.loads(execution_path.read_text(encoding="utf-8"))
    assert payload["issue_id"] == "mt-1"
    assert payload["thread_id"] == "thread-failed"
    assert payload["last_turn_id"] == "turn-failed"
    assert payload["status"] == "failed"
    assert "codex failed" in payload["failure_summary"]


@pytest.mark.asyncio
async def test_runner_records_turns_even_when_codex_skips_turn_started_event(tmp_path: Path) -> None:
    config = make_config_with_persistence(tmp_path)
    runner = AgentRunner(
        config,
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=FakeCodexWithoutTurnStarted(),
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    snapshot = OpsStore(ops_snapshot_path_from_persistence_path(config.persistence.path)).load()
    assert snapshot.turns
    turn = next(iter(snapshot.turns.values()))
    assert turn.total_tokens == 18


@pytest.mark.asyncio
async def test_runner_validates_workspace_path_before_codex_launch(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path / "root"),
        BadWorkspaceManager(tmp_path / "root", tmp_path / "outside"),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    with pytest.raises(WorkspaceError) as exc:
        await runner.run_issue(
            Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
            None,
            lambda event: None,
        )

    assert exc.value.code == "workspace_path_outside_root"
    assert codex.kwargs is None


@pytest.mark.asyncio
async def test_runner_passes_max_turns_and_tracker_based_continuation(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.kwargs is not None
    assert codex.kwargs["max_turns"] == 2
    continuation = codex.kwargs["continuation_provider"]
    assert await continuation(1) == (
        "Continue working on MT-1. This is turn 2 of 2. "
        "If the requested work is already implemented and verified, finish by updating Linear: "
        "leave a concise completion comment and move the issue out of the active states. "
        "Configured terminal states: Closed, Cancelled, Canceled, Duplicate, Done."
    )


@pytest.mark.asyncio
async def test_runner_acceptance_prompt_forbids_state_changes_and_requires_evidence(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config_with_acceptance(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="In Progress", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.prompt is not None
    assert "Do not move the Linear issue to In Review or Done" in codex.prompt
    assert "Implementation summary" in codex.prompt
    assert "Test commands and exact output" in codex.prompt
    assert "Remaining risks" in codex.prompt
    continuation = codex.kwargs["continuation_provider"]
    assert "Do not move the Linear issue to In Review or Done" in await continuation(1)


@pytest.mark.asyncio
async def test_runner_passes_worker_host_to_codex_session(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
        worker_host="builder-1",
    )

    assert codex.kwargs is not None
    assert codex.kwargs["worker_host"] == "builder-1"


@pytest.mark.asyncio
async def test_runner_writes_run_attempt_turn_ops_snapshot(tmp_path: Path) -> None:
    codex = FakeCodex()
    config = make_config_with_persistence(tmp_path)
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )
    forwarded_events: list[dict[str, Any]] = []

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        1,
        forwarded_events.append,
    )

    assert codex.kwargs is not None
    codex.kwargs["on_event"](
        {
            "event": "turn_started",
            "thread_id": "thr_1",
            "turn_id": "turn_1",
            "session_id": "thr_1-turn_1",
        }
    )
    codex.kwargs["on_event"](
        {
            "event": "thread_token_usage_updated",
            "session_id": "thr_1-turn_1",
            "turn_id": "turn_1",
            "usage": {"input_tokens": 12, "output_tokens": 4, "cached_tokens": 2, "total_tokens": 18},
        }
    )
    codex.kwargs["on_event"](
        {
            "event": "turn_completed",
            "thread_id": "thr_1",
            "turn_id": "turn_1",
            "session_id": "thr_1-turn_1",
        }
    )

    snapshot = OpsStore(ops_snapshot_path_from_persistence_path(config.persistence.path)).load()
    run = next(iter(snapshot.runs.values()))
    turn = next(iter(snapshot.turns.values()))
    assert run.issue_id == "mt-1"
    assert run.instance_id == "local"
    assert run.workspace_path == str(tmp_path / "MT-1")
    assert run.turn_count == 1
    assert turn.cached_tokens == 2
    assert snapshot.events[-1].event_type == "turn_completed"
    assert [event["event"] for event in forwarded_events] == [
        "turn_started",
        "thread_token_usage_updated",
        "turn_completed",
    ]


@pytest.mark.asyncio
async def test_runner_emits_repository_handoff_report_ops_event_without_linear_child_issue(tmp_path: Path) -> None:
    codex = FakeCodex()
    workspace_root = tmp_path / "repo"
    workspace_root.mkdir()
    subprocess.run(["git", "-C", str(workspace_root), "init"], check=True, stdout=subprocess.PIPE)
    subprocess.run(["git", "-C", str(workspace_root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(workspace_root), "config", "user.name", "Test User"], check=True)
    (workspace_root / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(workspace_root), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(workspace_root), "commit", "-m", "initial"], check=True, stdout=subprocess.PIPE)
    (workspace_root / "README.md").write_text("after\n", encoding="utf-8")
    config = make_config_with_persistence(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root, per_issue=False),
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        persistence=config.persistence,
        repository_handoff=RepositoryHandoffConfig(enabled=True),
    )
    tracker = FakeTracker()
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=tracker,
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        1,
        lambda event: None,
    )

    snapshot = OpsStore(ops_snapshot_path_from_persistence_path(config.persistence.path)).load()
    events = [event for event in snapshot.events if event.event_type == "repository_handoff_report.v1"]
    assert len(events) == 1
    assert events[0].payload["issue_identifier"] == "MT-1"
    assert Path(events[0].payload["bundle"]["changes_patch_path"]).exists()
    assert not hasattr(tracker, "create_child_issue_for")


@pytest.mark.asyncio
async def test_runner_defers_repository_handoff_when_acceptance_is_enabled(tmp_path: Path) -> None:
    codex = FakeCodex()
    workspace_root = tmp_path / "repo"
    workspace_root.mkdir()
    config = make_config_with_persistence(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=WorkspaceConfig(root=workspace_root, per_issue=False),
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        persistence=config.persistence,
        acceptance=AcceptanceConfig(enabled=True),
        repository_handoff=RepositoryHandoffConfig(enabled=True),
    )
    runner = AgentRunner(
        config,
        WorkspaceManager(config.workspace, config.hooks),
        codex_client=codex,
        tracker=FakeTracker(),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        1,
        lambda event: None,
    )

    snapshot = OpsStore(ops_snapshot_path_from_persistence_path(config.persistence.path)).load()
    assert [event for event in snapshot.events if event.event_type == "repository_handoff_report.v1"] == []


@pytest.mark.asyncio
async def test_continuation_ignores_label_changes(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=[], project_slug="MT")),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.kwargs is not None
    continuation = codex.kwargs["continuation_provider"]
    assert await continuation(1) is not None


@pytest.mark.asyncio
async def test_continuation_stops_when_delegate_changes(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config_with_required_delegate(tmp_path, "agent-user-1"),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(
            Issue(
                id="mt-1",
                identifier="MT-1",
                title="Build",
                state="Todo",
                labels=["codex"],
                project_slug="MT",
                delegate_id="other-agent",
            )
        ),
    )

    await runner.run_issue(
        Issue(
            id="mt-1",
            identifier="MT-1",
            title="Build",
            state="Todo",
            labels=["codex"],
            project_slug="MT",
            delegate_id="agent-user-1",
        ),
        None,
        lambda event: None,
    )

    assert codex.kwargs is not None
    continuation = codex.kwargs["continuation_provider"]
    assert await continuation(1) is None


@pytest.mark.asyncio
async def test_continuation_stops_when_project_changes(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(
            Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="OTHER")
        ),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.kwargs is not None
    continuation = codex.kwargs["continuation_provider"]
    assert await continuation(1) is None


@pytest.mark.asyncio
async def test_continuation_stops_when_refresh_returns_no_issue(tmp_path: Path) -> None:
    codex = FakeCodex()
    runner = AgentRunner(
        make_config(tmp_path),
        WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig()),
        codex_client=codex,
        tracker=FakeTracker(missing=True),
    )

    await runner.run_issue(
        Issue(id="mt-1", identifier="MT-1", title="Build", state="Todo", labels=["codex"], project_slug="MT"),
        None,
        lambda event: None,
    )

    assert codex.kwargs is not None
    continuation = codex.kwargs["continuation_provider"]
    assert await continuation(1) is None
