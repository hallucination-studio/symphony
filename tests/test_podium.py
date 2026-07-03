from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx
import pytest

from podium.app import create_app
from podium.store.postgres import PgStore


def app_client(*, linear_webhook_secret: str = "", linear_graphql_transport: Any = None) -> httpx.AsyncClient:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret=linear_webhook_secret,
        linear_graphql_transport=linear_graphql_transport,
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://podium.test")


def app_client_with_store(store: object) -> httpx.AsyncClient:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        pg_store=store,
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://podium.test")


@pytest.mark.asyncio
async def test_auth_register_login_logout_without_echoing_secrets() -> None:
    async with app_client() as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={"email": "User@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert register.status_code == 200
        assert register.json()["user"] == {"id": "user_1", "email": "user@example.com", "linear_app": None}
        assert "password_hash" not in register.text
        assert "podium_session" in register.cookies

        me = await client.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json()["user"]["email"] == "user@example.com"

        await client.post("/api/v1/auth/logout")
        logged_out = await client.get("/api/v1/auth/me")
        assert logged_out.status_code == 401

        bad_turnstile = await client.post(
            "/api/v1/auth/login",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "bad"},
        )
        assert bad_turnstile.status_code == 400
        assert bad_turnstile.json()["error"]["code"] == "invalid_turnstile"

        login = await client.post(
            "/api/v1/auth/login",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert login.status_code == 200
        assert "correct-horse" not in login.text


@pytest.mark.asyncio
async def test_auth_session_survives_app_reconstruction_with_injected_store() -> None:
    store = PgStore()
    async with app_client_with_store(store) as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={"email": "restart@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert register.status_code == 200
        session_cookie = register.cookies["podium_session"]

    async with app_client_with_store(store) as restarted:
        restarted.cookies.set("podium_session", session_cookie)
        me = await restarted.get("/api/v1/auth/me")

    assert me.status_code == 200
    assert me.json()["user"]["email"] == "restart@example.com"


@pytest.mark.asyncio
async def test_runtime_enrollment_token_can_be_used_once() -> None:
    async with app_client() as client:
        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={
                "runtime_group_id": "group-1",
                "linear_workspace_id": "workspace-1",
                "project_slug": "ENG",
                "linear_agent_app_user_id": "app-user-1",
                "workflow_profile": "gated-task",
            },
        )
        assert token_response.status_code == 200
        enrollment_token = token_response.json()["enrollment_token"]

        first = await client.post("/api/v1/runtime/enroll", json={"enrollment_token": enrollment_token})
        assert first.status_code == 200
        payload = first.json()
        assert payload["runtime_id"] == "runtime_1"
        assert payload["runtime_group_id"] == "group-1"
        assert payload["runtime_token"]
        assert payload["proxy_token"]
        assert payload["websocket_url"] == "ws://podium.test/api/v1/runtime/ws"

        second = await client.post("/api/v1/runtime/enroll", json={"enrollment_token": enrollment_token})
        assert second.status_code == 400
        assert second.json()["error"]["code"] == "enrollment_token_used"


@pytest.mark.asyncio
async def test_linear_proxy_can_use_environment_access_token_without_workspace_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def linear_transport(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    monkeypatch.setenv("PODIUM_LINEAR_ACCESS_TOKEN", "operator-linear-token")
    async with app_client(linear_graphql_transport=linear_transport) as client:
        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={
                "runtime_group_id": "group-1",
                "linear_workspace_id": "ephemeral-workspace",
                "project_slug": "ENG",
                "linear_agent_app_user_id": "app-user-1",
            },
        )
        enrolled = (
            await client.post(
                "/api/v1/runtime/enroll",
                json={"enrollment_token": token_response.json()["enrollment_token"]},
            )
        ).json()

        proxied = await client.post(
            "/api/v1/linear/graphql",
            json={"query": "query { viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert proxied.status_code == 200
    assert proxied.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert captured["authorization"] == "operator-linear-token"


@pytest.mark.asyncio
async def test_agent_session_webhook_queues_only_delegated_custom_agent_dispatch_and_runtime_acks() -> None:
    secret = "webhook-secret"
    async with app_client(linear_webhook_secret=secret) as client:
        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={
                "runtime_group_id": "group-1",
                "linear_workspace_id": "workspace-1",
                "project_slug": "ENG",
                "linear_agent_app_user_id": "app-user-1",
                "workflow_profile": "gated-task",
            },
        )
        enrollment_token = token_response.json()["enrollment_token"]
        enrolled = (await client.post("/api/v1/runtime/enroll", json={"enrollment_token": enrollment_token})).json()

        bad_delegate = _agent_session_payload(delegate_id="other-app-user")
        bad_raw = json.dumps(bad_delegate).encode()
        rejected = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=bad_raw,
            headers={"Linear-Signature": _signature(bad_raw, secret), "Content-Type": "application/json"},
        )
        assert rejected.status_code == 200
        assert rejected.json()["queued"] == 0

        payload = _agent_session_payload(delegate_id="app-user-1")
        raw = json.dumps(payload).encode()
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=raw,
            headers={"Linear-Signature": _signature(raw, secret), "Content-Type": "application/json"},
        )
        assert queued.status_code == 200
        assert queued.json() == {"status": "accepted", "queued": 1}

        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        assert lease.status_code == 200
        dispatch = lease.json()["dispatch"]
        assert dispatch["dispatch_id"] == "dispatch_1"
        assert dispatch["issue_id"] == "issue-1"
        assert dispatch["issue_identifier"] == "ENG-1"
        assert dispatch["linear_workspace_id"] == "workspace-1"
        assert dispatch["project_slug"] == "ENG"
        assert dispatch["routing_rule_id"] == "group-1"
        assert dispatch["workflow_profile"] == "gated-task"

        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "runtime_phase": "completed",
            },
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        assert ack.status_code == 200
        assert ack.json()["dispatch"]["status"] == "completed"
        assert ack.json()["dispatch"]["reason"] == "completed_by_runtime"
        assert ack.json()["dispatch"]["runtime_phase"] == "completed"


@pytest.mark.asyncio
async def test_bff_lists_runtimes_for_signed_in_workspace() -> None:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "runtime-list@example.com",
                "password": "correct-horse",
                "turnstile_token": "turnstile-ok",
            },
        )
        assert register.status_code == 200

        token_response = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
        )
        enrolled = await client.post(
            "/api/v1/runtime/enroll",
            json={"enrollment_token": token_response.json()["enrollment_token"]},
        )
        runtime_id = enrolled.json()["runtime_id"]
        app.state.podium.presence[runtime_id] = "2026-01-01T00:00:00Z"

        response = await client.get("/api/v1/runtimes")

    assert response.status_code == 200
    payload = response.json()
    assert payload["runtimes"] == [
        {
            "runtime_id": runtime_id,
            "online": True,
            "last_heartbeat": "2026-01-01T00:00:00Z",
            "version": None,
            "metadata": {},
        }
    ]


@pytest.mark.asyncio
async def test_bff_recent_runs_and_detail_derive_from_runtime_dispatches() -> None:
    secret = "webhook-secret"
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret=secret,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "runs-list@example.com",
                "password": "correct-horse",
                "turnstile_token": "turnstile-ok",
            },
        )
        assert register.status_code == 200
        workspace_id = register.json()["user"]["id"]

        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={
                "runtime_group_id": f"group_{workspace_id}",
                "linear_workspace_id": "workspace-1",
                "project_slug": "ENG",
                "linear_agent_app_user_id": "app-user-1",
            },
        )
        enrolled = (
            await client.post(
                "/api/v1/runtime/enroll",
                json={"enrollment_token": token_response.json()["enrollment_token"]},
            )
        ).json()
        payload = _agent_session_payload(delegate_id="app-user-1")
        raw = json.dumps(payload).encode()
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=raw,
            headers={"Linear-Signature": _signature(raw, secret), "Content-Type": "application/json"},
        )
        assert queued.status_code == 200
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        dispatch = lease.json()["dispatch"]
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "status": "completed",
                "reason": "completed_by_runtime",
            },
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        assert ack.status_code == 200

        recent = await client.get("/api/v1/runs/recent?limit=5")
        detail = await client.get(f"/api/v1/runs/{dispatch['dispatch_id']}")

    assert recent.status_code == 200
    assert recent.json()["runs"][0]["run_id"] == dispatch["dispatch_id"]
    assert recent.json()["runs"][0]["status"] == "success"
    assert recent.json()["runs"][0]["runtime_id"] == enrolled["runtime_id"]
    assert detail.status_code == 200
    assert detail.json()["issue_identifier"] == "ENG-1"


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_signature_and_invalid_json() -> None:
    secret = "webhook-secret"
    async with app_client(linear_webhook_secret=secret) as client:
        bad_signature = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={"type": "AgentSessionEvent"},
            headers={"Linear-Signature": "bad"},
        )
        assert bad_signature.status_code == 401
        assert bad_signature.json()["error"]["code"] == "invalid_signature"

        bad_raw = b"{"
        bad_json = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=bad_raw,
            headers={"Linear-Signature": _signature(bad_raw, secret)},
        )
        assert bad_json.status_code == 400
        assert bad_json.json()["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_linear_proxy_requires_proxy_token_and_audits_requests() -> None:
    seen_authorization: list[str] = []

    def linear_transport(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers["Authorization"])
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    async with app_client(linear_graphql_transport=linear_transport) as client:
        token_response = await client.post(
            "/api/v1/runtime/enrollment-tokens",
            json={"runtime_group_id": "group-1", "linear_workspace_id": "workspace-1", "project_slug": "ENG"},
        )
        enrolled = (
            await client.post(
                "/api/v1/runtime/enroll",
                json={"enrollment_token": token_response.json()["enrollment_token"]},
            )
        ).json()

        unauthorized = await client.post("/api/v1/linear/graphql", json={"query": "{ viewer { id } }"})
        assert unauthorized.status_code == 401

        allowed = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )
        assert allowed.status_code == 400
        assert allowed.json()["error"]["code"] == "linear_installation_not_found"

        client._transport.app.state.podium.linear_installations["workspace-1"] = {
            "workspace_id": "workspace-1",
            "access_token": "oauth-installation-token",
            "scope": "read write",
            "expires_at": None,
        }
        allowed = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )
        assert allowed.status_code == 200
        assert allowed.json() == {"data": {"viewer": {"id": "viewer-1"}}}
        assert seen_authorization == ["oauth-installation-token"]


def _agent_session_payload(*, delegate_id: str) -> dict[str, Any]:
    return {
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
                "delegate": {"id": delegate_id},
            },
        },
    }


def _signature(raw: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
