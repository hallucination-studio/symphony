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


@pytest.mark.asyncio
async def test_full_onboarding_flow_reaches_complete(tmp_path) -> None:
    """
    Walk a workspace through the entire onboarding flow end-to-end via HTTP:
    bootstrap -> linear (pre-connected) -> scope -> repository ->
    runtime enrollment + heartbeat -> smoke check -> complete.
    """
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
        data_dir=tmp_path,
        secret_key="test-secret",
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        port = server.port
        assert port is not None

        # Establish a session; the workspace is derived from the user.
        _, reg_headers, reg_body = await request(
            port, "POST", "/api/v1/auth/register",
            {"email": "flow@example.com", "password": "password123"},
        )
        cookie = (reg_headers.get("set-cookie") or "").split(";", 1)[0]
        ws = json.loads(reg_body)["user"]["id"]
        # Seed a connected Linear installation for this user's workspace.
        server.linear_service.installations[ws] = {
            "workspace_id": ws,
            "access_token": "secret-linear-token",
            "scope": "read,write",
        }
        auth = {"Cookie": cookie}

        # 1. Bootstrap - Linear is already connected in this fixture, so the
        #    derived linear_connect step is reconciled and the flow opens at
        #    scope_selection. No direct complete_step calls anywhere below.
        status, headers, body = await request(port, "GET", "/api/v1/bootstrap", headers=auth)
        assert status == 200
        boot = json.loads(body)
        assert boot["onboarding"]["current_step"] == "scope_selection"
        assert "linear_connect" in boot["onboarding"]["completed_steps"]
        assert b"secret-linear-token" not in body

        # 2. Linear scope discovery
        status, headers, body = await request(port, "GET", "/api/v1/onboarding/linear/scope", headers=auth)
        assert status == 200
        scope_data = json.loads(body)
        assert scope_data["teams"][0]["id"] == "team-1"
        assert b"secret-linear-token" not in body

        # 3. Save scope (advances past linear_connect + scope_selection over HTTP)
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/scope",
            {"teams": ["team-1"], "projects": ["proj-1"]},
            headers=auth,
        )
        assert status == 200
        assert json.loads(body)["onboarding"]["current_step"] == "repository_mapping"

        # 4. Save repository
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/repository",
            {"mode": "git_url", "value": "https://github.com/acme/repo.git"},
            headers=auth,
        )
        assert status == 200
        repo_payload = json.loads(body)
        assert repo_payload["repository"]["validation_state"] == "valid"
        assert repo_payload["onboarding"]["current_step"] == "runtime_enrollment"

        # 5. Generate enrollment token (backend also composes the install command)
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/runtime/enrollment-token",
            {},
            headers=auth,
        )
        assert status == 200
        token_payload = json.loads(body)
        token = token_payload["enrollment_token"]
        assert token
        assert "--enrollment-token" in token_payload["install_command"]

        # 6. A real runtime (Conductor) enrolls purely over HTTP using the
        #    one-time token, then heartbeats. No in-process service calls: this
        #    alone must drive runtime_enrollment complete via derived-step
        #    reconciliation.
        status, headers, body = await request(
            port, "POST", "/api/v1/runtime/enroll",
            {"enrollment_token": token, "hostname": "runtime-host", "version": "1.0.0"},
        )
        assert status == 200
        runtime_id = json.loads(body)["runtime_id"]

        server.app.state.podium.presence[runtime_id] = "2026-01-01T00:00:00Z"

        status, headers, body = await request(port, "GET", "/api/v1/onboarding/runtime/status", headers=auth)
        assert status == 200
        assert json.loads(body)["online_count"] == 1

        status, headers, body = await request(port, "GET", "/api/v1/onboarding/status", headers=auth)
        assert status == 200
        assert "runtime_enrollment" in json.loads(body)["completed_steps"]

        # 7. Smoke check - all prerequisites met, should pass and complete onboarding
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/smoke-check", {}, headers=auth
        )
        assert status == 200
        smoke = json.loads(body)
        assert smoke["status"] == "passed"
        assert smoke["recommendations"] == []

        # 8. Final bootstrap - onboarding complete, reached over HTTP only
        status, headers, body = await request(port, "GET", "/api/v1/bootstrap", headers=auth)
        assert status == 200
        final = json.loads(body)
        assert final["onboarding"]["current_step"] == "complete"
        assert b"secret-linear-token" not in body
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_onboarding_state_persists_across_server_restart(tmp_path) -> None:
    """Onboarding progress written to disk survives a server restart."""
    server1 = PodiumServer(data_dir=tmp_path, secret_key="test-secret")
    await server1.start(port=0)
    try:
        _, reg_headers, reg_body = await request(
            server1.port, "POST", "/api/v1/auth/register",
            {"email": "persist@example.com", "password": "password123"},
        )
        cookie = (reg_headers.get("set-cookie") or "").split(";", 1)[0]
        await request(
            server1.port, "POST", "/api/v1/onboarding/repository",
            {"mode": "local_path", "value": "/srv/repo"},
            headers={"Cookie": cookie},
        )
    finally:
        await server1.stop()

    # New server instance loads from the same data_dir
    server2 = PodiumServer(data_dir=tmp_path, secret_key="test-secret")
    await server2.start(port=0)
    try:
        # Log in again to obtain a fresh session for the same user.
        _, login_headers, _ = await request(
            server2.port, "POST", "/api/v1/auth/login",
            {"email": "persist@example.com", "password": "password123"},
        )
        cookie = (login_headers.get("set-cookie") or "").split(";", 1)[0]
        status, _, body = await request(
            server2.port, "GET", "/api/v1/onboarding/status",
            headers={"Cookie": cookie},
        )
        assert status == 200
        payload = json.loads(body)
        assert "repository_mapping" in payload["completed_steps"]
    finally:
        await server2.stop()
