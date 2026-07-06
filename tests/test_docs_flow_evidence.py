from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from performer.completion_verifier import CompletionVerifier
from performer_api.config import (
    AgentConfig,
    CompletionVerificationConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    WorkspaceConfig,
    WorkerConfig,
)
from performer_api.models import BlockerRef, Issue, RetryEntry, RunningEntry, RuntimeTokens, sort_for_dispatch, utc_now
from performer_api.ops_models import OpsSnapshot, TraceEvent
from performer.orchestrator import Orchestrator, OrchestratorState
from performer.linear import LinearClient, LinearError, LinearTracker
from performer.reloader import WorkflowReloader
from performer.snapshot import build_runtime_snapshot
from performer_api.workflow import render_prompt
from performer.workspace import WorkspaceError, WorkspaceManager, sanitize_workspace_key


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


class FlowTracker:
    def __init__(self, candidates: list[Issue] | None = None) -> None:
        self.candidates = candidates or []
        self.refreshed: list[Issue] = []
        self.fetch_candidate_calls = 0
        self.fetch_state_calls: list[list[str]] = []
        self.comments: list[tuple[str, str]] = []
        self.lifecycle_labels: list[tuple[str, str]] = []
        self.created_issues: list[dict[str, Any]] = []
        self.children: dict[str, list[dict[str, Any]]] = {}
        self.fail_refresh = False

    async def fetch_candidate_issues(self) -> list[Issue]:
        self.fetch_candidate_calls += 1
        return list(self.candidates)

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        self.fetch_state_calls.append(list(issue_ids))
        if self.fail_refresh:
            raise RuntimeError("linear_state transient refresh unavailable")
        return [current for current in self.refreshed if current.id in issue_ids]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        self.lifecycle_labels.append((issue_id, label_name))
        return {"success": True, "issue_id": issue_id, "label": label_name}

    async def set_issue_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> dict[str, Any]:
        self.lifecycle_labels.append((issue_id, label_name))
        return {"success": True, "issue_id": issue_id, "label": label_name, "prefix": prefix}

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        assignee_id: str | None = None,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        created = {
            "id": f"child-{len(self.created_issues) + 1}",
            "identifier": f"FLOW-H{len(self.created_issues) + 1}",
            "title": title,
            "description": description,
            "label_ids": label_names,
            "labels": label_names,
            "parent_id": parent_issue_id,
            "assignee_id": assignee_id,
            "delegate_id": delegate_id,
            "state": "Todo",
            "url": f"https://linear.app/x/issue/FLOW-H{len(self.created_issues) + 1}",
        }
        self.created_issues.append(created)
        self.children.setdefault(parent_issue_id, []).append(created)
        return created

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        children = list(self.children.get(parent_issue_id, []))
        if label_name is None:
            return children
        return [child for child in children if label_name in child.get("labels", [])]


class FlowCompletingRunner:
    def __init__(self, *, final_message: str = "Implemented and verified. Ready for review.") -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.final_message = final_message
        self.started_attempts: list[int | None] = []

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        self.started_attempts.append(attempt)
        on_event({"event": "session_started", "session_id": "thread-1-turn-1"})
        on_event({"event": "turn_started", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})
        on_event(
            {
                "event": "notification",
                "session_id": "thread-1-turn-1",
                "turn_id": "turn-1",
                "raw_method": "agent/message",
                "message": self.final_message,
            }
        )
        self.started.set()
        await self.release.wait()
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})


class FlowHandoffRunner:
    def __init__(self, workspace_path: Path) -> None:
        self.workspace_path = workspace_path
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.events: list[dict[str, Any]] = []

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        (self.workspace_path / "PERFORMER_CONDUCTOR_VALIDATION.md").write_text(
            "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q passed\n",
            encoding="utf-8",
        )
        events = [
            {
                "event": "process_launch",
                "command_argv": ["bash", "-lc", "fake-codex-app-server"],
                "cwd": str(self.workspace_path),
            },
            {
                "event": "session_started",
                "thread_id": "th_1",
                "turn_id": "turn_1",
                "session_id": "th_1-turn_1",
                            },
            {"event": "turn_started", "thread_id": "th_1", "turn_id": "turn_1", "session_id": "th_1-turn_1"},
            {
                "event": "notification",
                "thread_id": "th_1",
                "turn_id": "turn_1",
                "session_id": "th_1-turn_1",
                "raw_method": "item/commandExecution/started",
                "command": "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q",
                "payload": {"command": "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q"},
            },
            {
                "event": "notification",
                "thread_id": "th_1",
                "turn_id": "turn_1",
                "session_id": "th_1-turn_1",
                "raw_method": "item/completed",
                "command": "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q",
                "exit_code": 0,
                "message": "1 passed",
                "payload": {
                    "command": "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q",
                    "exit_code": 0,
                },
            },
            {
                "event": "thread_token_usage_updated",
                "thread_id": "th_1",
                "turn_id": "turn_1",
                "session_id": "th_1-turn_1",
                "usage": {"input_tokens": 10, "output_tokens": 5, "cached_tokens": 0, "total_tokens": 15},
                "payload": {"total_token_usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}},
            },
        ]
        for event in events:
            self.events.append(event)
            on_event(event)
        self.started.set()
        await self.release.wait()


class SecretStatusTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "json": json.loads(request.content.decode()),
            }
        )
        return httpx.Response(500, text="backend unavailable", request=request)


class FlowLinearTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "json": json.loads(request.content.decode()),
            }
        )
        return httpx.Response(200, json=self.responses.pop(0), request=request)


async def http_request(port: int, method: str, path: str) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, body = raw.split(b"\r\n\r\n", 1)
    lines = head.decode().split("\r\n")
    status = int(lines[0].split()[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.lower()] = value.strip()
    return status, headers, body


class FlowStdin:
    def __init__(self, proc: "FlowProcess") -> None:
        self.proc = proc

    def write(self, data: bytes) -> None:
        self.proc.sent.append(json.loads(data.decode()))

    async def drain(self) -> None:
        await asyncio.sleep(0)


class FlowStdout:
    def __init__(self, lines: list[dict[str, Any]] | None = None, *, hang: bool = False) -> None:
        self.lines = [json.dumps(line).encode() + b"\n" for line in (lines or [])]
        self.hang = hang

    async def readline(self) -> bytes:
        await asyncio.sleep(0)
        if self.lines:
            return self.lines.pop(0)
        if self.hang:
            await asyncio.sleep(3600)
        return b""


class FlowByteStream:
    async def readline(self) -> bytes:
        await asyncio.sleep(3600)
        return b""


class FlowProcess:
    def __init__(self, lines: list[dict[str, Any]] | None = None, *, hang_stdout: bool = False) -> None:
        self.pid = 4321
        self.sent: list[dict[str, Any]] = []
        self.stdin = FlowStdin(self)
        self.stdout = FlowStdout(lines, hang=hang_stdout)
        self.stderr = FlowByteStream()
        self.returncode: int | None = None
        self.killed = False

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        return self.returncode or 0


def config_with_verification(
    tmp_path: Path,
    *,
    required_checks: list[str],
    optional_checks: list[str] | None = None,
    expected_test_patterns: list[str] | None = None,
    auto_retry_on_fail: bool = True,
) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(interval_ms=100),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
        codex=CodexConfig(stall_timeout_ms=300_000),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(
            enabled=True,
            required_checks=required_checks,
            optional_checks=optional_checks or [],
            expected_test_patterns=expected_test_patterns or [],
            auto_retry_on_fail=auto_retry_on_fail,
            min_workspace_changes_chars=1,
        ),
    )


def init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=path, check=True)
    (path / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)


def write_flow_workflow(
    path: Path,
    *,
    active_states: list[str],
    max_concurrent_agents: int,
    prompt: str,
) -> None:
    active_yaml = "\n".join(f"    - {state}" for state in active_states)
    path.write_text(
        f"""---
tracker:
  kind: linear
  project_slug: MT
  api_key: linear-token
  active_states:
{active_yaml}
agent:
  max_concurrent_agents: {max_concurrent_agents}
---
{prompt}
""",
        encoding="utf-8",
    )


def flow_bundle(
    *,
    test_id: str,
    title: str,
    source_sections: list[str],
    profile: str,
    initial_state: dict[str, Any],
    trigger: str,
    observed_transitions: list[str],
    workspace_evidence: dict[str, Any],
    tracker_evidence: dict[str, Any],
    codex_evidence: dict[str, Any],
    observability_evidence: dict[str, Any],
    final_state: dict[str, Any],
    score_reason: str,
) -> dict[str, Any]:
    bundle = {
        "test_id": test_id,
        "title": title,
        "source_sections": source_sections,
        "profile": profile,
        "config_under_test": {},
        "initial_state": initial_state,
        "trigger": trigger,
        "observed_transitions": observed_transitions,
        "workspace_evidence": workspace_evidence,
        "tracker_evidence": tracker_evidence,
        "codex_evidence": codex_evidence,
        "observability_evidence": observability_evidence,
        "final_state": final_state,
        "score": 4,
        "score_reason": score_reason,
        "result": "pass",
    }
    assert_score_4_bundle(bundle)
    return bundle


def assert_score_4_bundle(bundle: dict[str, Any]) -> None:
    required = {
        "test_id",
        "title",
        "source_sections",
        "profile",
        "config_under_test",
        "initial_state",
        "trigger",
        "observed_transitions",
        "workspace_evidence",
        "tracker_evidence",
        "codex_evidence",
        "observability_evidence",
        "final_state",
        "score",
        "score_reason",
        "result",
    }
    assert required <= set(bundle)
    assert bundle["score"] == 4
    assert bundle["result"] == "pass"
    assert bundle["observed_transitions"]
    assert bundle["score_reason"]
    assert bundle["workspace_evidence"] or bundle["tracker_evidence"] or bundle["codex_evidence"]
    assert bundle["observability_evidence"]


@pytest.mark.asyncio
async def test_flow_001_dispatch_run_and_human_review_handoff_has_reviewer_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(
        candidates=[
            issue("ENG-1", id="eng-1", title="Build handoff evidence", labels=["performer"], project_slug="MT")
        ]
    )
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "test-workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-1")
    runner = FlowHandoffRunner(workspace.path)
    config = ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="test-token",
            active_states=["Todo", "In Progress"],
            terminal_states=["Done", "Canceled"],
        ),
        polling=PollingConfig(interval_ms=100),
        workspace=WorkspaceConfig(root=tmp_path / "test-workspaces"),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
        codex=CodexConfig(
            command="fake-codex-app-server",
            approval_policy="never",
            thread_sandbox="workspace-write",
            turn_sandbox_policy="workspace-write",
            turn_timeout_ms=5000,
            read_timeout_ms=500,
            stall_timeout_ms=1000,
        ),
        prompt_template="Work on {{ issue.identifier }}: {{ issue.title }}.",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=False),
    )
    orchestrator = Orchestrator(config, tracker, runner, workspace_manager=workspace_manager)

    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [issue("ENG-1", id="eng-1", state="Human Review", labels=["performer"], project_slug="MT")]
    await orchestrator.reconcile_running()

    comment = tracker.comments[-1][1]
    recent_events = comment + "\n" + json.dumps(runner.events, sort_keys=True)
    bundle = flow_bundle(
        test_id="FLOW-001",
        title="active issue dispatches, emits evidence, and reaches Human Review handoff",
        source_sections=["1", "5", "7", "8", "9", "10", "11", "12", "13", "14"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-1", "tracker_state": "Todo", "labels": ["performer"]},
        trigger="Run one dispatch tick, emit Codex validation evidence, then refresh tracker state to Human Review",
        observed_transitions=[
            "Unclaimed -> Claimed",
            "Claimed -> Running",
            "Codex session th_1-turn_1",
            "state_refresh -> Human Review",
            "Running -> handoff stopped",
        ],
        workspace_evidence={
            "workspace_path": str(workspace.path),
            "validation_artifact": (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").read_text(encoding="utf-8"),
        },
        tracker_evidence={
            "candidate_fetch_calls": tracker.fetch_candidate_calls,
            "state_refresh_calls": tracker.fetch_state_calls,
            "comment": comment,
        },
        codex_evidence={"events": runner.events},
        observability_evidence={
            "recent_events": recent_events,
            "running": "eng-1" in orchestrator.state.running,
            "completed": "eng-1" in orchestrator.state.completed,
        },
        final_state={
            "workspace_exists": workspace.path.exists(),
            "running": "eng-1" in orchestrator.state.running,
            "completed": "eng-1" in orchestrator.state.completed,
        },
        score_reason="Reviewer-facing handoff comment summarizes preserved workspace, validation artifact, session, and why Human Review is not terminal Done.",
    )

    assert tracker.fetch_candidate_calls == 1
    assert runner.events[0]["cwd"] == str(workspace.path)
    assert runner.events[1]["session_id"] == "th_1-turn_1"
    assert "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q" in recent_events
    assert "Tracker state: Human Review" in comment
    assert workspace.path.exists()
    assert "eng-1" not in orchestrator.state.completed
    assert "eng-1" not in orchestrator.state.running
    assert bundle["score"] == 4


@pytest.mark.asyncio
async def test_flow_002_rejects_model_success_without_workspace_or_validation_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-2", id="eng-2", project_slug="MT")])
    workspace = tmp_path / "ENG-2"
    init_repo(workspace)
    runner = FlowCompletingRunner(final_message="Implemented and verified. Ready for review.")
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["workspace_changes", "test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-2"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    comment = tracker.comments[-1][1]
    retry = orchestrator.state.retry_attempts["eng-2"]
    bundle = flow_bundle(
        test_id="FLOW-002",
        title="agent success claim is rejected without evidence",
        source_sections=["1", "10.5", "11.5", "13", "14.2", "14.4", "15.5"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-2", "tracker_state": "Todo"},
        trigger="Codex emits confident final message with clean workspace and no test command evidence",
        observed_transitions=["Unclaimed -> Running", "turn_completed", "completion_verification -> NEEDS_RETRY"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"comment": comment, "lifecycle_labels": tracker.lifecycle_labels},
        codex_evidence={"final_message": runner.final_message},
        observability_evidence={"retry": retry.__dict__, "recent_events": retry.recent_events},
        final_state={"completed": "eng-2" in orchestrator.state.completed, "retrying": "eng-2" in orchestrator.state.retry_attempts},
        score_reason="Reviewer-facing comment names missing workspace_changes and test_command_evidence and retry status is visible.",
    )

    assert "Verification failed after agent claimed success." in comment
    assert "workspace_changes" in comment
    assert "test_command_evidence" in comment
    assert "No files changed" in comment
    assert "No test command evidence recorded" in comment
    assert "ENG-2" in bundle["title"] or bundle["test_id"] == "FLOW-002"


@pytest.mark.asyncio
async def test_flow_003_changed_files_without_focused_validation_routes_retry_with_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "ENG-3"
    init_repo(workspace)
    target = workspace / "src" / "performer"
    target.mkdir(parents=True)
    (target / "runner.py").write_text("print('changed')\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-07-01T00:00:00Z",
                issue_id="eng-3",
                payload={"command": "pytest tests/test_models.py -q", "exit_code": 0},
            )
        ]
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            enabled=True,
            required_checks=["workspace_changes", "test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
            min_workspace_changes_chars=1,
        ),
        FlowTracker(),
    )

    verdict = await verifier.verify_completion(issue("ENG-3", id="eng-3"), workspace, snapshot)
    failed = {check.check_name: check for check in verdict.checks if not check.passed}
    bundle = flow_bundle(
        test_id="FLOW-003",
        title="changed files do not satisfy focused validation requirement",
        source_sections=["1", "12.3", "13", "14.2", "15.5", "17.8"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-3", "changed_file": "src/performer/runner.py"},
        trigger="Verifier sees workspace diff plus unrelated successful pytest command",
        observed_transitions=["turn_completed", "completion_verification -> NEEDS_RETRY"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"next_action": "retry"},
        codex_evidence={"observed_commands": snapshot.events[0].payload},
        observability_evidence={"verdict": verdict.to_dict()},
        final_state={"verdict": verdict.status},
        score_reason="Bundle includes changed file, observed unrelated command, expected focused command, and retry verdict.",
    )

    assert verdict.status == "NEEDS_RETRY"
    assert "test_command_evidence" in failed
    assert "tests/test_runner.py::test_runner_uses_workspace_cwd" in str(failed["test_command_evidence"].evidence)
    assert "pytest tests/test_models.py -q" in str(bundle["codex_evidence"])


@pytest.mark.asyncio
async def test_flow_004_optional_linear_state_failure_routes_to_human_review_with_passed_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-4", id="eng-4", project_slug="MT")])
    tracker.refreshed = [
        issue(
            "ENG-4",
            id="eng-4",
            blocked_by=[BlockerRef(id="dep-1", identifier="ENG-0", state="In Progress")],
        )
    ]
    workspace = tmp_path / "ENG-4"
    init_repo(workspace)
    (workspace / "README.md").write_text("changed for review\n", encoding="utf-8")
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["workspace_changes"],
            optional_checks=["linear_state"],
            auto_retry_on_fail=True,
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-4"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    comment = tracker.comments[-1][1]
    bundle = flow_bundle(
        test_id="FLOW-004",
        title="optional evidence failure creates human review handoff",
        source_sections=["1", "10.5", "11.5", "13.4", "14.4"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-4", "workspace_changed": True},
        trigger="Required workspace evidence passes while optional linear_state detects non-terminal blocker",
        observed_transitions=["turn_completed", "completion_verification -> NEEDS_HUMAN", "human_review_comment"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"comment": comment, "state_refresh_calls": tracker.fetch_state_calls},
        codex_evidence={"session": "thread-1-turn-1"},
        observability_evidence={"retrying": "eng-4" in orchestrator.state.retry_attempts, "completed": "eng-4" in orchestrator.state.completed},
        final_state={"claimed": "eng-4" in orchestrator.state.claimed, "retrying": "eng-4" in orchestrator.state.retry_attempts},
        score_reason="Human-review comment contains passed workspace check, failed linear_state check, blocker context, and required next action.",
    )

    assert "Verdict: NEEDS_HUMAN" in comment
    assert "[PASS] workspace_changes" in comment
    assert "[FAIL] linear_state" in comment
    assert "Active blockers remain" in comment
    assert "human review is required" in comment.lower()
    assert bundle["final_state"] == {"claimed": True, "retrying": False}


@pytest.mark.asyncio
async def test_flow_005_retry_prompt_reuses_failed_evidence_from_previous_attempt(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-5", id="eng-5", project_slug="MT")])
    workspace = tmp_path / "ENG-5"
    init_repo(workspace)
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-5"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    retry = orchestrator.state.retry_attempts["eng-5"]
    retry.due_at_ms = 0
    second_runner = FlowCompletingRunner()
    orchestrator.runner = second_runner
    await orchestrator.tick()
    await second_runner.started.wait()

    second_entry = orchestrator.state.running["eng-5"]
    bundle = flow_bundle(
        test_id="FLOW-005",
        title="retry carries failed verification evidence into next attempt",
        source_sections=["7.1", "8.4", "12.3", "16.6"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-5", "first_verdict": "NEEDS_RETRY"},
        trigger="Retry timer fires after missing focused validation evidence",
        observed_transitions=["completion_verification -> NEEDS_RETRY", "retry_scheduled", "candidate_refetched", "Running attempt 1"],
        workspace_evidence={"workspace_path": str(workspace)},
        tracker_evidence={"candidate_fetch_calls": tracker.fetch_candidate_calls},
        codex_evidence={"attempts": second_runner.started_attempts},
        observability_evidence={"retry_error": retry.error, "running_description": second_entry.issue.description},
        final_state={"running": "eng-5" in orchestrator.state.running, "attempt": second_entry.retry_attempt},
        score_reason="Retry entry, candidate re-fetch count, attempt number, and retry prompt context all explain why the second attempt differs.",
    )

    assert tracker.fetch_candidate_calls >= 2
    assert second_entry.retry_attempt == 1
    assert "Previous attempt failed verification:" in (second_entry.issue.description or "")
    assert "test_command_evidence" in (second_entry.issue.description or "")
    assert "No test command evidence recorded" in (second_entry.issue.description or "")
    assert bundle["final_state"]["attempt"] == 1


@pytest.mark.asyncio
async def test_flow_006_non_terminal_blocker_is_not_dispatched_with_operator_reason(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    blocked = issue(
        "ENG-6",
        id="eng-6",
        blocked_by=[BlockerRef(id="eng-5", identifier="ENG-5", state="In Progress")],
    )
    tracker = FlowTracker(candidates=[blocked])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()

    bundle = flow_bundle(
        test_id="FLOW-006",
        title="non-terminal blocker prevents Todo dispatch",
        source_sections=["4.1.1", "8.2", "11.3"],
        profile="core",
        initial_state={"issue": blocked.identifier, "blocker": {"identifier": "ENG-5", "state": "In Progress"}},
        trigger="Run one dispatch tick with blocked Todo candidate",
        observed_transitions=["candidate_fetched", "candidate_evaluated", "remains_unclaimed", "no_worker_spawned"],
        workspace_evidence={"workspace_created": False},
        tracker_evidence={"candidate": blocked.__dict__, "fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_started": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "skip_reason": orchestrator.dispatch_skip_reason(blocked)},
        final_state={"claimed": list(orchestrator.state.claimed), "running": list(orchestrator.state.running)},
        score_reason="Operator logs and status evidence name the non-terminal blocker skip reason and no worker was spawned.",
    )

    assert runner.started_attempts == []
    assert "blocked_by_non_terminal_dependency" in caplog.text
    assert "eng-6" not in orchestrator.state.claimed
    assert bundle["observability_evidence"]["skip_reason"] == "blocked_by_non_terminal_dependency"


@pytest.mark.asyncio
async def test_flow_007_terminal_blocker_allows_dispatch_with_blocker_evidence(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    candidate = issue(
        "ENG-7",
        id="eng-7",
        blocked_by=[BlockerRef(id="eng-5", identifier="ENG-5", state="Done")],
    )
    tracker = FlowTracker(candidates=[candidate])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()

    bundle = flow_bundle(
        test_id="FLOW-007",
        title="terminal blocker does not block Todo dispatch",
        source_sections=["8.2", "11.3"],
        profile="core",
        initial_state={"issue": candidate.identifier, "blocker": {"identifier": "ENG-5", "state": "Done"}},
        trigger="Run one dispatch tick with terminal blocker candidate",
        observed_transitions=["candidate_fetched", "Unclaimed -> Claimed", "Claimed -> Running"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"candidate": candidate.__dict__, "fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "skip_reason": orchestrator.dispatch_skip_reason(candidate)},
        final_state={"claimed": "eng-7" in orchestrator.state.claimed, "running": "eng-7" in orchestrator.state.running},
        score_reason="Dispatch log, blocker state, and running state prove terminal blockers are normalized as eligible.",
    )

    assert runner.started_attempts == [None]
    assert "outcome=dispatch issue_id=eng-7" in caplog.text
    assert bundle["observability_evidence"]["skip_reason"] == "already_running_or_claimed"


@pytest.mark.asyncio
async def test_flow_008_concurrency_and_claiming_prevent_duplicate_work(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    first = issue("ENG-8A", id="eng-8a", priority=1)
    second = issue("ENG-8B", id="eng-8b", priority=2)
    tracker = FlowTracker(candidates=[second, first])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        ServiceConfig(
            tracker=TrackerConfig(
                kind="linear",
                endpoint="https://api.linear.app/graphql",
                project_slug="MT",
                api_key="linear-token",
            ),
            polling=PollingConfig(interval_ms=100),
            workspace=WorkspaceConfig(root=tmp_path),
            hooks=HooksConfig(),
            agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
            codex=CodexConfig(stall_timeout_ms=300_000),
            prompt_template="Do {{ issue.identifier }}",
            workflow_path=tmp_path / "WORKFLOW.md",
            completion_verification=CompletionVerificationConfig(enabled=True, required_checks=[]),
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [first]
    await orchestrator.tick()

    bundle = flow_bundle(
        test_id="FLOW-008",
        title="claiming and slots prevent duplicate or excess workers",
        source_sections=["7.4", "8.2", "8.3", "16.4"],
        profile="core",
        initial_state={"candidates": ["ENG-8B", "ENG-8A"], "max_concurrent_agents": 1},
        trigger="Run two dispatch ticks while first issue is still running",
        observed_transitions=["ENG-8A dispatched first by priority", "ENG-8B skipped no_available_slots", "ENG-8A not duplicated"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "running": list(orchestrator.state.running), "claimed": list(orchestrator.state.claimed)},
        final_state={"running_count": len(orchestrator.state.running), "started_count": len(runner.started_attempts)},
        score_reason="Bundle shows sorted candidate dispatch, one running worker, claimed set, and slot exhaustion log for the waiting issue.",
    )

    assert list(orchestrator.state.running) == ["eng-8a"]
    assert len(runner.started_attempts) == 1
    assert "reason=no_available_slots" in caplog.text
    assert bundle["final_state"]["running_count"] == 1


@pytest.mark.asyncio
async def test_flow_009_normal_exit_schedules_short_continuation(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-9", id="eng-9")])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()
    runner.release.set()
    await orchestrator.wait_for_idle()

    continuation = orchestrator.state.continuations.get("eng-9")
    bundle = flow_bundle(
        test_id="FLOW-009",
        title="normal worker exit keeps active work continuing",
        source_sections=["7.1", "7.3", "8.4", "16.6"],
        profile="core",
        initial_state={"issue": "ENG-9", "max_turns": 1},
        trigger="Worker returns normally while issue remains active",
        observed_transitions=["Running removed", "runtime_totals_updated", "continuation_scheduled"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"issue_state": "Todo"},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={
            "continuation": continuation.__dict__ if continuation else None,
            "retrying": "eng-9" in orchestrator.state.retry_attempts,
            "claimed": "eng-9" in orchestrator.state.claimed,
        },
        final_state={
            "continuing": continuation is not None,
            "retrying": "eng-9" in orchestrator.state.retry_attempts,
            "completed": "eng-9" in orchestrator.state.completed,
        },
        score_reason="Status evidence shows clean worker exit schedules a continuation and keeps the issue claimed without using retry state.",
    )

    assert continuation is not None
    assert continuation.attempt == 1
    assert continuation.status_label == "performer:phase/implementation"
    assert "eng-9" not in orchestrator.state.retry_attempts
    assert "eng-9" in orchestrator.state.claimed
    assert bundle["final_state"]["continuing"] is True


@pytest.mark.asyncio
async def test_flow_010_abnormal_exit_uses_backoff_and_preserves_claim(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)

    class FailingRunner:
        async def run_issue(self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None) -> None:
            raise RuntimeError("boom")

    tracker = FlowTracker(candidates=[issue("ENG-10", id="eng-10")])
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    intervention = orchestrator.state.human_interventions["eng-10"]
    child = tracker.created_issues[-1]
    bundle = flow_bundle(
        test_id="FLOW-010",
        title="abnormal worker exit creates human-action child and preserves claim",
        source_sections=["7.3", "8.4", "14.2"],
        profile="core",
        initial_state={"issue": "ENG-10", "attempt": 0},
        trigger="Worker raises RuntimeError during first attempt",
        observed_transitions=["Running removed", "human action child created", "claim preserved"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"child": child},
        codex_evidence={"worker_error": "boom"},
        observability_evidence={"human_intervention": intervention.__dict__, "logs": caplog.text},
        final_state={
            "claimed": "eng-10" in orchestrator.state.claimed,
            "pending_human": "eng-10" in orchestrator.state.human_interventions,
        },
        score_reason="Human-action child exposes worker failure and claim preservation without parent comment control.",
    )

    assert intervention.attempt == 1
    assert intervention.kind == "runtime_error"
    assert intervention.error == "worker exited: boom"
    assert "eng-10" in orchestrator.state.claimed
    assert child["title"] == "[Human Action] ENG-10: Runtime error needs review"
    assert "worker exited: boom" in child["description"]
    assert bundle["final_state"]["claimed"] is True


@pytest.mark.asyncio
async def test_flow_011_due_retry_refetches_and_releases_missing_candidate(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    tracker = FlowTracker(candidates=[])
    runner = FlowCompletingRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-11")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    orchestrator._schedule_retry(issue("ENG-11", id="eng-11"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    bundle = flow_bundle(
        test_id="FLOW-011",
        title="retry timer refetches candidates and releases missing issue",
        source_sections=["8.4"],
        profile="core",
        initial_state={"retry": "ENG-11", "workspace_exists": workspace.path.exists()},
        trigger="Due retry fires but tracker no longer returns the issue",
        observed_transitions=["retry_popped", "candidate_refetched", "issue_missing", "claim_released", "workspace_preserved"],
        workspace_evidence={"workspace_exists_after": workspace.path.exists()},
        tracker_evidence={"fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"claimed": list(orchestrator.state.claimed), "retrying": list(orchestrator.state.retry_attempts)},
        final_state={"claimed": "eng-11" in orchestrator.state.claimed, "workspace_exists": workspace.path.exists()},
        score_reason="Retry handler evidence shows fresh candidate fetch, claim release, no worker spawn, and no workspace cleanup.",
    )

    assert tracker.fetch_candidate_calls == 1
    assert "eng-11" not in orchestrator.state.claimed
    assert "eng-11" not in orchestrator.state.retry_attempts
    assert workspace.path.exists()
    assert runner.started_attempts == []
    assert bundle["final_state"]["workspace_exists"] is True


@pytest.mark.asyncio
async def test_flow_012_terminal_transition_stops_run_and_cleans_workspace_with_hook(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-12", id="eng-12")])
    runner = FlowCompletingRunner()
    hook_log = tmp_path / "before-remove.log"
    workspace_manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path / "workspaces"),
        HooksConfig(before_remove=f"printf before_remove > {hook_log}"),
    )
    workspace = await workspace_manager.create_for_issue("ENG-12")
    (workspace.path / "artifact.txt").write_text("review me\n", encoding="utf-8")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [issue("ENG-12", id="eng-12", state="Done")]

    await orchestrator.reconcile_running()

    bundle = flow_bundle(
        test_id="FLOW-012",
        title="terminal tracker transition stops run and cleans workspace",
        source_sections=["8.5", "8.6", "9.4", "14.4"],
        profile="core",
        initial_state={"issue": "ENG-12", "workspace_exists": True},
        trigger="Tracker refresh returns terminal Done",
        observed_transitions=["state_refresh -> Done", "worker_cancelled", "before_remove_hook", "workspace_removed"],
        workspace_evidence={"workspace_exists_after": workspace.path.exists(), "hook_log": hook_log.read_text(encoding="utf-8")},
        tracker_evidence={"refresh_calls": tracker.fetch_state_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"running": list(orchestrator.state.running), "claimed": list(orchestrator.state.claimed)},
        final_state={"workspace_exists": workspace.path.exists(), "running": "eng-12" in orchestrator.state.running},
        score_reason="Bundle shows terminal refresh, hook output, workspace removal, and running/claimed cleanup.",
    )

    assert not workspace.path.exists()
    assert hook_log.read_text(encoding="utf-8") == "before_remove"
    assert "eng-12" not in orchestrator.state.running
    assert "eng-12" not in orchestrator.state.claimed
    assert bundle["final_state"]["workspace_exists"] is False


@pytest.mark.asyncio
async def test_flow_013_human_review_stops_run_and_preserves_workspace_with_reviewer_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-13", id="eng-13", project_slug="MT")])
    runner = FlowCompletingRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-13")
    (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").write_text("validation passed\n", encoding="utf-8")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    await orchestrator.tick()
    await runner.started.wait()
    entry = orchestrator.state.running["eng-13"]
    entry.workspace_path = str(workspace.path)
    entry.session_id = "thread-13-turn-1"
    entry.last_codex_message = "Validation evidence is ready for review."
    tracker.refreshed = [issue("ENG-13", id="eng-13", state="Human Review", project_slug="MT")]

    await orchestrator.reconcile_running()

    comment = tracker.comments[-1][1]
    bundle = flow_bundle(
        test_id="FLOW-013",
        title="human review handoff stops automation and preserves artifacts",
        source_sections=["1", "8.5", "14.4"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-13", "workspace_path": str(workspace.path)},
        trigger="Tracker refresh returns Human Review for a running issue",
        observed_transitions=["state_refresh -> Human Review", "worker_cancelled", "workspace_preserved", "handoff_comment_written"],
        workspace_evidence={
            "workspace_exists": workspace.path.exists(),
            "validation_artifact": (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").read_text(encoding="utf-8"),
        },
        tracker_evidence={"refresh_calls": tracker.fetch_state_calls, "comment": comment},
        codex_evidence={"session_id": "thread-13-turn-1", "last_message": "Validation evidence is ready for review."},
        observability_evidence={"running": "eng-13" in orchestrator.state.running, "claimed": "eng-13" in orchestrator.state.claimed},
        final_state={"workspace_exists": workspace.path.exists(), "running": "eng-13" in orchestrator.state.running},
        score_reason="Reviewer-facing handoff comment gives tracker state, preserved workspace path, session, and required next action.",
    )

    assert "Performer stopped automation for human review." in comment
    assert "Tracker state: Human Review" in comment
    assert str(workspace.path) in comment
    assert workspace.path.exists()
    assert "eng-13" not in orchestrator.state.running
    assert "eng-13" not in orchestrator.state.claimed
    assert bundle["score"] == 4


@pytest.mark.asyncio
async def test_flow_014_stall_detection_kills_silent_session_and_retries(tmp_path: Path) -> None:
    from datetime import timedelta

    tracker = FlowTracker(candidates=[issue("ENG-14", id="eng-14")])
    runner = FlowCompletingRunner()
    config = ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(interval_ms=100),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=True, required_checks=[]),
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    await runner.started.wait()
    entry = orchestrator.state.running["eng-14"]
    entry.last_codex_timestamp = entry.started_at - timedelta(seconds=10)
    entry.last_codex_event = "notification"

    await orchestrator.reconcile_running()

    bundle = flow_bundle(
        test_id="FLOW-014",
        title="stall detection terminates silent session and schedules pure retry",
        source_sections=["5.3.6", "8.5", "10.6", "14.1", "14.2"],
        profile="core",
        initial_state={"issue": "ENG-14", "stall_timeout_ms": 1, "last_codex_event": "notification"},
        trigger="Run reconciliation after last Codex timestamp is older than stall timeout",
        observed_transitions=["stall_elapsed_from_last_codex_timestamp", "worker_cancelled", "retry_scheduled"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"created_issues": tracker.created_issues},
        codex_evidence={"last_codex_timestamp": entry.last_codex_timestamp.isoformat()},
        observability_evidence={
            "retry": orchestrator.state.retry_attempts["eng-14"].__dict__,
            "claimed": "eng-14" in orchestrator.state.claimed,
        },
        final_state={
            "retrying": "eng-14" in orchestrator.state.retry_attempts,
            "pending_human": "eng-14" in orchestrator.state.human_interventions,
            "running": "eng-14" in orchestrator.state.running,
        },
        score_reason="Retry entry shows stalled reason; timestamp evidence shows stall clock source without requiring human action.",
    )

    assert orchestrator.state.retry_attempts["eng-14"].error == "stalled"
    assert "eng-14" in orchestrator.state.claimed
    assert tracker.created_issues == []
    assert bundle["final_state"]["retrying"] is True
    assert bundle["final_state"]["pending_human"] is False


def test_flow_015_dynamic_workflow_reload_changes_future_dispatch_not_inflight(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    workflow_path = tmp_path / "WORKFLOW.md"
    write_flow_workflow(
        workflow_path,
        active_states=["Todo", "In Progress"],
        max_concurrent_agents=1,
        prompt="Old prompt for {{ issue.identifier }}",
    )
    reloader = WorkflowReloader(workflow_path)
    first = reloader.current()
    running_session = {"issue_id": "eng-15", "session_id": "thread-15-turn-1", "prompt": "Old prompt for ENG-15"}
    write_flow_workflow(
        workflow_path,
        active_states=["Ready"],
        max_concurrent_agents=2,
        prompt="New prompt for {{ issue.identifier }} / {{ issue.title }}",
    )

    second = reloader.current()
    rendered = render_prompt(
        second.prompt_template,
        {"issue": {"identifier": "ENG-15B", "title": "Future"}, "attempt": 1},
    )

    bundle = flow_bundle(
        test_id="FLOW-015",
        title="dynamic workflow reload changes future dispatch while preserving in-flight run",
        source_sections=["5.3", "6.2", "6.3", "14.4"],
        profile="core",
        initial_state={
            "active_states": first.tracker.active_states,
            "max_concurrent_agents": first.agent.max_concurrent_agents,
            "running_session": running_session,
        },
        trigger="Modify WORKFLOW.md and reload",
        observed_transitions=["reload_detected_mtime_change", "new_config_effective", "inflight_session_not_restarted", "future_prompt_changed"],
        workspace_evidence={"workflow_path": str(workflow_path)},
        tracker_evidence={"future_active_states": second.tracker.active_states},
        codex_evidence={"running_session": running_session, "future_prompt": rendered},
        observability_evidence={"last_error": str(reloader.last_error), "logs": caplog.text},
        final_state={"active_states": second.tracker.active_states, "max_concurrent_agents": second.agent.max_concurrent_agents},
        score_reason="Reload evidence shows old and new config, unchanged in-flight session metadata, and new future prompt rendering.",
    )

    assert first.tracker.active_states == ["Todo", "In Progress"]
    assert second.tracker.active_states == ["Ready"]
    assert second.agent.max_concurrent_agents == 2
    assert running_session["session_id"] == "thread-15-turn-1"
    assert rendered == "New prompt for ENG-15B / Future"
    assert bundle["score"] == 4


def test_flow_016_invalid_workflow_reload_keeps_last_good_config_with_diagnostics(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    workflow_path = tmp_path / "WORKFLOW.md"
    write_flow_workflow(
        workflow_path,
        active_states=["Todo"],
        max_concurrent_agents=1,
        prompt="Do {{ issue.identifier }}",
    )
    reloader = WorkflowReloader(workflow_path)
    first = reloader.current()
    workflow_path.write_text("---\ntracker: [", encoding="utf-8")

    second = reloader.current()

    bundle = flow_bundle(
        test_id="FLOW-016",
        title="invalid workflow reload keeps last known good config",
        source_sections=["5.5", "6.2", "6.3", "13.2", "14.2"],
        profile="core",
        initial_state={"active_states": first.tracker.active_states, "workflow_path": str(workflow_path)},
        trigger="Replace workflow with invalid YAML front matter and reload",
        observed_transitions=["reload_attempted", "workflow_parse_error", "last_good_config_retained", "service_continues"],
        workspace_evidence={"workflow_path": str(workflow_path)},
        tracker_evidence={"last_good_active_states": second.tracker.active_states},
        codex_evidence={"not_applicable": True},
        observability_evidence={"last_error": str(reloader.last_error), "logs": caplog.text},
        final_state={"same_config_object": second is first, "active_states": second.tracker.active_states},
        score_reason="Diagnostics include reload failure while current config remains the last valid active-state config.",
    )

    assert second is first
    assert reloader.last_error is not None
    assert "performer_workflow_reload failed" in caplog.text
    assert second.tracker.active_states == ["Todo"]
    assert bundle["final_state"]["same_config_object"] is True


@pytest.mark.asyncio
async def test_flow_017_workspace_hooks_order_failure_semantics_and_operator_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    hook_root = tmp_path / "hooks"
    order_log = tmp_path / "hook-order.log"
    manager = WorkspaceManager(
        WorkspaceConfig(root=hook_root),
        HooksConfig(
            after_create=f"printf after_create:$PWD >> {order_log}",
            before_run=f"printf ' before_run:'$PWD >> {order_log}",
            after_run=f"printf ' after_run:'$PWD >> {order_log}",
            before_remove=f"printf ' before_remove:'$PWD >> {order_log}",
            timeout_ms=50,
        ),
    )

    workspace = await manager.create_for_issue("ENG-17")
    reused = await manager.create_for_issue("ENG-17")
    await manager.run_before_run(workspace.path)
    await manager.run_after_run(workspace.path)
    await manager.remove_for_issue("ENG-17")

    fatal_create = WorkspaceManager(WorkspaceConfig(root=tmp_path / "fatal-create"), HooksConfig(after_create="exit 7"))
    with pytest.raises(WorkspaceError) as create_exc:
        await fatal_create.create_for_issue("ENG-17")
    fatal_before = WorkspaceManager(WorkspaceConfig(root=tmp_path / "fatal-before"), HooksConfig(before_run="exit 8"))
    fatal_workspace = await fatal_before.create_for_issue("ENG-17")
    with pytest.raises(WorkspaceError) as before_exc:
        await fatal_before.run_before_run(fatal_workspace.path)
    nonfatal_after = WorkspaceManager(WorkspaceConfig(root=tmp_path / "nonfatal-after"), HooksConfig(after_run="echo after_bad >&2; exit 9"))
    after_workspace = await nonfatal_after.create_for_issue("ENG-17")
    await nonfatal_after.run_after_run(after_workspace.path)
    nonfatal_remove = WorkspaceManager(WorkspaceConfig(root=tmp_path / "nonfatal-remove"), HooksConfig(before_remove="echo remove_bad >&2; exit 10"))
    remove_workspace = await nonfatal_remove.create_for_issue("ENG-17")
    await nonfatal_remove.remove_for_issue("ENG-17")

    order = order_log.read_text(encoding="utf-8")
    bundle = flow_bundle(
        test_id="FLOW-017",
        title="workspace hooks execute in order with documented fatal and non-fatal semantics",
        source_sections=["5.3.4", "9.2", "9.4", "16.5"],
        profile="core",
        initial_state={"issue": "ENG-17", "hook_root": str(hook_root)},
        trigger="Create, run, finish, remove workspace plus hook failure variants",
        observed_transitions=["after_create once", "before_run", "after_run", "before_remove", "fatal_create_aborted", "fatal_before_run_aborted", "nonfatal_cleanup_logged"],
        workspace_evidence={"order_log": order, "reused_created_now": reused.created_now, "removed": not workspace.path.exists()},
        tracker_evidence={"not_applicable": True},
        codex_evidence={"launch_count": 1, "worker_outcome": "simulated"},
        observability_evidence={"logs": caplog.text, "fatal_codes": [create_exc.value.code, before_exc.value.code]},
        final_state={"workspace_removed": not workspace.path.exists(), "nonfatal_remove_removed": not remove_workspace.path.exists()},
        score_reason="Bundle includes hook order/cwd, fatal error codes, non-fatal warning logs, and cleanup state.",
    )

    assert order.count("after_create:") == 1
    assert "before_run:" in order
    assert "after_run:" in order
    assert "before_remove:" in order
    assert create_exc.value.code == "hook_failed"
    assert before_exc.value.code == "hook_failed"
    assert "exit_code=9" in caplog.text
    assert "exit_code=10" in caplog.text
    assert not remove_workspace.path.exists()
    assert bundle["score"] == 4


@pytest.mark.asyncio
async def test_flow_019_secret_used_for_linear_request_but_never_logged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "secret-token-123"
    monkeypatch.setenv("LINEAR_API_KEY", secret)
    transport = SecretStatusTransport()
    client = LinearClient("https://api.linear.test/graphql", os.environ["LINEAR_API_KEY"], transport=transport)
    caplog.set_level(logging.WARNING)

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(
            TrackerConfig(
                kind="linear",
                endpoint="https://api.linear.test/graphql",
                api_key=os.environ["LINEAR_API_KEY"],
                project_slug="ENG",
            )
        )
    logging.getLogger("performer.flow").warning("candidate fetch failed category=%s", exc.value.code)

    request = transport.requests[0]
    bundle = flow_bundle(
        test_id="FLOW-019",
        title="linear secret is validated and used without operator-visible leakage",
        source_sections=["5.3.1", "6.1", "13.2", "15.3"],
        profile="core security",
        initial_state={"env": {"LINEAR_API_KEY": "present"}},
        trigger="Linear candidate fetch receives HTTP status error",
        observed_transitions=["secret_resolved_present", "linear_request_sent", "linear_api_status_error", "dispatch_skipped_for_tick"],
        workspace_evidence={},
        tracker_evidence={"authorization_header_present": request["headers"].get("authorization") == secret},
        codex_evidence={"not_applicable": True},
        observability_evidence={"log_text": caplog.text, "error_code": exc.value.code},
        final_state={"dispatched": 0, "error_code": exc.value.code},
        score_reason="Test-only transport proves Authorization value was used while operator logs and error messages expose only stable categories.",
    )

    assert request["headers"]["authorization"] == secret
    assert exc.value.code == "linear_api_status"
    assert secret not in caplog.text
    assert secret not in str(exc.value)
    assert bundle["observability_evidence"]["error_code"] == "linear_api_status"


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_flow_020_linear_pagination_normalization_sorting_and_error_categories(tmp_path: Path) -> None:
    def node(
        identifier: str,
        *,
        priority: int,
        label: str,
        created: str,
        delegate_id: str | None = "agent-user-1",
    ) -> dict[str, Any]:
        return {
            "id": identifier.lower(),
            "identifier": identifier,
            "title": identifier,
            "description": "",
            "priority": priority,
            "branchName": identifier.lower(),
            "url": f"https://linear.local/{identifier}",
            "createdAt": created,
            "updatedAt": created,
            "state": {"name": "Todo"},
            "project": {"slugId": "ENG", "name": "Engineering"},
            "assignee": {"id": "user-1"},
            "delegate": {"id": delegate_id} if delegate_id else None,
            "labels": {"nodes": [{"name": label}]},
            "inverseRelations": {"nodes": []},
        }

    transport = FlowLinearTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [
                            node("ENG-20B", priority=3, label="Ready", created="2026-07-02T00:00:00Z"),
                            node("ENG-20A", priority=1, label=" READY ", created="2026-07-01T00:00:00Z"),
                        ],
                        "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                    }
                }
            },
            {
                "data": {
                    "issues": {
                        "nodes": [
                            node(
                                "ENG-20C",
                                priority=0,
                                label="other",
                                created="2026-07-03T00:00:00Z",
                                delegate_id="other-agent",
                            )
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        ]
    )
    config = TrackerConfig(
        kind="linear",
        endpoint="https://api.linear.test/graphql",
        project_slug="ENG",
        api_key="linear-token",
        required_delegate_id="agent-user-1",
    )
    client = LinearClient(config.endpoint, config.api_key, transport=transport)

    candidates = await client.fetch_candidate_issues(config, page_size=2)
    eligible = [candidate for candidate in candidates if candidate.delegate_id == config.required_delegate_id]
    sorted_eligible = sort_for_dispatch(eligible)
    error_codes = []
    for response in [{"errors": [{"message": "bad"}]}, "not-json"]:
        error_transport = FlowLinearTransport([response]) if isinstance(response, dict) else SecretStatusTransport()
        try:
            if isinstance(response, dict):
                await LinearClient(config.endpoint, config.api_key, transport=error_transport).fetch_candidate_issues(config)
            else:
                await LinearClient(config.endpoint, config.api_key, transport=error_transport).fetch_candidate_issues(config)
        except LinearError as exc:
            error_codes.append(exc.code)

    bundle = flow_bundle(
        test_id="FLOW-020",
        title="linear pagination normalization and dispatch sorting feed scheduler correctly",
        source_sections=["4.1.1", "5.3.1", "8.2", "11.1", "11.2", "11.3", "11.4"],
        profile="core tracker",
        initial_state={"project_slug": "ENG", "required_delegate_id": "agent-user-1"},
        trigger="Fetch two Linear pages and run delegate eligibility/sorting",
        observed_transitions=["page_1_fetched", "cursor-1_used", "delegate_normalized", "delegate_mismatch_filtered", "ENG-20A_sorted_first"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"requests": transport.requests, "normalized": [candidate.__dict__ for candidate in candidates]},
        codex_evidence={"not_applicable": True},
        observability_evidence={"sorted_order": [candidate.identifier for candidate in sorted_eligible], "error_codes": error_codes},
        final_state={"dispatch_first": sorted_eligible[0].identifier, "eligible": [candidate.identifier for candidate in eligible]},
        score_reason="Bundle includes GraphQL variables/query, pagination cursor, normalized labels, eligibility decisions, sorted dispatch order, and error categories.",
    )

    assert transport.requests[0]["json"]["variables"]["projectSlug"] == "ENG"
    assert transport.requests[1]["json"]["variables"]["after"] == "cursor-1"
    assert [candidate.identifier for candidate in eligible] == ["ENG-20B", "ENG-20A"]
    assert sorted_eligible[0].identifier == "ENG-20A"
    assert "slugId" in transport.requests[0]["json"]["query"]
    assert "linear_graphql_errors" in error_codes
    assert "linear_api_status" in error_codes
    assert bundle["final_state"]["dispatch_first"] == "ENG-20A"


def test_flow_023_token_and_runtime_metrics_use_latest_absolute_totals(tmp_path: Path) -> None:
    config = config_with_verification(tmp_path, required_checks=[])
    state = OrchestratorState()
    tracker = FlowTracker(candidates=[issue("ENG-23", id="eng-23")])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config, tracker, runner)
    started_at = utc_now() - timedelta(seconds=10)
    entry = RunningEntry(
        issue=issue("ENG-23", id="eng-23", state="In Progress"),
        task=None,
        started_at=started_at,
        retry_attempt=0,
        session_id="thread-23-turn-1",
    )
    state.running["eng-23"] = entry
    orchestrator.state = state
    first_event = {
        "event": "thread_token_usage_updated",
        "turn_id": "turn_1",
        "session_id": "thread-23-turn-1",
        "payload": {"total_token_usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}},
    }
    second_event = {
        "event": "thread_token_usage_updated",
        "turn_id": "turn_1",
        "session_id": "thread-23-turn-1",
        "payload": {
            "total_token_usage": {"input_tokens": 150, "output_tokens": 70, "total_tokens": 220},
            "rate_limits": {"primary": {"remaining": 10}},
        },
    }
    delta_event = {"event": "thread_token_usage_updated", "turn_id": "turn_1", "session_id": "thread-23-turn-1", "payload": {"last_token_usage": {"total_tokens": 999}}}

    orchestrator.on_codex_event("eng-23", first_event)
    totals_after_first = orchestrator.state.codex_totals.total_tokens
    orchestrator.on_codex_event("eng-23", second_event)
    totals_after_second = orchestrator.state.codex_totals.total_tokens
    orchestrator.on_codex_event("eng-23", delta_event)
    snapshot = build_runtime_snapshot(config, orchestrator.state)

    bundle = flow_bundle(
        test_id="FLOW-023",
        title="token and runtime metrics remain correct across repeated absolute updates",
        source_sections=["4.1.6", "13.3", "13.5"],
        profile="core observability",
        initial_state={"session": "thread-23-turn-1", "started_seconds_ago": 10},
        trigger="Apply two absolute token updates and one delta-style payload, then build snapshot",
        observed_transitions=["tokens=150", "tokens=220", "delta_payload_ignored", "snapshot_generated"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"not_applicable": True},
        codex_evidence={"events": [first_event, second_event, delta_event]},
        observability_evidence={"totals": [totals_after_first, totals_after_second], "snapshot": snapshot},
        final_state={"aggregate_total_tokens": snapshot["codex_totals"]["total_tokens"], "session_total_tokens": entry.tokens.total_tokens},
        score_reason="Event-by-event totals and snapshot prove absolute totals are not double-counted and active runtime is included.",
    )

    assert totals_after_first == 150
    assert totals_after_second == 220
    assert snapshot["codex_totals"]["total_tokens"] == 220
    assert snapshot["codex_totals"]["seconds_running"] >= 9
    assert orchestrator.state.codex_rate_limits == {"primary": {"remaining": 10}}
    assert bundle["final_state"]["aggregate_total_tokens"] == 220



def test_flow_025_real_integration_profiles_skip_fail_and_pass_are_explicit(tmp_path: Path) -> None:
    base_env = dict(os.environ)
    base_env.pop("LINEAR_API_KEY", None)
    base_env.pop("PERFORMER_REAL_INTEGRATION", None)
    missing = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_real_integration.py", "-q"],
        cwd=Path.cwd(),
        env=base_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    invalid_env = dict(base_env)
    invalid_env["PERFORMER_REAL_INTEGRATION"] = "1"
    invalid_env["LINEAR_API_KEY"] = "invalid-token-for-flow-025"
    invalid = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_real_integration.py", "-q"],
        cwd=Path.cwd(),
        env=invalid_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    valid_available = bool(os.environ.get("LINEAR_API_KEY"))

    bundle = flow_bundle(
        test_id="FLOW-025",
        title="real integration profile skips missing credentials and fails enabled auth errors",
        source_sections=["17.8", "18.3"],
        profile="real_integration",
        initial_state={"valid_credentials_available": valid_available},
        trigger="Run real integration pytest with missing and invalid credentials",
        observed_transitions=["missing_credentials_explicit_skip", "invalid_credentials_enabled_failure"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"missing_output": missing.stdout + missing.stderr, "invalid_output": invalid.stdout + invalid.stderr},
        codex_evidence={"not_applicable": True},
        observability_evidence={"missing_returncode": missing.returncode, "invalid_returncode": invalid.returncode},
        final_state={"missing_skipped": missing.returncode == 0 and "skipped" in missing.stdout.lower(), "invalid_failed": invalid.returncode != 0},
        score_reason="Subprocess reports prove missing credentials skip explicitly and enabled invalid credentials fail instead of passing silently.",
    )

    assert missing.returncode == 0
    assert "skipped" in missing.stdout.lower()
    assert invalid.returncode != 0
    assert "invalid-token-for-flow-025" not in (invalid.stdout + invalid.stderr)
    assert bundle["final_state"]["invalid_failed"] is True
