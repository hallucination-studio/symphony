from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

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
        if path in {"/api/v1/auth/register", "/api/v1/auth/login"} and isinstance(body, dict):
            body = {**body, "turnstile_token": "test-turnstile"}
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
    return PodiumServer(secret_key="test-secret")


async def _auth(server: PodiumServer, *, linear_token: str | None = "secret-linear-token") -> tuple[str, str]:
    """Register a user over HTTP, seed a Linear installation for their
    workspace, and return (workspace_id, cookie)."""
    _, headers, body = await request(
        server.port, "POST", "/api/v1/auth/register",
        {"email": f"u{id(server)}@example.com", "password": "password123"},
    )
    cookie = (headers.get("set-cookie") or "").split(";", 1)[0]
    workspace_id = json.loads(body)["user"]["id"]
    if linear_token is not None:
        now = datetime.now(timezone.utc)
        await server.app.state.podium.save_linear_installation_record(
            {
                "id": f"installation-{workspace_id}",
                "user_id": workspace_id,
                "application_config_id": "test-config",
                "application_config_version": 1,
                "application_source": "default",
                "state": "accepted",
                "active": False,
                "access_token": linear_token,
                "refresh_token": "test-refresh-token",
                "token_type": "Bearer",
                "scope": ["read", "write", "app:assignable", "app:mentionable"],
                "expires_at": (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
                "linear_organization_id": "linear-org-1",
                "organization_url_key": "acme",
                "organization_name": "Acme",
                "app_user_id": "app-1",
                "supports_agent_sessions": True,
                "projects": [{"id": "proj-1", "name": "Podium", "slug_id": "podium"}],
                "error_code": "",
                "sanitized_reason": "",
                "retryable": False,
                "action_required": "",
                "next_action": "",
                "created_at": now.isoformat().replace("+00:00", "Z"),
                "updated_at": now.isoformat().replace("+00:00", "Z"),
            }
        )
        await server.app.state.podium.activate_linear_installation(workspace_id, f"installation-{workspace_id}")
    return workspace_id, cookie


# ===== Bootstrap =====


@pytest.mark.asyncio
async def test_bootstrap_requires_auth() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/bootstrap")
    finally:
        await server.stop()

    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_bootstrap_returns_session_and_onboarding_state() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port, "GET", "/api/v1/bootstrap", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["session"]["workspace_id"] == ws
    assert payload["session"]["user_id"] == ws
    assert payload["onboarding"]["current_step"]
    assert "next_action" in payload["onboarding"]
    for leak in (b"secret-linear-token", b"token", b"password_hash", b"runtime_token", b"proxy_token"):
        assert leak not in body


@pytest.mark.asyncio
async def test_bootstrap_reports_linear_connection_status() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port, "GET", "/api/v1/bootstrap", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()

    payload = json.loads(body)
    assert payload["linear"]["state"] == "connected"
    assert payload["linear"]["workspace_id"] == ws
    assert b"secret-linear-token" not in body


# ===== Onboarding status =====


@pytest.mark.asyncio
async def test_onboarding_status_returns_progress() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port, "GET", "/api/v1/onboarding/status", headers={"Cookie": cookie}
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
        secret_key="test-secret",
        linear_client_id="client-1",
        linear_client_secret="client-secret",
        linear_redirect_uri="https://podium.example/api/v1/linear/oauth/callback",
        linear_webhook_secret="webhook-secret",
    )
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server, linear_token=None)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/installations/oauth",
            {},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["authorization_url"].startswith("https://linear.app/oauth/authorize")


@pytest.mark.asyncio
async def test_onboarding_scope_saves_selection() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/scope",
            {"teams": ["team-1"], "projects": ["proj-1"]},
            headers={"Cookie": cookie},
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
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/repository",
            {"mode": "git_url", "value": "https://github.com/acme/repo.git"},
            headers={"Cookie": cookie},
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
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/repository",
            {"mode": "git_url", "value": "not-a-url"},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert payload["repository"]["validation_state"] == "invalid"


@pytest.mark.asyncio
async def test_onboarding_repository_rejects_unknown_mode() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/repository",
            {"mode": "nope", "value": "x"},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_mode"


# ===== Runtime enrollment =====


@pytest.mark.asyncio
async def test_onboarding_enrollment_token_returns_install_command() -> None:
    server = PodiumServer(
        secret_key="test-secret",
        podium_base_url="https://podium.test",
    )
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server, linear_token="t")
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/runtime/enrollment-token",
            {},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    token = payload["enrollment_token"]
    assert len(token) > 20
    assert payload["install_command"] == (
        f"PODIUM_ENROLLMENT_TOKEN={token} "
        f"curl -fsSL https://podium.test/install.sh | "
        f"PODIUM_ENROLLMENT_TOKEN={token} "
        f"bash -s -- --podium-url https://podium.test"
    )
    assert f"--enrollment-token {token}" not in payload["install_command"]
    assert payload["expires_at"]
    # No hardcoded frontend host leaks into the backend-composed command.
    assert "get.podium.dev" not in payload["install_command"]


# ===== Runtime enrollment over HTTP (closes the onboarding loop) =====


@pytest.mark.asyncio
async def test_runtime_enroll_over_http_brings_runtime_online() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        _, _, token_body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/runtime/enrollment-token",
            {},
            headers={"Cookie": cookie},
        )
        token = json.loads(token_body)["enrollment_token"]

        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/runtime/enroll",
            {"enrollment_token": token, "hostname": "host-1", "version": "1.2.3"},
        )
        assert status == 200
        enrolled = json.loads(body)
        runtime_id = enrolled["runtime_id"]
        assert runtime_id

        runtime = await server.app.state.podium.store.get_runtime(runtime_id)
        conductor_rows = server.app.state.podium.store._load_map("conductors.json")
        conductor_rows[runtime_id]["version"] = "1.2.3"
        server.app.state.podium.store._write("conductors.json", conductor_rows)
        assert runtime is not None
        await server.app.state.podium.set_presence(runtime_id)
        # The workspace now reports an online runtime once presence is observed.
        status, _, status_body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/runtime/status",
            headers={"Cookie": cookie},
        )
        assert json.loads(status_body)["online_count"] == 1

        # The enrolled runtime is visible in the listing.
        _, _, list_body = await request(
            server.port, "GET", "/api/v1/runtimes", headers={"Cookie": cookie}
        )
        assert any(r["runtime_id"] == runtime_id and r["online"] for r in json.loads(list_body)["runtimes"])
        detail_status, _, detail_body = await request(
            server.port,
            "GET",
            f"/api/v1/runtimes/{runtime_id}",
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert detail_status == 200
    detail = json.loads(detail_body)
    assert detail["runtime_id"] == runtime_id
    assert detail["online"] is True
    assert detail["last_heartbeat"] is not None
    assert detail["version"] == "1.2.3"


@pytest.mark.asyncio
async def test_runtime_enroll_rejects_unknown_token() -> None:
    server = _server()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/runtime/enroll",
            {"enrollment_token": "never-issued"},
        )
    finally:
        await server.stop()

    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_enrollment_token"


@pytest.mark.asyncio
async def test_runtime_enroll_token_is_single_use() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        _, _, token_body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/runtime/enrollment-token",
            {},
            headers={"Cookie": cookie},
        )
        token = json.loads(token_body)["enrollment_token"]
        first, _, _ = await request(
            server.port, "POST", "/api/v1/runtime/enroll", {"enrollment_token": token}
        )
        second, _, body = await request(
            server.port, "POST", "/api/v1/runtime/enroll", {"enrollment_token": token}
        )
    finally:
        await server.stop()

    assert first == 200
    assert second == 400
    assert json.loads(body)["error"]["code"] == "enrollment_token_used"


@pytest.mark.asyncio
async def test_runtime_heartbeat_unknown_runtime_returns_404() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/runtimes/does-not-exist",
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_onboarding_runtime_status_reports_enrollment() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/runtime/status",
            headers={"Cookie": cookie},
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
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/onboarding/smoke-check",
            {},
            headers={"Cookie": cookie},
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
        ws, cookie = await _auth(server)
        await request(
            server.port,
            "POST",
            "/api/v1/onboarding/smoke-check",
            {},
            headers={"Cookie": cookie},
        )
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/onboarding/smoke-check/result",
            headers={"Cookie": cookie},
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
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        group_id = f"group_{ws}"
        await server.app.state.podium.store.upsert_runtime_group(
            {"id": group_id, "linear_workspace_id": ws, "managed_run_profile": "default"}
        )
        await server.app.state.podium.store.upsert_conductor({
            "id": "rt-1",
            "conductor_id": "rt-1",
            "user_id": ws,
            "runtime_group_id": group_id,
            "runtime_token_hash": "",
            "proxy_token_hash": "",
            "disabled": False,
            "revoked": False,
            "created_at": "2026-01-01T00:00:00Z",
        })
        await server.app.state.podium.store.upsert_project_binding({
            "id": "rt-1:inst-1",
            "conductor_id": "rt-1",
            "user_id": ws,
            "instance_id": "inst-1",
            "name": "Performer",
            "linear_project": "ALPHA",
            "project_slug": "ALPHA",
            "agent_app_user_id": "agent-app-1",
            "managed_run_profile": "default",
            "process_status": "running",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        })
        await server.app.state.podium.set_presence("rt-1")
        status, _, body = await request(
            server.port, "GET", "/api/v1/runtimes", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()

    assert status == 200
    payload = json.loads(body)
    assert any(r["runtime_id"] == "rt-1" and r["online"] for r in payload["runtimes"])
    binding = payload["conductors"][0]["bindings"][0]
    assert binding["managed_run_profile"] == "default"


@pytest.mark.asyncio
async def test_runtime_detail_404_for_unknown() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        status, _, body = await request(
            server.port, "GET", "/api/v1/runtimes/nope", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()

    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"


# ===== Managed Runs Runtime Surface =====


@pytest.mark.asyncio
async def test_legacy_runs_api_is_not_exposed() -> None:
    server = _server()
    await server.start(port=0)
    try:
        ws, cookie = await _auth(server)
        recent_status, _, _recent_body = await request(
            server.port, "GET", "/api/v1/runs/recent", headers={"Cookie": cookie}
        )
        detail_status, _, _detail_body = await request(
            server.port, "GET", "/api/v1/runs/run-1", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()

    assert recent_status == 404
    assert detail_status == 404
