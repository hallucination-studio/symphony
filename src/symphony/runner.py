from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Protocol
import logging

from .codex_client import CodexAppServerClient
from .config import ServiceConfig
from .linear_tool import LinearGraphQLTool
from .models import Issue, normalize_state_key
from .workflow import render_prompt
from .workspace import WorkspaceManager

logger = logging.getLogger(__name__)


class RunnerCodexClient(Protocol):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any: ...


class RunnerTracker(Protocol):
    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]: ...


class AgentRunner:
    def __init__(
        self,
        config: ServiceConfig,
        workspace_manager: WorkspaceManager,
        codex_client: RunnerCodexClient | None = None,
        tracker: RunnerTracker | None = None,
    ):
        self.config = config
        self.workspace_manager = workspace_manager
        tools = {}
        if config.tracker.kind == "linear":
            tools["linear_graphql"] = LinearGraphQLTool(config.tracker.endpoint, config.tracker.api_key)
        self.codex_client = codex_client or CodexAppServerClient(config.codex, tools=tools)
        self.tracker = tracker

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        workspace = await self.workspace_manager.create_for_issue(issue.identifier)
        self.workspace_manager.validate_workspace_path(workspace.path)
        await self.workspace_manager.run_before_run(workspace.path)
        try:
            prompt = render_prompt(
                self.config.prompt_template,
                {"issue": asdict(issue), "attempt": attempt},
            )
            logger.info(
                "symphony_runner outcome=starting issue_id=%s issue_identifier=%s workspace=%s worker_host=%s",
                issue.id,
                issue.identifier,
                workspace.path,
                worker_host or "local",
            )
            await self.codex_client.run_session(
                workspace.path,
                prompt,
                f"{issue.identifier}: {issue.title}",
                on_event=on_event,
                max_turns=self.config.agent.max_turns,
                continuation_provider=lambda turn_count: self._continuation_prompt(issue, turn_count),
                worker_host=worker_host,
            )
        finally:
            await self.workspace_manager.run_after_run(workspace.path)

    async def _continuation_prompt(self, issue: Issue, turn_count: int) -> str | None:
        if self.tracker is not None:
            refreshed = await self.tracker.fetch_issue_states_by_ids([issue.id])
            if not refreshed:
                return None
            issue = refreshed[0]
            if not self._can_continue(issue):
                return None
        next_turn = turn_count + 1
        terminal_states = ", ".join(str(state) for state in self.config.tracker.terminal_states)
        return (
            f"Continue working on {issue.identifier}. This is turn {next_turn} of {self.config.agent.max_turns}. "
            "If the requested work is already implemented and verified, finish by updating Linear: "
            "leave a concise completion comment and move the issue out of the active states. "
            f"Configured terminal states: {terminal_states}."
        )

    def _can_continue(self, issue: Issue) -> bool:
        if not self._is_active(issue):
            return False
        if self.config.tracker.kind == "linear" and issue.project_slug != self.config.tracker.project_slug:
            return False
        if not self._matches_assignee(issue):
            return False
        if not issue.has_required_labels(self.config.tracker.required_labels):
            return False
        if issue.state_key() == "todo" and issue.has_non_terminal_blocker(self.config.tracker.terminal_states):
            return False
        return True

    def _is_active(self, issue: Issue) -> bool:
        active = {normalize_state_key(state) for state in self.config.tracker.active_states}
        terminal = {normalize_state_key(state) for state in self.config.tracker.terminal_states}
        return issue.state_key() in active and issue.state_key() not in terminal

    def _matches_assignee(self, issue: Issue) -> bool:
        configured = self.config.tracker.assignee_id
        if not configured:
            return True
        return issue.assignee_id == configured
