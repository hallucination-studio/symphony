from __future__ import annotations

import urllib.parse
import json

import httpx
import pytest

from podium.app import create_app
from podium.store import PodiumStore


OFFICIAL_KWARGS = dict(
    turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    secure_cookies=False,
    secret_key="test-secret-key",
    linear_client_id="official-client-id",
    linear_client_secret="official-client-secret",
    linear_redirect_uri="https://podium.test/api/v1/linear/oauth/callback",
)


def app_client(**overrides) -> tuple[httpx.AsyncClient, object]:
    kwargs = {**OFFICIAL_KWARGS, **overrides}
    app = create_app(**kwargs)
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://podium.test")
    return client, app


async def _register(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
    )
    assert resp.status_code == 200


def _auth_url_params(url: str) -> dict[str, str]:
    parsed = urllib.parse.urlparse(url)
    return dict(urllib.parse.parse_qsl(parsed.query))


@pytest.mark.asyncio
async def test_official_app_used_when_no_custom_app() -> None:
    client, _app = app_client()
    async with client:
        await _register(client)
        resp = await client.post("/api/v1/onboarding/linear/start")
        assert resp.status_code == 200
        url = resp.json()["authorization_url"]
        params = _auth_url_params(url)
        assert params["client_id"] == "official-client-id"
        assert params["actor"] == "app"
        assert "app:assignable" in params["scope"]
        assert "app:mentionable" in params["scope"]
        assert params["state"] != "user_1"
        assert len(params["state"]) >= 24


@pytest.mark.asyncio
async def test_custom_app_configured_and_never_echoes_secret() -> None:
    client, _app = app_client()
    async with client:
        await _register(client)

        put = await client.put(
            "/api/v1/account/linear-app",
            json={
                "client_id": "custom-client-id",
                "client_secret": "super-secret-value",
                "redirect_uri": "https://custom.example/callback",
            },
        )
        assert put.status_code == 200
        assert put.json()["linear_app"] == {
            "client_id": "custom-client-id",
            "redirect_uri": "https://custom.example/callback",
            "configured": True,
        }
        assert "super-secret-value" not in put.text

        me = await client.get("/api/v1/auth/me")
        assert me.status_code == 200
        user = me.json()["user"]
        assert user["linear_app"] == {
            "client_id": "custom-client-id",
            "redirect_uri": "https://custom.example/callback",
            "configured": True,
        }
        assert "super-secret-value" not in me.text

        start = await client.post("/api/v1/onboarding/linear/start")
        params = _auth_url_params(start.json()["authorization_url"])
        assert params["client_id"] == "custom-client-id"
        assert params["redirect_uri"] == "https://custom.example/callback"
        assert params["actor"] == "app"
        assert "app:assignable" in params["scope"]
        assert "app:mentionable" in params["scope"]


@pytest.mark.asyncio
async def test_delete_custom_app_clears_config() -> None:
    client, _app = app_client()
    async with client:
        await _register(client)
        await client.put(
            "/api/v1/account/linear-app",
            json={"client_id": "custom-client-id", "client_secret": "x"},
        )
        delete = await client.delete("/api/v1/account/linear-app")
        assert delete.status_code == 200
        assert delete.json() == {"ok": True, "linear_app": None}

        me = await client.get("/api/v1/auth/me")
        assert me.json()["user"]["linear_app"] is None


@pytest.mark.asyncio
async def test_put_linear_app_requires_secret_key() -> None:
    client, _app = app_client(secret_key="")
    async with client:
        await _register(client)
        resp = await client.put(
            "/api/v1/account/linear-app",
            json={"client_id": "custom-client-id", "client_secret": "x"},
        )
        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "encryption_unavailable"


@pytest.mark.asyncio
async def test_callback_stores_installation_and_marks_onboarding() -> None:
    def fake_exchange(code: str, state: str) -> dict[str, object]:
        assert code == "the-code"
        assert state == oauth_state
        return {"access_token": "SECRET-token", "scope": "read,write", "expires_in": 3600}

    oauth_state = ""
    client, app = app_client(linear_token_exchange=fake_exchange)
    async with client:
        await _register(client)
        start = await client.post("/api/v1/onboarding/linear/start")
        oauth_state = _auth_url_params(start.json()["authorization_url"])["state"]

        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "the-code", "state": oauth_state},
        )
        assert callback.status_code == 200
        assert "text/html" in callback.headers["content-type"]
        assert "SECRET-token" not in callback.text

        installation = await app.state.podium.get_linear_installation("user_1")
        assert installation is not None
        assert installation["access_token"] == "SECRET-token"

        boot = await client.get("/api/v1/bootstrap")
        assert boot.status_code == 200
        body = boot.json()
        assert body["linear"]["state"] == "connected"
        assert "SECRET-token" not in boot.text

        status = await client.get("/api/v1/onboarding/status")
        assert "linear_connect" in status.json()["completed_steps"]


@pytest.mark.asyncio
async def test_callback_persists_installation_across_app_restart_without_public_secret_leak() -> None:
    def fake_exchange(code: str, state: str) -> dict[str, object]:
        return {"access_token": "SECRET-token", "scope": "read,write", "expires_in": 3600}

    store = PodiumStore()
    client, _app = app_client(store=store, linear_token_exchange=fake_exchange)
    async with client:
        await _register(client)
        start = await client.post("/api/v1/onboarding/linear/start")
        oauth_state = _auth_url_params(start.json()["authorization_url"])["state"]
        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "the-code", "state": oauth_state},
        )
        assert callback.status_code == 200

    restarted_client, _restarted_app = app_client(store=store)
    async with restarted_client:
        login = await restarted_client.post(
            "/api/v1/auth/login",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert login.status_code == 200
        boot = await restarted_client.get("/api/v1/bootstrap")
        assert boot.status_code == 200
        assert boot.json()["linear"]["state"] == "connected"
        assert "SECRET-token" not in boot.text


@pytest.mark.asyncio
async def test_oauth_callback_consumes_state_created_by_distinct_worker() -> None:
    def fake_exchange(code: str, state: str) -> dict[str, object]:
        assert code == "the-code"
        assert state == oauth_state
        return {"access_token": "SECRET-token", "scope": "read,write", "expires_in": 3600}

    store = PodiumStore()
    start_client, _start_app = app_client(store=store)
    async with start_client:
        await _register(start_client)
        start = await start_client.post("/api/v1/onboarding/linear/start")
        oauth_state = _auth_url_params(start.json()["authorization_url"])["state"]

    callback_client, callback_app = app_client(store=store, linear_token_exchange=fake_exchange)
    async with callback_client:
        callback = await callback_client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "the-code", "state": oauth_state},
        )

    assert callback.status_code == 200
    assert (await store.consume_oauth_state(oauth_state)) is None
    installation = await callback_app.state.podium.get_linear_installation("user_1")
    assert installation is not None
    assert installation["access_token"] == "SECRET-token"
    assert installation["actor"] == "app"


@pytest.mark.asyncio
async def test_callback_missing_state_returns_400() -> None:
    client, _app = app_client()
    async with client:
        resp = await client.get("/api/v1/linear/oauth/callback", params={"code": "the-code"})
        assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "missing_state"


@pytest.mark.asyncio
async def test_linear_start_returns_structured_error_for_corrupt_custom_secret() -> None:
    client, app = app_client()
    async with client:
        await _register(client)
        await app.state.podium.set_user_linear_app(
            "user_1",
            {
                "client_id": "custom-client",
                "client_secret_encrypted": "not-a-fernet-token",
                "redirect_uri": "https://custom.example/callback",
            },
        )

        resp = await client.post("/api/v1/onboarding/linear/start")

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "secret_decryption_failed"


@pytest.mark.asyncio
async def test_callback_missing_code_returns_400() -> None:
    client, _app = app_client()
    async with client:
        resp = await client.get("/api/v1/linear/oauth/callback", params={"state": "user_1"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "missing_code"


@pytest.mark.asyncio
async def test_callback_rejects_unknown_oauth_state() -> None:
    client, _app = app_client()
    async with client:
        await _register(client)
        resp = await client.get("/api/v1/linear/oauth/callback", params={"code": "the-code", "state": "user_1"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "invalid_state"


@pytest.mark.asyncio
async def test_scope_returns_teams_projects_using_stored_token() -> None:
    seen: dict[str, str] = {}

    def fake_exchange(code: str, state: str) -> dict[str, object]:
        return {"access_token": "SECRET-token", "scope": "read,write"}

    def fake_scope_fetch(workspace_id: str, access_token: str) -> dict[str, object]:
        seen["workspace_id"] = workspace_id
        seen["access_token"] = access_token
        return {
            "teams": [{"id": "team_1", "name": "Engineering", "key": "ENG"}],
            "projects": [{"id": "proj_1", "name": "Podium"}],
        }

    client, _app = app_client(
        linear_token_exchange=fake_exchange,
        linear_scope_fetch=fake_scope_fetch,
    )
    async with client:
        await _register(client)
        start = await client.post("/api/v1/onboarding/linear/start")
        oauth_state = _auth_url_params(start.json()["authorization_url"])["state"]
        await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "c", "state": oauth_state},
        )
        resp = await client.get("/api/v1/onboarding/linear/scope")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "teams": [{"id": "team_1", "name": "Engineering", "key": "ENG"}],
            "projects": [{"id": "proj_1", "name": "Podium"}],
        }
        assert seen == {"workspace_id": "user_1", "access_token": "SECRET-token"}


@pytest.mark.asyncio
async def test_scope_without_installation_returns_400() -> None:
    client, _app = app_client()
    async with client:
        await _register(client)
        resp = await client.get("/api/v1/onboarding/linear/scope")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "linear_installation_not_found"
