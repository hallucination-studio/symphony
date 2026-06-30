from __future__ import annotations

from dataclasses import asdict
import hashlib
from pathlib import Path
from typing import Any, Protocol
import logging

from .codex_client import CodexAppServerClient
from .config import ServiceConfig
from .linear_tool import LinearGraphQLTool
from .models import Issue, normalize_state_key
from .ops_store import OpsStore
from .ops_telemetry import ExecutionTelemetryRecorder
from .persistence import ops_snapshot_path_from_persistence_path
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
            telemetry = self._telemetry_recorder()
            telemetry_on_event = on_event
            if telemetry is not None:
                run_id = telemetry.open_run(
                    issue.id,
                    issue.identifier,
                    self._instance_id(),
                    str(workspace.path),
                    hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12],
                    title=issue.title,
                )
                attempt_id = telemetry.open_attempt(run_id, attempt_number=attempt or 1)
                telemetry_on_event = self._telemetry_event_handler(
                    telemetry,
                    run_id,
                    attempt_id,
                    on_event,
                )
            await self.codex_client.run_session(
                workspace.path,
                prompt,
                f"{issue.identifier}: {issue.title}",
                on_event=telemetry_on_event,
                max_turns=self.config.agent.max_turns,
                continuation_provider=lambda turn_count: self._continuation_prompt(issue, turn_count),
                worker_host=worker_host,
            )
            if telemetry is not None:
                telemetry.finish_run(run_id, status="completed", failure_code=None, failure_summary=None)
        except Exception as exc:
            if "telemetry" in locals() and telemetry is not None and "run_id" in locals():
                telemetry.finish_run(
                    run_id,
                    status="failed",
                    failure_code=exc.__class__.__name__,
                    failure_summary=str(exc),
                )
            raise
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

    def _telemetry_recorder(self) -> ExecutionTelemetryRecorder | None:
        if self.config.persistence.path is None:
            return None
        return ExecutionTelemetryRecorder(OpsStore(ops_snapshot_path_from_persistence_path(self.config.persistence.path)))

    def _instance_id(self) -> str:
        persistence_path = self.config.persistence.path
        if persistence_path is None:
            return "local"
        parents = persistence_path.parents
        if len(parents) >= 3 and parents[2].name == "instances":
            return parents[1].name
        return "local"

    def _telemetry_event_handler(
        self,
        telemetry: ExecutionTelemetryRecorder,
        run_id: str,
        attempt_id: str,
        downstream: Any,
    ) -> Any:
        turn_ids: dict[str, str] = {}

        def handle(event: dict[str, Any]) -> None:
            event_name = event.get("event")
            turn_key = event.get("turn_id")
            if event_name == "turn_started":
                turn_number = len(turn_ids) + 1
                ops_turn_id = telemetry.open_turn(attempt_id, turn_number)
                if isinstance(turn_key, str) and turn_key:
                    turn_ids[turn_key] = ops_turn_id
                telemetry.record_event(
                    telemetry.make_event(
                        "codex_turn_started",
                        run_id=run_id,
                        attempt_id=attempt_id,
                        turn_id=ops_turn_id,
                        payload=dict(event),
                    )
                )
            elif event_name == "thread_token_usage_updated":
                ops_turn_id = _current_turn_id(turn_ids, turn_key)
                usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
                if ops_turn_id is not None:
                    telemetry.update_turn_tokens(
                        ops_turn_id,
                        input_tokens=_int(usage.get("input_tokens")),
                        output_tokens=_int(usage.get("output_tokens")),
                        cached_tokens=_int(usage.get("cached_tokens")),
                        total_tokens=_int(usage.get("total_tokens")),
                    )
            elif event_name in {"turn_completed", "turn_failed", "turn_cancelled", "turn_ended_with_error"}:
                ops_turn_id = _current_turn_id(turn_ids, turn_key)
                if ops_turn_id is not None:
                    status = "completed" if event_name == "turn_completed" else "failed"
                    telemetry.finish_turn(ops_turn_id, status=status, stop_reason=event.get("message"))
            elif isinstance(event_name, str):
                telemetry.record_event(
                    telemetry.make_event(
                        str(event_name),
                        run_id=run_id,
                        attempt_id=attempt_id,
                        turn_id=_current_turn_id(turn_ids, turn_key),
                        payload=dict(event),
                    )
                )
            downstream(event)

        return handle


def _current_turn_id(turn_ids: dict[str, str], turn_key: Any) -> str | None:
    if isinstance(turn_key, str) and turn_key in turn_ids:
        return turn_ids[turn_key]
    if turn_ids:
        return next(reversed(turn_ids.values()))
    return None


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return 0
