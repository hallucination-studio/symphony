from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from podium.server import PodiumServer


async def request(
    port: int,
    method: str,
    path: str,
    body: object | bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    if isinstance(body, bytes):
        raw = body
    elif body is None:
        raw = b""
    else:
        raw = json.dumps(body).encode()
    request_headers = {"Host": "127.0.0.1", "Content-Length": str(len(raw))}
    if body is not None and not isinstance(body, bytes):
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    writer.write(
        f"{method} {path} HTTP/1.1\r\n".encode()
        + b"".join(f"{key}: {value}\r\n".encode() for key, value in request_headers.items())
        + b"\r\n"
        + raw
    )
    await writer.drain()
    status_line = await reader.readline()
    status = int(status_line.decode().split(" ")[1])
    response_headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in {b"\r\n", b"\n", b""}:
            break
        key, value = line.decode().split(":", 1)
        response_headers[key.strip().lower()] = value.strip()
    response_body = await reader.readexactly(int(response_headers.get("content-length", "0")))
    writer.close()
    await writer.wait_closed()
    return status, response_headers, response_body


def _server() -> PodiumServer:
    return PodiumServer(
        linear_installations={
            "workspace-1": {
                "workspace_id": "workspace-1",
                "access_token": "secret-linear-token",
                "scope": "read,write",
                "app_user_id": "app-1",
            }
        },
    )


# ===== Bootstrap =====


@pytest.mark.asyncio
async def test_bootstrap_returns_session_and_onboarding_state() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "GET", "/api/v1/bootstrap?workspace_id=workspace-1"
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["session"]["workspace_id"] == "workspace-1"
    assert payload["onboarding"]["current_step"]
    assert "next_action" in payload["onboarding"]
    assert b"secret-linear-token" not in body


@pytest.mark.asyncio
async def test_bootstrap_reports_linear_connection_status() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "GET", "/api/v1/bootstrap?workspace_id=workspace-1"
        )
    finally:
        await server.stop()

    payload = json.loads(body)
    assert payload["linear"]["state"] == "connected"
    assert b"secret-linear-token" not in body


# ===== Onboarding status =====


@pytest.mark.asyncio
async def test_onboarding_status_returns_progress() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "GET", "/api/v1/onboarding/status?workspace_id=workspace-1"
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert "current_step" in payload
    assert "completed_steps" in payload


# ===== Linear onboarding =====


@pytest.mark.asyncio
async def test_onboarding_linear_start_returns_authorization_url() -> None:
    server = PodiumServer(
        linear_client_id="client-1",
        linear_redirect_uri="https://podium.example/cb",
    )
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/linear/start",
            {"workspace_id": "workspace-1"},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["authorization_url"].startswith("https://linear.app/oauth/authorize")


@pytest.mark.asyncio
async def test_onboarding_linear_scope_lists_projects_and_teams() -> None:
    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "teams": {"nodes": [{"id": "team-1", "name": "Engineering"}]},
                    "projects": {"nodes": [{"id": "proj-1", "name": "Podium"}]},
                }
            },
            request=request,
        )

    server = PodiumServer(
        linear_installations={
            "workspace-1": {"workspace_id": "workspace-1", "access_token": "secret-linear-token"}
        },
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/linear/scope?workspace_id=workspace-1",
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["teams"][0]["name"] == "Engineering"
    assert payload["projects"][0]["name"] == "Podium"
    assert b"secret-linear-token" not in body


@pytest.mark.asyncio
async def test_onboarding_scope_saves_selection() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/scope",
            {"workspace_id": "workspace-1", "teams": ["team-1"], "projects": ["proj-1"]},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["onboarding"]["current_step"]


# ===== Repository =====


@pytest.mark.asyncio
async def test_onboarding_repository_saves_git_url_mapping() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/repository",
            {"workspace_id": "workspace-1", "mode": "git_url", "value": "https://github.com/acme/repo.git"},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["repository"]["validation_state"] == "valid"


@pytest.mark.asyncio
async def test_onboarding_repository_rejects_invalid_git_url() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/repository",
            {"workspace_id": "workspace-1", "mode": "git_url", "value": "not-a-url"},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["repository"]["validation_state"] == "invalid"


# ===== Runtime enrollment =====


@pytest.mark.asyncio
async def test_onboarding_runtime_enrollment_token_generated() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/runtime/enrollment-token",
            {"workspace_id": "workspace-1"},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["enrollment_token"]
    assert len(payload["enrollment_token"]) > 20


@pytest.mark.asyncio
async def test_onboarding_runtime_status_reports_enrollment() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/runtime/status?workspace_id=workspace-1",
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert "enrolled" in payload
    assert "online_count" in payload


# ===== Smoke check =====


@pytest.mark.asyncio
async def test_onboarding_smoke_check_triggers_and_returns_result() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/smoke-check",
            {"workspace_id": "workspace-1"},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["status"] in {"passed", "failed"}
    assert "checks" in payload


@pytest.mark.asyncio
async def test_onboarding_smoke_check_result_returns_latest() -> None:
    server = _server()
    await server.start(port=0)
    try:
        await request(
            server.port,
            "POST",
            "/api/v1/onboarding/smoke-check",
            {"workspace_id": "workspace-1"},
        )
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/smoke-check/result?workspace_id=workspace-1",
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["status"] in {"passed", "failed"}


# ===== Runtimes =====


@pytest.mark.asyncio
async def test_runtimes_list_returns_online_status() -> None:
    server = _server()
    server.runtime_service.record_heartbeat("rt-1")
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runtimes")
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert any(r["runtime_id"] == "rt-1" and r["online"] for r in payload["runtimes"])


@pytest.mark.asyncio
async def test_runtime_detail_returns_heartbeat() -> None:
    server = _server()
    server.runtime_service.record_heartbeat("rt-1")
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runtimes/rt-1")
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["runtime_id"] == "rt-1"
    assert payload["last_heartbeat"] is not None


@pytest.mark.asyncio
async def test_runtime_detail_404_for_unknown() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runtimes/nope")
    finally:
        await server.stop()

    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"


# ===== Runs =====


@pytest.mark.asyncio
async def test_runs_recent_returns_summaries() -> None:
    from podium.models import RunStatus, RunSummary

    server = _server()
    server.runtime_service.record_run(
        RunSummary(
            run_id="run-1",
            issue_identifier="ENG-1",
            runtime_id="rt-1",
            status=RunStatus.SUCCESS,
            started_at="2026-01-01T00:00:00Z",
            completed_at="2026-01-01T00:01:00Z",
            duration_seconds=60.0,
        )
    )
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runs/recent")
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["runs"][0]["run_id"] == "run-1"


@pytest.mark.asyncio
async def test_run_detail_returns_failure_reason() -> None:
    from podium.models import RunStatus, RunSummary

    server = _server()
    server.runtime_service.record_run(
        RunSummary(
            run_id="run-1",
            issue_identifier="ENG-1",
            runtime_id="rt-1",
            status=RunStatus.FAILED,
            started_at="2026-01-01T00:00:00Z",
            completed_at=None,
            duration_seconds=None,
            failure_reason="boom",
        )
    )
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runs/run-1")
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["failure_reason"] == "boom"


@pytest.mark.asyncio
async def test_run_detail_404_for_unknown() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/runs/nope")
    finally:
        await server.stop()

    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"
