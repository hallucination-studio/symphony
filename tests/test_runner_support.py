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
