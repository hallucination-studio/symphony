from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from performer_api.config import (
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    ObservabilityConfig,
    PersistenceConfig,
    WorkspaceConfig,
)
from performer_api.models import (
    BlockedEntry,
    ContinuationEntry,
    HumanInterventionEntry,
    Issue,
    RetryEntry,
    RunningEntry,
    RuntimeTokens,
    utc_now,
)
from performer.orchestrator import OrchestratorState
from performer.snapshot import build_runtime_snapshot, build_issue_snapshot


def make_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=tmp_path / "workspaces"),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=3),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


def test_runtime_snapshot_includes_running_retry_totals_and_rate_limits(tmp_path: Path) -> None:
    started_at = utc_now() - timedelta(seconds=10)
    last_event_at = utc_now() - timedelta(seconds=2)
    issue = Issue(
        id="issue-1",
        identifier="MT-1",
        title="Build",
        state="In Progress",
        labels=["codex"],
        url="https://linear.app/x/issue/MT-1",
        project_slug="MT",
    )
    retry_issue = Issue(
        id="issue-2",
        identifier="MT-2",
        title="Retry",
        state="Todo",
        labels=["codex"],
        url="https://linear.app/x/issue/MT-2",
        project_slug="MT",
    )
    continuation_issue = Issue(
        id="issue-3",
        identifier="MT-3",
        title="Continue",
        state="Todo",
        labels=["codex"],
        url="https://linear.app/x/issue/MT-3",
        project_slug="MT",
    )
    state = OrchestratorState(
        running={
            issue.id: RunningEntry(
                issue=issue,
                task=None,
                started_at=started_at,
                retry_attempt=1,
                session_id="thread-1-turn-1",
                thread_id="thread-1",
                turn_id="turn-1",
                last_codex_event="turn_completed",
                last_codex_timestamp=last_event_at,
                last_codex_message="done",
                last_raw_codex_message="turn/completed",
                phase="running",
                status_label="performer:phase/implementation",
                workspace_path=str(tmp_path / "workspaces" / "MT-1"),
                recent_events=[
                    {
                        "at": "2026-06-30T00:00:00Z",
                        "event": "turn_completed",
                        "message": "done",
                        "raw_method": "turn/completed",
                        "raw_event": {
                            "event": "turn_completed",
                            "raw_method": "turn/completed",
                            "payload": {"status": "completed"},
                        },
                    }
                ],
                tokens=RuntimeTokens(input_tokens=100, output_tokens=40, total_tokens=140),
                turn_count=2,
            )
        },
        retry_attempts={
            retry_issue.id: RetryEntry(
                issue_id=retry_issue.id,
                identifier=retry_issue.identifier,
                attempt=3,
                due_at=utc_now() + timedelta(seconds=30),
                due_at_ms=123456,
                error="no available orchestrator slots",
                issue_url=retry_issue.url,
                phase="retrying",
                status_label="performer:phase/implementation",
            )
        },
        continuations={
            continuation_issue.id: ContinuationEntry(
                issue_id=continuation_issue.id,
                identifier=continuation_issue.identifier,
                attempt=4,
                due_at=utc_now() + timedelta(seconds=45),
                due_at_ms=234567,
                issue_url=continuation_issue.url,
                last_message="max turns reached; continuing",
            )
        },
        codex_totals=RuntimeTokens(input_tokens=500, output_tokens=200, total_tokens=700),
        codex_rate_limits={"primary": {"remaining": 10}},
        ended_runtime_seconds=15,
    )

    snapshot = build_runtime_snapshot(make_config(tmp_path), state)

    assert snapshot["counts"] == {
        "running": 1,
        "retrying": 1,
        "continuing": 1,
        "blocked": 0,
        "pending_human": 0,
    }
    assert snapshot["running"][0]["issue_id"] == "issue-1"
    assert snapshot["running"][0]["issue_identifier"] == "MT-1"
    assert snapshot["running"][0]["issue_url"] == "https://linear.app/x/issue/MT-1"
    assert snapshot["running"][0]["state"] == "In Progress"
    assert snapshot["running"][0]["session_id"] == "thread-1-turn-1"
    assert snapshot["running"][0]["thread_id"] == "thread-1"
    assert snapshot["running"][0]["turn_id"] == "turn-1"
    assert snapshot["running"][0]["turn_count"] == 2
    assert snapshot["running"][0]["phase"] == "running"
    assert snapshot["running"][0]["status_label"] == "performer:phase/implementation"
    assert snapshot["running"][0]["workspace_path"] == str(tmp_path / "workspaces" / "MT-1")
    assert snapshot["running"][0]["last_event"] == "turn_completed"
    assert snapshot["running"][0]["last_message"] == "done"
    assert snapshot["running"][0]["last_raw_message"] == "turn/completed"
    assert snapshot["running"][0]["tokens"] == {
        "input_tokens": 100,
        "output_tokens": 40,
        "total_tokens": 140,
    }
    assert snapshot["running"][0]["recent_events"][0]["raw_event"]["payload"]["status"] == "completed"
    assert snapshot["retrying"][0]["issue_id"] == "issue-2"
    assert snapshot["retrying"][0]["issue_identifier"] == "MT-2"
    assert snapshot["retrying"][0]["issue_url"] == "https://linear.app/x/issue/MT-2"
    assert snapshot["retrying"][0]["attempt"] == 3
    assert snapshot["retrying"][0]["due_at_ms"] == 123456
    assert snapshot["retrying"][0]["error"] == "no available orchestrator slots"
    assert snapshot["retrying"][0]["phase"] == "retrying"
    assert snapshot["retrying"][0]["status_label"] == "performer:phase/implementation"
    assert snapshot["continuing"][0]["issue_id"] == "issue-3"
    assert snapshot["continuing"][0]["issue_identifier"] == "MT-3"
    assert snapshot["continuing"][0]["attempt"] == 4
    assert snapshot["continuing"][0]["phase"] == "continuing"
    assert snapshot["continuing"][0]["status_label"] == "performer:phase/implementation"
    assert snapshot["issues"][-1]["issue_identifier"] == "MT-3"
    assert snapshot["codex_totals"]["input_tokens"] == 500
    assert snapshot["codex_totals"]["output_tokens"] == 200
    assert snapshot["codex_totals"]["total_tokens"] == 700
    assert snapshot["codex_totals"]["seconds_running"] >= 24
    assert snapshot["rate_limits"] == {"primary": {"remaining": 10}}


def test_runtime_snapshot_includes_pending_human_interventions(tmp_path: Path) -> None:
    state = OrchestratorState(
        human_interventions={
            "issue-1": HumanInterventionEntry(
                issue_id="issue-1",
                identifier="MT-1",
                child_issue_id="issue-1h",
                child_identifier="MT-H1",
                child_url="https://linear.app/x/issue/MT-H1",
                kind="runtime_permission",
                attempt=1,
                created_at=utc_now(),
                error="runtime_permission_blocked: approval required",
                questions=[],
                resume_strategy="retry",
                issue_url="https://linear.app/x/issue/MT-1",
                last_message="approval required",
            )
        }
    )

    snapshot = build_runtime_snapshot(make_config(tmp_path), state)
    detail = build_issue_snapshot(make_config(tmp_path), state, "MT-1")

    assert snapshot["counts"] == {
        "running": 0,
        "retrying": 0,
        "continuing": 0,
        "blocked": 0,
        "pending_human": 1,
    }
    assert snapshot["human_interventions"][0]["child_url"] == "https://linear.app/x/issue/MT-H1"
    assert snapshot["issues"][0]["kind"] == "runtime_permission"
    assert detail is not None
    assert detail["status"] == "pending_human"
    assert detail["human_intervention"]["child_identifier"] == "MT-H1"
    assert detail["last_error"] is None


def test_runtime_snapshot_includes_observability_and_persistence_config(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        observability=ObservabilityConfig(enabled=True, host="127.0.0.2", allow_refresh=False),
        persistence=PersistenceConfig(path=tmp_path / "state.json"),
    )

    snapshot = build_runtime_snapshot(config, OrchestratorState())

    assert snapshot["config"]["observability"] == {
        "enabled": True,
        "host": "127.0.0.2",
        "allow_refresh": False,
    }
    assert snapshot["config"]["persistence"] == {
        "enabled": True,
        "path": str(tmp_path / "state.json"),
    }


def test_issue_snapshot_returns_running_workspace_and_attempt_details(tmp_path: Path) -> None:
    issue = Issue(
        id="issue-1",
        identifier="MT-1",
        title="Build",
        state="In Progress",
        labels=["codex"],
        project_slug="MT",
    )
    state = OrchestratorState(
        running={
            issue.id: RunningEntry(
                issue=issue,
                task=None,
                started_at=utc_now(),
                retry_attempt=2,
                session_id="thread-1-turn-1",
                thread_id="thread-1",
                turn_id="turn-1",
                last_codex_event="notification",
                last_codex_message="Working",
                phase="running",
                status_label="performer:phase/implementation",
                workspace_path=str(tmp_path / "workspaces" / "MT-1"),
                recent_events=[
                    {
                        "at": "2026-06-30T00:00:00Z",
                        "event": "notification",
                        "message": "Working",
                        "raw_method": "agent/message",
                        "raw_event": {"event": "notification", "raw_method": "agent/message"},
                    }
                ],
                tokens=RuntimeTokens(input_tokens=10, output_tokens=5, total_tokens=15),
                turn_count=4,
            )
        }
    )

    detail = build_issue_snapshot(make_config(tmp_path), state, "MT-1")

    assert detail is not None
    assert detail["issue_identifier"] == "MT-1"
    assert detail["issue_id"] == "issue-1"
    assert detail["status"] == "running"
    assert detail["phase"] == "running"
    assert detail["status_label"] == "performer:phase/implementation"
    assert detail["workspace"]["path"] == str((tmp_path / "workspaces" / "MT-1").resolve())
    assert detail["attempts"]["current_retry_attempt"] == 2
    assert detail["running"]["session_id"] == "thread-1-turn-1"
    assert detail["running"]["thread_id"] == "thread-1"
    assert detail["running"]["turn_id"] == "turn-1"
    assert detail["running"]["turn_count"] == 4
    assert detail["running"]["tokens"]["total_tokens"] == 15
    assert detail["recent_events"][0]["raw_event"]["raw_method"] == "agent/message"


def test_issue_snapshot_returns_continuation_details(tmp_path: Path) -> None:
    state = OrchestratorState(
        continuations={
            "issue-1": ContinuationEntry(
                issue_id="issue-1",
                identifier="MT-1",
                attempt=2,
                due_at=utc_now() + timedelta(seconds=30),
                due_at_ms=123456,
                issue_url="https://linear.app/x/issue/MT-1",
                last_message="continuing",
            )
        }
    )

    detail = build_issue_snapshot(make_config(tmp_path), state, "MT-1")

    assert detail is not None
    assert detail["status"] == "continuing"
    assert detail["phase"] == "continuing"
    assert detail["status_label"] == "performer:phase/implementation"
    assert detail["attempts"]["current_retry_attempt"] == 2
    assert detail["retry"] is None
    assert detail["continuation"]["last_message"] == "continuing"
    assert detail["last_error"] is None


def test_issue_snapshot_returns_blocked_runtime_error_details(tmp_path: Path) -> None:
    state = OrchestratorState(
        blocked={
            "issue-1": BlockedEntry(
                issue_id="issue-1",
                identifier="MT-1",
                attempt=2,
                blocked_at=utc_now(),
                error="runtime_permission_blocked: writing outside of the project",
                issue_url="https://linear.app/x/issue/MT-1",
                last_message="writing outside of the project",
            )
        }
    )

    detail = build_issue_snapshot(make_config(tmp_path), state, "MT-1")

    assert detail is not None
    assert detail["status"] == "blocked"
    assert detail["phase"] == "error"
    assert detail["status_label"] == "performer:phase/blocked"
    assert detail["attempts"]["current_retry_attempt"] == 2
    assert detail["blocked"]["last_message"] == "writing outside of the project"
    assert detail["last_error"] == "runtime_permission_blocked: writing outside of the project"


def test_issue_snapshot_returns_none_for_unknown_issue(tmp_path: Path) -> None:
    assert build_issue_snapshot(make_config(tmp_path), OrchestratorState(), "MT-404") is None
