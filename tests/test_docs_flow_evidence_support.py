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
