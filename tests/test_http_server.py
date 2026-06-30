from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from symphony.config import (
    AgentConfig,
    CodexConfig,
    HooksConfig,
    PollingConfig,
    ServiceConfig,
    TrackerConfig,
    ObservabilityConfig,
    WorkspaceConfig,
)
from symphony.http_server import SymphonyHttpServer
from symphony.models import Issue, RunningEntry, RuntimeTokens, utc_now
from symphony.orchestrator import OrchestratorState


def make_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
            required_labels=["codex"],
        ),
        polling=PollingConfig(),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(),
        codex=CodexConfig(),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


async def request(port: int, method: str, path: str) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Content-Length: 0\r\n"
            "Connection: close\r\n"
            "\r\n"
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


@pytest.mark.asyncio
async def test_http_server_serves_state_issue_refresh_and_dashboard(tmp_path: Path) -> None:
    refresh_calls = 0

    async def refresh() -> None:
        nonlocal refresh_calls
        refresh_calls += 1

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
                retry_attempt=1,
                session_id="thread-1-turn-1",
                tokens=RuntimeTokens(total_tokens=5),
                turn_count=1,
            )
        }
    )
    server = SymphonyHttpServer(make_config(tmp_path), state, refresh)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/api/v1/state")
        assert status == 200
        assert headers["content-type"].startswith("application/json")
        payload = json.loads(body)
        assert payload["counts"]["running"] == 1
        assert payload["running"][0]["issue_identifier"] == "MT-1"

        status, _, body = await request(server.port, "GET", "/api/v1/MT-1")
        assert status == 200
        detail = json.loads(body)
        assert detail["issue_identifier"] == "MT-1"
        assert detail["workspace"]["path"] == str((tmp_path / "MT-1").resolve())

        status, _, body = await request(server.port, "GET", "/api/v1/NOPE")
        assert status == 404
        assert json.loads(body)["error"]["code"] == "issue_not_found"

        status, _, body = await request(server.port, "POST", "/api/v1/refresh")
        assert status == 202
        assert json.loads(body)["queued"] is True
        assert refresh_calls == 1

        status, headers, body = await request(server.port, "GET", "/")
        assert status == 200
        assert headers["content-type"].startswith("text/html")
        assert b"Symphony" in body
        assert b"Running: 1" in body
        assert b"Retrying: 0" in body
        assert b"MT-1" in body

        status, _, body = await request(server.port, "DELETE", "/api/v1/state")
        assert status == 405
        assert json.loads(body)["error"]["code"] == "method_not_allowed"
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_refresh_failure_returns_unavailable_error(tmp_path: Path) -> None:
    async def refresh() -> None:
        raise RuntimeError("tracker unavailable")

    server = SymphonyHttpServer(make_config(tmp_path), OrchestratorState(), refresh)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "POST", "/api/v1/refresh")

        assert status == 503
        assert json.loads(body)["error"]["code"] == "unavailable"
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_refresh_can_be_disabled_by_observability_config(tmp_path: Path) -> None:
    refresh_calls = 0

    async def refresh() -> None:
        nonlocal refresh_calls
        refresh_calls += 1

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
        observability=ObservabilityConfig(allow_refresh=False),
    )
    server = SymphonyHttpServer(config, OrchestratorState(), refresh)
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "POST", "/api/v1/refresh")

        assert status == 403
        assert json.loads(body)["error"]["code"] == "refresh_disabled"
        assert refresh_calls == 0
    finally:
        await server.stop()
