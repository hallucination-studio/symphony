from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from symphony.config import (
    AgentConfig,
    CompletionVerificationConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    WorkerConfig,
    WorkspaceConfig,
)
from symphony.models import BlockerRef, Issue, utc_now
from symphony.orchestrator import Orchestrator
from symphony.persistence import PersistenceStore


class FakeTracker:
    def __init__(self, candidates: list[Issue] | None = None):
        self.candidates = candidates or []
        self.refreshed: list[Issue] = []
        self.by_states: list[Issue] = []
        self.comments: list[tuple[str, str]] = []
        self.lifecycle_labels: list[tuple[str, str]] = []
        self.fail_candidates = False
        self.fail_by_states = False
        self.fail_refresh = False
        self.fail_comment = False
        self.fail_lifecycle_label = False

    async def fetch_candidate_issues(self) -> list[Issue]:
        if self.fail_candidates:
            raise RuntimeError("candidate unavailable")
        return self.candidates

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        if self.fail_refresh:
            raise RuntimeError("refresh unavailable")
        return [issue for issue in self.refreshed if issue.id in issue_ids]

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]:
        if self.fail_by_states:
            raise RuntimeError("linear unavailable")
        return [issue for issue in self.by_states if issue.state in state_names]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        if self.fail_comment:
            raise RuntimeError("comment unavailable")
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        if self.fail_lifecycle_label:
            raise RuntimeError("label unavailable")
        self.lifecycle_labels.append((issue_id, label_name))
        return {"success": True, "issue_id": issue_id, "label": label_name}


class FakeRunner:
    def __init__(self):
        self.started: list[tuple[Issue, int | None]] = []
        self.wait = asyncio_event()

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        self.started.append((issue, attempt))
        await self.wait.wait()


def asyncio_event():
    import asyncio

    return asyncio.Event()


async def asyncio_sleep() -> None:
    import asyncio

    await asyncio.sleep(0)


def make_config(tmp_path: Path, *, max_concurrent: int = 10) -> ServiceConfig:
    return make_config_with_labels(tmp_path, required_labels=["codex"], max_concurrent=max_concurrent)


def make_config_with_labels(
    tmp_path: Path, *, required_labels: list[str], max_concurrent: int = 10
) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
            required_labels=required_labels,
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=max_concurrent, max_retry_backoff_ms=60_000),
        codex=CodexConfig(stall_timeout_ms=300_000),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=False),
    )


def make_config_with_completion_verification(
    tmp_path: Path,
    *,
    required_checks: list[str],
    optional_checks: list[str] | None = None,
    auto_retry_on_fail: bool = True,
) -> ServiceConfig:
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
        completion_verification=CompletionVerificationConfig(
            required_checks=required_checks,
            optional_checks=optional_checks or [],
            auto_retry_on_fail=auto_retry_on_fail,
        ),
    )


def make_config_with_assignee(tmp_path: Path, assignee_id: str) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=TrackerConfig(
            kind=config.tracker.kind,
            endpoint=config.tracker.endpoint,
            project_slug=config.tracker.project_slug,
            api_key=config.tracker.api_key,
            assignee_id=assignee_id,
            required_labels=config.tracker.required_labels,
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


def make_config_with_codex_command(tmp_path: Path, command: str) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(command=command),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )


def make_config_with_workers(tmp_path: Path, hosts: list[str], per_host: int = 1) -> ServiceConfig:
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
        worker=WorkerConfig(ssh_hosts=hosts, max_concurrent_agents_per_host=per_host),
    )


def make_custom_tracker_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="custom",
            endpoint="https://tracker.example/api",
            project_slug="",
            api_key="",
            required_labels=[],
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=10, max_retry_backoff_ms=60_000),
        codex=CodexConfig(stall_timeout_ms=300_000),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


def issue(identifier: str, **overrides: Any) -> Issue:
    data = {
        "id": identifier.lower(),
        "identifier": identifier,
        "title": "Build",
        "state": "Todo",
        "labels": ["codex"],
        "project_slug": "MT",
    }
    data.update(overrides)
    return Issue(**data)


class CompletingRunner:
    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        on_event({"event": "session_started", "session_id": "thread-1-turn-1", "codex_app_server_pid": 123})
        on_event(
            {
                "event": "thread_token_usage_updated",
                "session_id": "thread-1-turn-1",
                "payload": {
                    "total_token_usage": {
                        "input_tokens": 100,
                        "output_tokens": 40,
                        "total_tokens": 140,
                    }
                },
            }
        )
        on_event(
            {
                "event": "thread_token_usage_updated",
                "session_id": "thread-1-turn-1",
                "payload": {
                    "total_token_usage": {
                        "input_tokens": 130,
                        "output_tokens": 50,
                        "total_tokens": 180,
                    }
                },
            }
        )
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})


class ControlledCompletingRunner:
    def __init__(self) -> None:
        self.started = asyncio_event()
        self.release = asyncio_event()

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        on_event({"event": "session_started", "session_id": "thread-1-turn-1", "codex_app_server_pid": 123})
        on_event(
            {
                "event": "thread_token_usage_updated",
                "session_id": "thread-1-turn-1",
                "payload": {
                    "total_token_usage": {
                        "input_tokens": 100,
                        "output_tokens": 40,
                        "total_tokens": 140,
                    }
                },
            }
        )
        self.started.set()
        await self.release.wait()
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})


@pytest.mark.asyncio
async def test_tick_dispatches_candidate_issues_from_tracker(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-1" in orchestrator.state.running


@pytest.mark.asyncio
async def test_dispatch_and_codex_events_update_lifecycle_labels_and_phase(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", labels=["codex2"])])
    runner = FakeRunner()
    config = make_config_with_labels(tmp_path, required_labels=["codex2"])
    orchestrator = Orchestrator(config, tracker, runner)

    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "process_launch",
            "cwd": str(tmp_path / "workspaces" / "MT-1"),
            "command": ["bash", "-lc", "codex app-server"],
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "turn_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    await asyncio_sleep()

    entry = orchestrator.state.running["mt-1"]
    assert tracker.lifecycle_labels == [
        ("mt-1", "symphony:starting"),
        ("mt-1", "symphony:running"),
    ]
    assert entry.phase == "running"
    assert entry.status_label == "symphony:running"
    assert entry.recent_events[-1]["event"] == "turn_started"
    assert entry.recent_events[-1]["raw_event"]["session_id"] == "thread-1-turn-1"
    assert entry.workspace_path == str(tmp_path / "workspaces" / "MT-1")


@pytest.mark.asyncio
async def test_lifecycle_label_failures_do_not_block_dispatch(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.fail_lifecycle_label = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "symphony_lifecycle_label outcome=failed" in caplog.text
    assert "label=symphony:starting" in caplog.text


@pytest.mark.asyncio
async def test_tick_logs_candidate_summary_and_skip_reasons(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2", labels=["other"])])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert "symphony_dispatch_scan candidate_count=2 available_slots=10" in caplog.text
    assert "symphony_dispatch_candidate outcome=dispatch issue_id=mt-1 issue_identifier=MT-1 worker_host=local" in caplog.text
    assert "symphony_dispatch_candidate outcome=skip issue_id=mt-2 issue_identifier=MT-2 reason=missing_required_labels" in caplog.text
    assert "symphony_dispatch_summary dispatched=1 skipped=1 running=1 claimed=1" in caplog.text


@pytest.mark.asyncio
async def test_candidate_fetch_failure_logs_and_skips_dispatch(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.fail_candidates = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}
    assert "symphony_dispatch failed" in caplog.text
    assert "reason=candidate unavailable" in caplog.text


@pytest.mark.asyncio
async def test_tick_validation_failure_logs_and_skips_dispatch_after_reconcile(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_codex_command(tmp_path, " "), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert "symphony_dispatch_validation failed" in caplog.text
    assert "missing_codex_command" in caplog.text


@pytest.mark.asyncio
async def test_tick_rejects_candidate_from_different_project(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", project_slug="OTHER")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}


@pytest.mark.asyncio
async def test_tick_allows_non_linear_tracker_issue_without_project_slug(tmp_path: Path) -> None:
    from symphony.tracker import register_tracker_adapter

    class CustomTracker:
        def __init__(self, config):
            self.config = config

    register_tracker_adapter("custom", CustomTracker)
    tracker = FakeTracker(candidates=[issue("EXT-1", project_slug=None)])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_custom_tracker_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["EXT-1"]


@pytest.mark.asyncio
async def test_tick_rejects_candidate_assigned_to_another_user(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", assignee_id="other-user")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_assignee(tmp_path, "codex-user"), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}


@pytest.mark.asyncio
async def test_tick_dispatches_candidate_assigned_to_configured_user(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", assignee_id="codex-user")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_assignee(tmp_path, "codex-user"), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]


@pytest.mark.asyncio
async def test_blank_required_label_matches_no_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_labels(tmp_path, required_labels=[""]), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}


@pytest.mark.asyncio
async def test_tick_respects_global_concurrency_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path, max_concurrent=1), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert len(orchestrator.state.running) == 1


@pytest.mark.asyncio
async def test_tick_assigns_ssh_worker_hosts_and_respects_per_host_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2"), issue("MT-3")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1", "builder-2"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1", "MT-2"]
    assert orchestrator.state.running["mt-1"].worker_host == "builder-1"
    assert orchestrator.state.running["mt-2"].worker_host == "builder-2"
    assert "mt-3" not in orchestrator.state.running


@pytest.mark.asyncio
async def test_tick_waits_when_all_ssh_hosts_are_saturated(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-2" not in orchestrator.state.running
    assert "mt-2" not in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_todo_issue_with_non_terminal_blocker_is_not_dispatched(tmp_path: Path) -> None:
    blocked = issue(
        "MT-1",
        blocked_by=[BlockerRef(id="dep", identifier="MT-0", state="In Progress")],
    )
    tracker = FakeTracker(candidates=[blocked])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []


@pytest.mark.asyncio
async def test_todo_issue_with_terminal_blocker_is_dispatched(tmp_path: Path) -> None:
    blocked = issue(
        "MT-1",
        blocked_by=[BlockerRef(id="dep", identifier="MT-0", state="Done")],
    )
    tracker = FakeTracker(candidates=[blocked])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]


@pytest.mark.asyncio
async def test_worker_failure_schedules_exponential_retry(tmp_path: Path) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert retry.attempt == 1
    assert retry.error == "worker exited: boom"
    assert retry.due_at_ms > 0
    assert "mt-1" in orchestrator.state.claimed
    assert tracker.lifecycle_labels[-1] == ("mt-1", "symphony:retrying")
    assert retry.phase == "retrying"
    assert retry.status_label == "symphony:retrying"


@pytest.mark.asyncio
async def test_worker_failure_comments_on_linear_issue(tmp_path: Path) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert len(tracker.comments) == 1
    issue_id, body = tracker.comments[0]
    assert issue_id == "mt-1"
    assert "MT-1" in body
    assert "worker exited: boom" in body
    assert "retry" in body.lower()


@pytest.mark.asyncio
async def test_retrying_issue_is_not_dispatched_by_normal_candidate_scan(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)

    await orchestrator.tick()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_future_monotonic_retry_is_not_dispatched_when_wall_clock_due_at_is_past(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)
    orchestrator.state.retry_attempts["mt-1"].due_at = utc_now() - timedelta(seconds=60)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_worker_failure_is_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "symphony_worker outcome=failed" in caplog.text
    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "reason=boom" in caplog.text


@pytest.mark.asyncio
async def test_worker_lifecycle_logs_include_issue_and_session_context(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "session_id=thread-1-turn-1" in caplog.text
    assert "outcome=completed" in caplog.text


@pytest.mark.asyncio
async def test_normal_worker_exit_schedules_continuation_for_still_active_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.claimed
    assert retry.attempt == 1
    assert retry.error is None


@pytest.mark.asyncio
async def test_normal_worker_exit_records_completed_bookkeeping_for_terminal_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.refreshed = [issue("MT-1", state="Done")]
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "mt-1" in orchestrator.state.completed
    assert "mt-1" not in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert ("mt-1", "symphony:done") in tracker.lifecycle_labels


@pytest.mark.asyncio
async def test_completion_verification_failure_retries_instead_of_marking_done(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(
        make_config_with_completion_verification(tmp_path, required_checks=["workspace_changes"]),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed
    assert tracker.lifecycle_labels[-1] == ("mt-1", "symphony:retrying")
    assert tracker.comments[-1][0] == "mt-1"
    assert "Verification failed after agent claimed success." in tracker.comments[-1][1]
    assert "workspace_changes" in tracker.comments[-1][1]


@pytest.mark.asyncio
async def test_completion_verification_needs_human_does_not_mark_done(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.refreshed = [
        issue(
            "MT-1",
            blocked_by=[BlockerRef(id="dep-1", identifier="MT-0", state="In Progress")],
        )
    ]
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / "README.md").write_text("changed\n", encoding="utf-8")
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(
        make_config_with_completion_verification(
            tmp_path,
            required_checks=[],
            optional_checks=["linear_state"],
            auto_retry_on_fail=True,
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.claimed
    assert tracker.lifecycle_labels[-1] != ("mt-1", "symphony:done")
    assert tracker.comments[-1][0] == "mt-1"
    assert "human review is required" in tracker.comments[-1][1].lower()


@pytest.mark.asyncio
async def test_retry_prompt_includes_previous_verification_failure_reason(tmp_path: Path) -> None:
    from symphony.runner import AgentRunner
    from symphony.workspace import WorkspaceManager

    class CapturingCodexClient:
        def __init__(self) -> None:
            self.prompts: list[str] = []

        async def run_session(self, workspace_path, prompt, title, **kwargs):
            self.prompts.append(prompt)

    class NoopTracker:
        async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
            return [issue("MT-1")]

    config = make_config(tmp_path)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    codex_client = CapturingCodexClient()
    runner = AgentRunner(config, workspace_manager, codex_client=codex_client, tracker=NoopTracker())

    issue_payload = issue("MT-1")
    issue_payload.description = "Previous attempt failed verification: workspace_changes"

    await runner.run_issue(issue_payload, 2, lambda event: None)

    assert "Previous attempt failed verification:" in codex_client.prompts[0]
    assert "workspace_changes" in codex_client.prompts[0]


@pytest.mark.asyncio
async def test_codex_event_updates_session_and_token_totals(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "codex_app_server_pid": 123,
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "thread_token_usage_updated",
            "session_id": "thread-1-turn-1",
            "payload": {
                "total_token_usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "total_tokens": 140,
                }
            },
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "thread_token_usage_updated",
            "session_id": "thread-1-turn-1",
            "payload": {
                "total_token_usage": {
                    "input_tokens": 130,
                    "output_tokens": 50,
                    "cached_tokens": 20,
                    "total_tokens": 180,
                }
            },
        },
    )

    entry = orchestrator.state.running["mt-1"]
    assert entry.session_id == "thread-1-turn-1"
    assert entry.thread_id == "thread-1"
    assert entry.turn_id == "turn-1"
    assert entry.codex_app_server_pid == 123
    assert entry.tokens.input_tokens == 130
    assert entry.tokens.output_tokens == 50
    assert entry.tokens.cached_tokens == 20
    assert entry.tokens.total_tokens == 180
    assert entry.recent_events[-1]["event"] == "thread_token_usage_updated"
    assert entry.recent_events[-1]["usage"] == {
        "input_tokens": 130,
        "output_tokens": 50,
        "cached_tokens": 20,
        "total_tokens": 180,
    }
    assert entry.recent_events[-1]["raw_event"]["payload"]["total_token_usage"]["total_tokens"] == 180
    assert orchestrator.state.codex_totals.input_tokens == 130
    assert orchestrator.state.codex_totals.output_tokens == 50
    assert orchestrator.state.codex_totals.total_tokens == 180


@pytest.mark.asyncio
async def test_codex_events_are_logged_with_issue_context(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/agentMessage/delta",
            "message": "working",
        },
    )

    assert "symphony_codex_event" in caplog.text
    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "event=notification" in caplog.text
    assert "raw_method=item/agentMessage/delta" in caplog.text
    assert "message=working" in caplog.text


@pytest.mark.asyncio
async def test_low_value_codex_events_do_not_overwrite_last_useful_message(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/completed",
            "message": "189 passed, 1 skipped",
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/commandExecution/outputDelta",
            "message": ".",
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/started",
        },
    )

    assert orchestrator.state.running["mt-1"].last_codex_message == "189 passed, 1 skipped"


@pytest.mark.asyncio
async def test_command_execution_events_capture_command_and_exit_code_in_recent_events(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/commandExecution/started",
            "payload": {"command": "pytest tests/test_target.py::test_fix -q"},
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/completed",
            "payload": {"exit_code": 0, "command": "pytest tests/test_target.py::test_fix -q"},
            "message": "1 passed",
        },
    )

    recent = orchestrator.state.running["mt-1"].recent_events
    assert recent[-2]["command"] == "pytest tests/test_target.py::test_fix -q"
    assert recent[-1]["command"] == "pytest tests/test_target.py::test_fix -q"
    assert recent[-1]["exit_code"] == 0


@pytest.mark.asyncio
async def test_request_timeout_updates_last_message_with_readable_error(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "request_timeout",
            "method": "initialize",
            "timeout_ms": 500,
        },
    )

    assert orchestrator.state.running["mt-1"].last_codex_message == "initialize timed out"
    assert orchestrator.state.running["mt-1"].phase == "error"
    assert orchestrator.state.running["mt-1"].status_label == "symphony:failed"


@pytest.mark.asyncio
async def test_orchestrator_persists_retry_and_session_metadata(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "symphony.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)

    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)
    loaded = store.load()

    assert loaded.retry_attempts[0].issue_id == "mt-1"
    assert loaded.retry_attempts[0].attempt == 2

    tracker.candidates = [issue("MT-2")]
    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-2",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    loaded = store.load()

    assert loaded.sessions[0].issue_id == "mt-2"
    assert loaded.sessions[0].session_id == "thread-1-turn-1"


def test_orchestrator_loads_persisted_retries(tmp_path: Path) -> None:
    store = PersistenceStore(tmp_path / "state" / "symphony.json")
    first = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    first._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)

    second = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    second.load_persisted_state()

    assert "mt-1" in second.state.retry_attempts
    assert "mt-1" in second.state.claimed
    assert second.state.retry_attempts["mt-1"].attempt == 2


@pytest.mark.asyncio
async def test_reconcile_terminal_running_issue_cancels_and_releases(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="Done")]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_active_state_refresh_updates_running_entry_state(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="In Progress")]

    await orchestrator.reconcile_running()

    assert orchestrator.state.running["mt-1"].issue.state == "In Progress"


@pytest.mark.asyncio
async def test_reconcile_with_no_running_issues_is_noop(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.reconcile_running()

    assert orchestrator.state.running == {}


@pytest.mark.asyncio
async def test_reconcile_terminal_running_issue_cleans_workspace(tmp_path: Path) -> None:
    from symphony.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, workspace_manager=workspace_manager)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="Done")]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert not workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_reconcile_active_issue_that_loses_required_label_stops_without_cleanup(tmp_path: Path) -> None:
    from symphony.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", labels=[])]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_reconcile_missing_refreshed_issue_stops_without_cleanup(tmp_path: Path) -> None:
    from symphony.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, workspace_manager=workspace_manager)
    await orchestrator.tick()
    tracker.refreshed = []

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_reconcile_refresh_failure_keeps_workers_running(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.fail_refresh = True

    await orchestrator.reconcile_running()

    assert "mt-1" in orchestrator.state.running
    assert "symphony_reconcile failed" in caplog.text
    assert "reason=refresh unavailable" in caplog.text


@pytest.mark.asyncio
async def test_startup_cleanup_failure_logs_warning_and_continues(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    from symphony.workspace import WorkspaceManager

    tracker = FakeTracker()
    tracker.fail_by_states = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    workspace_manager = WorkspaceManager(orchestrator.config.workspace, orchestrator.config.hooks)

    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)

    assert "symphony_startup_cleanup failed" in caplog.text
    assert "reason=linear unavailable" in caplog.text


@pytest.mark.asyncio
async def test_stall_detection_cancels_and_retries(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    entry = orchestrator.state.running["mt-1"]
    entry.started_at = utc_now() - timedelta(seconds=10)

    await orchestrator.reconcile_running()

    assert "mt-1" in orchestrator.state.retry_attempts


@pytest.mark.asyncio
async def test_stall_detection_comments_on_linear_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    entry = orchestrator.state.running["mt-1"]
    entry.started_at = utc_now() - timedelta(seconds=10)

    await orchestrator.reconcile_running()

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "mt-1"
    assert "stalled" in tracker.comments[0][1]


@pytest.mark.asyncio
async def test_due_retry_dispatches_when_issue_is_still_candidate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == [(tracker.candidates[0], 2)]
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_due_retry_releases_claim_when_issue_is_no_longer_candidate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", labels=[])])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_due_retry_requeues_when_slots_are_unavailable(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path, max_concurrent=0), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert runner.started == []
    assert retry.attempt == 3
    assert retry.error == "no available orchestrator slots"
    assert retry.due_at_ms > 0
    assert "mt-1" in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_due_retry_candidate_fetch_failure_keeps_retry(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)
    tracker.fail_candidates = True

    await orchestrator.process_due_retries()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert retry.attempt == 3
    assert retry.error == "retry poll failed"
    assert "mt-1" in orchestrator.state.claimed
    assert runner.started == []
    assert "symphony_retry failed" in caplog.text
    assert "reason=candidate unavailable" in caplog.text


@pytest.mark.asyncio
async def test_startup_cleanup_removes_terminal_workspaces(tmp_path: Path) -> None:
    from symphony.workspace import WorkspaceManager

    tracker = FakeTracker()
    tracker.by_states = [issue("MT-1", state="Done")]
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    workspace_manager = WorkspaceManager(orchestrator.config.workspace, orchestrator.config.hooks)
    workspace = await workspace_manager.create_for_issue("MT-1")

    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)

    assert not workspace.path.exists()
