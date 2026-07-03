from __future__ import annotations

import httpx
import pytest

from podium.app import create_app


def app_client() -> httpx.AsyncClient:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://podium.test")


@pytest.mark.asyncio
async def test_bootstrap_requires_auth() -> None:
    async with app_client() as client:
        resp = await client.get("/api/v1/bootstrap")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_bootstrap_aggregates_session_onboarding_linear() -> None:
    async with app_client() as client:
        await client.post(
            "/api/v1/auth/register",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        resp = await client.get("/api/v1/bootstrap")
        assert resp.status_code == 200
        body = resp.json()

        assert body["session"] == {
            "workspace_id": "user_1",
            "user_id": "user_1",
            "email": "user@example.com",
        }
        assert set(body["onboarding"]) == {"current_step", "completed_steps", "next_action"}
        assert body["linear"] == {"workspace_id": "user_1", "state": "not_connected"}

        # No token/secret fields must leak anywhere in the payload.
        raw = resp.text
        for leak in ("token", "password_hash", "runtime_token", "proxy_token", "expires_at"):
            assert leak not in raw


@pytest.mark.asyncio
async def test_bootstrap_reflects_connected_linear_without_tokens() -> None:
    app = create_app(turnstile_verifier=lambda token, _ip: token == "turnstile-ok", secure_cookies=False)
    app.state.podium.linear_installations["user_1"] = {
        "scope": ["read", "write"],
        "expires_at": "2099-01-01T00:00:00Z",
        "access_token": "SECRET-should-not-leak",
    }
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://podium.test") as client:
        await client.post(
            "/api/v1/auth/register",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        resp = await client.get("/api/v1/bootstrap")
        assert resp.status_code == 200
        body = resp.json()
        assert body["linear"]["state"] == "connected"
        assert body["linear"]["scope"] == ["read", "write"]
        assert "access_token" not in resp.text
        assert "SECRET-should-not-leak" not in resp.text
