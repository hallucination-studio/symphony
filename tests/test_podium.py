from __future__ import annotations

import asyncio
import hmac
import hashlib
import json

import httpx
import pytest

from podium.app import create_app
from podium.server import PodiumServer


async def request(port: int, method: str, path: str, body: object | bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
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


@pytest.mark.asyncio
async def test_podium_accepts_conductor_registration() -> None:
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1", "metadata": {"version": "test"}},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(body) == {"conductor_id": "cond-1", "message": "accepted", "status": "accepted"}


@pytest.mark.asyncio
async def test_podium_rejects_invalid_json() -> None:
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "POST", "/api/v1/conductors/register", b"{")
    finally:
        await server.stop()

    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_podium_rejects_unauthorized_registration_when_token_is_configured() -> None:
    server = PodiumServer(token="secret")
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1"},
        )
    finally:
        await server.stop()

    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_podium_oauth_callback_saves_token_without_echoing_secret() -> None:
    server = PodiumServer(
        linear_client_id="client-1",
        linear_client_secret="client-secret",
        linear_redirect_uri="https://podium.example/api/v1/linear/oauth/callback",
        linear_token_exchange=lambda code: {
            "access_token": f"access-{code}",
            "refresh_token": "refresh-secret",
            "expires_in": 3600,
            "scope": "read,write",
            "app_user_id": "app-user-1",
            "workspace_id": "workspace-1",
        },
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/linear/oauth/callback?code=abc&state=workspace-1",
        )
    finally:
        await server.stop()

    payload = json.loads(body)
    assert status == 200
    assert payload["installation"]["workspace_id"] == "workspace-1"
    assert payload["installation"]["scope"] == "read,write"
    assert b"access-abc" not in body
    assert b"refresh-secret" not in body


@pytest.mark.asyncio
async def test_podium_webhook_rejects_bad_signature_and_invalid_json() -> None:
    server = PodiumServer(linear_webhook_secret="webhook-secret")
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/webhooks/agent-session",
            {"type": "AgentSessionEvent"},
            headers={"Linear-Signature": "bad"},
        )
        bad_json_status, _, bad_json_body = await request(
            server.port,
            "POST",
            "/api/v1/linear/webhooks/agent-session",
            b"{",
            headers={"Linear-Signature": _signature(b"{", "webhook-secret")},
        )
    finally:
        await server.stop()

    assert status == 401
    assert json.loads(body)["error"]["code"] == "invalid_signature"
    assert bad_json_status == 400
    assert json.loads(bad_json_body)["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_agent_session_event_is_normalized_with_linear_agent_app_user() -> None:
    received: list[dict[str, object]] = []

    async def dispatch(payload: dict[str, object], registration) -> None:
        received.append({"payload": payload, "registration": registration.to_dict()})

    body = {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": "workspace-1"},
        "agentSession": {
            "id": "session-1",
            "appUserId": "app-user-1",
            "issue": {
                "id": "issue-1",
                "identifier": "ENG-1",
                "project": {"slugId": "ENG"},
                "assignee": {"id": "human-user-1"},
            },
        },
    }
    raw = json.dumps(body).encode()
    server = PodiumServer(linear_webhook_secret="webhook-secret", dispatch_callback=dispatch)
    await server.start(port=0)
    try:
        assert server.port is not None
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-1",
                "callback_url": "https://conductor.example/api/podium/dispatch",
                "dispatch_token": "dispatch-secret",
                "proxy_token": "proxy-secret",
                "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"},
            },
        )
        status, _, response_body = await request(
            server.port,
            "POST",
            "/api/v1/linear/webhooks/agent-session",
            raw,
            headers={"Linear-Signature": _signature(raw, "webhook-secret")},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(response_body)["dispatched"] == 1
    assert received[0]["payload"] == {
        "event_type": "linear.agent_session.created",
        "workspace_id": "workspace-1",
        "project_slug": "ENG",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "agent_session_id": "session-1",
        "agent_app_user_id": "app-user-1",
        "raw_action": "created",
    }
    assert received[0]["registration"]["conductor_id"] == "cond-1"


@pytest.mark.asyncio
async def test_linear_graphql_proxy_uses_saved_oauth_token_and_rejects_invalid_proxy_token() -> None:
    requests: list[dict[str, object]] = []

    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        requests.append(
            {
                "url": str(request.url),
                "authorization": request.headers.get("Authorization"),
                "json": json.loads(request.content.decode()),
            }
        )
        return httpx.Response(200, json={"data": {"viewer": {"id": "me"}}}, request=request)

    server = PodiumServer(
        linear_installations={
            "workspace-1": {"access_token": "linear-oauth-token", "workspace_id": "workspace-1"}
        },
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-1",
                "proxy_token": "proxy-secret",
                "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"},
            },
        )
        unauthorized_status, _, unauthorized_body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer wrong"},
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer proxy-secret"},
        )
    finally:
        await server.stop()

    assert unauthorized_status == 401
    assert json.loads(unauthorized_body)["error"]["code"] == "unauthorized"
    assert status == 200
    assert json.loads(body) == {"data": {"viewer": {"id": "me"}}}
    assert requests == [
        {
            "url": "https://api.linear.app/graphql",
            "authorization": "Bearer linear-oauth-token",
            "json": {"query": "query Viewer { viewer { id } }"},
        }
    ]


@pytest.mark.asyncio
async def test_linear_graphql_proxy_accepts_raw_proxy_token_for_performer_tracker() -> None:
    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"viewer": {"id": "me"}}}, request=request)

    server = PodiumServer(
        linear_installations={
            "workspace-1": {"access_token": "linear-oauth-token", "workspace_id": "workspace-1"}
        },
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-1",
                "proxy_token": "proxy-secret",
                "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"},
            },
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "proxy-secret"},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(body) == {"data": {"viewer": {"id": "me"}}}


@pytest.mark.asyncio
async def test_linear_graphql_proxy_forwards_linear_api_key_without_bearer_prefix() -> None:
    requests: list[dict[str, object]] = []

    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        requests.append({"authorization": request.headers.get("Authorization")})
        return httpx.Response(200, json={"data": {"viewer": {"id": "me"}}}, request=request)

    server = PodiumServer(
        linear_installations={
            "workspace-1": {"access_token": "lin_api_real_key", "workspace_id": "workspace-1"}
        },
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-1",
                "proxy_token": "proxy-secret",
                "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"},
            },
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "proxy-secret"},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(body) == {"data": {"viewer": {"id": "me"}}}
    assert requests == [{"authorization": "lin_api_real_key"}]


def _signature(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_managed_auth_register_login_me_logout_with_turnstile_mock() -> None:
    app = create_app(
        turnstile_verifier=lambda token, ip=None: token == "valid-turnstile",
        secure_cookies=False,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://podium.test") as client:
        invalid = await client.post(
            "/api/v1/auth/register",
            json={"email": "user@example.com", "password": "correct horse battery staple", "turnstile_token": "bad"},
        )
        created = await client.post(
            "/api/v1/auth/register",
            json={"email": "user@example.com", "password": "correct horse battery staple", "turnstile_token": "valid-turnstile"},
        )
        me = await client.get("/api/v1/auth/me")
        logout = await client.post("/api/v1/auth/logout")
        logged_out = await client.get("/api/v1/auth/me")

    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "invalid_turnstile"
    assert created.status_code == 200
    assert created.json()["user"] == {"id": "user_1", "email": "user@example.com"}
    assert "password" not in created.text
    assert "session" not in created.json()
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "user@example.com"
    assert logout.status_code == 200
    assert logged_out.status_code == 401


@pytest.mark.asyncio
async def test_runtime_enrollment_token_is_one_time_and_dispatch_can_be_acked() -> None:
    app = create_app(secure_cookies=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://podium.test") as client:
        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={
                "runtime_group_id": "group-1",
                "linear_workspace_id": "workspace-1",
                "project_slug": "ENG",
                "linear_agent_app_user_id": "app-user-1",
            },
        )
        enrollment_token = token_response.json()["enrollment_token"]
        enrolled = await client.post("/api/v1/runtime/enroll", json={"enrollment_token": enrollment_token})
        reused = await client.post("/api/v1/runtime/enroll", json={"enrollment_token": enrollment_token})
        wrong_agent_webhook = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={
                "type": "AgentSessionEvent",
                "action": "created",
                "workspace": {"id": "workspace-1"},
                "agentSession": {
                    "id": "session-wrong",
                    "appUserId": "other-app-user",
                    "issue": {"id": "issue-wrong", "identifier": "ENG-0", "project": {"slugId": "ENG"}},
                },
            },
        )
        webhook = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={
                "type": "AgentSessionEvent",
                "action": "created",
                "workspace": {"id": "workspace-1"},
                "agentSession": {
                    "id": "session-1",
                    "appUserId": "app-user-1",
                    "issue": {"id": "issue-1", "identifier": "ENG-1", "project": {"slugId": "ENG"}},
                },
            },
        )
        runtime_token = enrolled.json()["runtime_token"]
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {runtime_token}"},
        )
        dispatch_id = lease.json()["dispatch"]["dispatch_id"]
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {runtime_token}"},
            json={"dispatch_id": dispatch_id, "status": "accepted"},
        )

    assert token_response.status_code == 200
    assert enrolled.status_code == 200
    assert enrolled.json()["websocket_url"] == "ws://podium.test/api/v1/runtime/ws"
    assert enrolled.json()["proxy_token"]
    assert reused.status_code == 400
    assert reused.json()["error"]["code"] == "enrollment_token_used"
    assert wrong_agent_webhook.status_code == 200
    assert wrong_agent_webhook.json()["queued"] == 0
    assert webhook.status_code == 200
    assert webhook.json()["queued"] == 1
    assert lease.status_code == 200
    assert lease.json()["dispatch"]["issue_id"] == "issue-1"
    assert lease.json()["dispatch"]["issue_identifier"] == "ENG-1"
    assert lease.json()["dispatch"]["linear_workspace_id"] == "workspace-1"
    assert lease.json()["dispatch"]["agent_session_id"] == "session-1"
    assert lease.json()["dispatch"]["agent_app_user_id"] == "app-user-1"
    assert lease.json()["dispatch"]["project_slug"] == "ENG"
    assert lease.json()["dispatch"]["workflow_profile"] == "task"
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "accepted"
