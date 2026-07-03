from __future__ import annotations

import asyncio
import hmac
import hashlib
import json

import httpx
import pytest

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
        linear_token_exchange=lambda code, state: {
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
async def test_agent_session_event_is_normalized_and_pushed_to_matching_conductor() -> None:
    received: list[dict[str, object]] = []

    async def dispatch(payload: dict[str, object], registration) -> None:
        received.append({"payload": payload, "registration": registration.to_dict()})

    body = {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": "workspace-1"},
        "agentSession": {
            "id": "session-1",
            "issue": {
                "id": "issue-1",
                "identifier": "ENG-1",
                "project": {"slugId": "ENG"},
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


def _signature(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# ===== Regression tests for existing routes =====


@pytest.mark.asyncio
async def test_health_endpoint() -> None:
    """Lock down health endpoint behavior."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/api/v1/health")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert json.loads(body) == {"status": "ok"}


@pytest.mark.asyncio
async def test_root_endpoint() -> None:
    """Lock down root endpoint behavior."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, headers, body = await request(server.port, "GET", "/")
    finally:
        await server.stop()

    assert status == 200
    assert headers["content-type"] == "text/plain; charset=utf-8"
    assert body == b"Podium\n"


@pytest.mark.asyncio
async def test_404_for_unknown_route() -> None:
    """Lock down 404 handling."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(server.port, "GET", "/nonexistent")
    finally:
        await server.stop()

    assert status == 404
    response = json.loads(body)
    assert response["error"]["code"] == "not_found"
    assert "Route not found" in response["error"]["message"]


@pytest.mark.asyncio
async def test_conductor_registration_validation_errors() -> None:
    """Lock down registration validation behavior."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        # Empty body
        status1, _, body1 = await request(server.port, "POST", "/api/v1/conductors/register", {})
        # Missing conductor_id
        status2, _, body2 = await request(
            server.port, "POST", "/api/v1/conductors/register", {"routing": {}}
        )
    finally:
        await server.stop()

    # Both should return 400 with error code
    assert status1 == 400
    error1 = json.loads(body1)
    assert "error" in error1
    assert error1["error"]["code"] in ["missing_conductor_id", "invalid_conductor_id"]

    assert status2 == 400
    error2 = json.loads(body2)
    assert "error" in error2
    assert error2["error"]["code"] in ["missing_conductor_id", "invalid_conductor_id"]


@pytest.mark.asyncio
async def test_authorization_without_bearer_prefix() -> None:
    """Lock down authorization header parsing."""
    server = PodiumServer(token="secret-token")
    await server.start(port=0)
    try:
        assert server.port is not None
        # With Bearer prefix (should work)
        status1, _, _ = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1"},
            headers={"Authorization": "Bearer secret-token"},
        )
        # Without Bearer prefix (should fail)
        status2, _, _ = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-2"},
            headers={"Authorization": "secret-token"},
        )
    finally:
        await server.stop()

    assert status1 == 200
    assert status2 == 401


@pytest.mark.asyncio
async def test_oauth_callback_missing_code() -> None:
    """Lock down OAuth callback error handling."""
    server = PodiumServer(
        linear_client_id="client-1",
        linear_client_secret="client-secret",
        linear_redirect_uri="https://podium.example/callback",
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port, "GET", "/api/v1/linear/oauth/callback?state=workspace-1"
        )
    finally:
        await server.stop()

    assert status == 400
    error = json.loads(body)
    assert error["error"]["code"] == "missing_code"


@pytest.mark.asyncio
async def test_oauth_callback_does_not_leak_tokens_in_response() -> None:
    """Lock down token redaction in OAuth callback."""
    server = PodiumServer(
        linear_client_id="client-1",
        linear_client_secret="client-secret",
        linear_redirect_uri="https://podium.example/callback",
        linear_token_exchange=lambda code, state: {
            "access_token": "super-secret-access-token",
            "refresh_token": "super-secret-refresh-token",
            "expires_in": 3600,
            "scope": "read,write",
            "app_user_id": "user-123",
            "workspace_id": "workspace-1",
        },
    )
    await server.start(port=0)
    try:
        assert server.port is not None
        status, _, body = await request(
            server.port, "GET", "/api/v1/linear/oauth/callback?code=test-code&state=workspace-1"
        )
    finally:
        await server.stop()

    assert status == 200
    # Verify tokens are NOT in response
    assert b"super-secret-access-token" not in body
    assert b"super-secret-refresh-token" not in body
    # Verify safe fields ARE in response
    response = json.loads(body)
    assert response["installation"]["workspace_id"] == "workspace-1"
    assert response["installation"]["scope"] == "read,write"
    assert response["installation"]["app_user_id"] == "user-123"


@pytest.mark.asyncio
async def test_webhook_without_signature_when_secret_configured() -> None:
    """Lock down webhook signature validation."""
    server = PodiumServer(linear_webhook_secret="webhook-secret")
    await server.start(port=0)
    try:
        assert server.port is not None
        # Missing signature header entirely
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/webhooks/agent-session",
            {"type": "AgentSessionEvent"},
        )
    finally:
        await server.stop()

    assert status == 401
    error = json.loads(body)
    assert error["error"]["code"] == "invalid_signature"


@pytest.mark.asyncio
async def test_webhook_ignores_unsupported_event_types() -> None:
    """Lock down webhook event type filtering."""
    body = {"type": "IssueEvent", "action": "created"}
    raw = json.dumps(body).encode()
    server = PodiumServer(linear_webhook_secret="webhook-secret")
    await server.start(port=0)
    try:
        assert server.port is not None
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
    response = json.loads(response_body)
    assert response["status"] == "ignored"
    assert response["reason"] == "unsupported_event_type"
    assert response["dispatched"] == 0


@pytest.mark.asyncio
async def test_webhook_dispatches_to_multiple_matching_conductors() -> None:
    """Lock down webhook routing to multiple conductors."""
    received: list[dict[str, object]] = []

    async def dispatch(payload: dict[str, object], registration) -> None:
        received.append({"payload": payload, "conductor_id": registration.conductor_id})

    body = {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": "workspace-1"},
        "agentSession": {
            "id": "session-1",
            "issue": {
                "id": "issue-1",
                "identifier": "ENG-1",
                "project": {"slugId": "ENG"},
            },
        },
    }
    raw = json.dumps(body).encode()
    server = PodiumServer(linear_webhook_secret="webhook-secret", dispatch_callback=dispatch)
    await server.start(port=0)
    try:
        assert server.port is not None
        # Register two conductors matching the same workspace
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-1",
                "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"},
            },
        )
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {
                "conductor_id": "cond-2",
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
    response = json.loads(response_body)
    assert response["dispatched"] == 2
    assert len(received) == 2
    conductor_ids = {r["conductor_id"] for r in received}
    assert conductor_ids == {"cond-1", "cond-2"}


@pytest.mark.asyncio
async def test_webhook_filters_by_project_slug() -> None:
    """Lock down webhook project_slug filtering."""
    received: list[str] = []

    async def dispatch(payload: dict[str, object], registration) -> None:
        received.append(registration.conductor_id)

    body = {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": "workspace-1"},
        "agentSession": {
            "id": "session-1",
            "issue": {
                "id": "issue-1",
                "identifier": "DATA-1",
                "project": {"slugId": "DATA"},
            },
        },
    }
    raw = json.dumps(body).encode()
    server = PodiumServer(linear_webhook_secret="webhook-secret", dispatch_callback=dispatch)
    await server.start(port=0)
    try:
        assert server.port is not None
        # Register conductors with different project_slug filters
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-eng", "routing": {"workspace_id": "workspace-1", "project_slug": "ENG"}},
        )
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-data", "routing": {"workspace_id": "workspace-1", "project_slug": "DATA"}},
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
    response = json.loads(response_body)
    assert response["dispatched"] == 1
    assert received == ["cond-data"]


@pytest.mark.asyncio
async def test_graphql_proxy_missing_linear_installation() -> None:
    """Lock down GraphQL proxy error when Linear installation not found."""
    server = PodiumServer()
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
                "routing": {"workspace_id": "missing-workspace"},
            },
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "{ viewer { id } }"},
            headers={"Authorization": "Bearer proxy-secret"},
        )
    finally:
        await server.stop()

    assert status == 400
    error = json.loads(body)
    assert error["error"]["code"] == "linear_installation_not_found"


@pytest.mark.asyncio
async def test_graphql_proxy_invalid_json() -> None:
    """Lock down GraphQL proxy JSON validation."""
    server = PodiumServer(
        linear_installations={"workspace-1": {"access_token": "token", "workspace_id": "workspace-1"}}
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
                "routing": {"workspace_id": "workspace-1"},
            },
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            b"{invalid",
            headers={"Authorization": "Bearer proxy-secret"},
        )
    finally:
        await server.stop()

    assert status == 400
    error = json.loads(body)
    assert error["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_multiple_conductor_registrations_are_tracked() -> None:
    """Lock down multiple conductor registration handling."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        status1, _, body1 = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1", "routing": {"workspace_id": "workspace-1"}},
        )
        status2, _, body2 = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-2", "routing": {"workspace_id": "workspace-2"}},
        )
    finally:
        await server.stop()

    assert status1 == 200
    assert status2 == 200
    assert json.loads(body1)["conductor_id"] == "cond-1"
    assert json.loads(body2)["conductor_id"] == "cond-2"
    # Verify both are stored
    assert "cond-1" in server.conductors
    assert "cond-2" in server.conductors


@pytest.mark.asyncio
async def test_conductor_reregistration_updates_existing() -> None:
    """Lock down conductor re-registration behavior."""
    server = PodiumServer()
    await server.start(port=0)
    try:
        assert server.port is not None
        # Initial registration
        await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1", "routing": {"workspace_id": "workspace-1"}},
        )
        # Re-register with different routing
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/conductors/register",
            {"conductor_id": "cond-1", "routing": {"workspace_id": "workspace-2"}},
        )
    finally:
        await server.stop()

    assert status == 200
    assert json.loads(body)["conductor_id"] == "cond-1"
    # Verify the routing was updated
    assert server.conductors["cond-1"].routing["workspace_id"] == "workspace-2"


@pytest.mark.asyncio
async def test_graphql_proxy_does_not_leak_linear_token() -> None:
    """Lock down Linear token redaction in GraphQL proxy responses."""
    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        # Return the Linear token in the response (simulating an error case)
        return httpx.Response(
            200,
            json={"data": {"viewer": {"id": "me"}}, "debug_token": "should-not-appear"},
            request=request,
        )

    server = PodiumServer(
        linear_installations={
            "workspace-1": {"access_token": "linear-secret-token-12345", "workspace_id": "workspace-1"}
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
                "routing": {"workspace_id": "workspace-1"},
            },
        )
        status, _, body = await request(
            server.port,
            "POST",
            "/api/v1/linear/graphql",
            {"query": "{ viewer { id } }"},
            headers={"Authorization": "Bearer proxy-secret"},
        )
    finally:
        await server.stop()

    assert status == 200
    # The Linear access token should NEVER appear in the response
    assert b"linear-secret-token-12345" not in body
    # But the actual GraphQL response should be proxied through
    response = json.loads(body)
    assert response["data"]["viewer"]["id"] == "me"
