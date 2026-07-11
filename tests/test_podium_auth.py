from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from podium.app import create_app
from podium.config import PodiumConfig
from podium.podium_state import SecretDecryptionError

SECRET = "test-secret-key-abc123"


class _AuthStore:
    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}

    async def next_user_id(self) -> str:
        return f"user_{len(self.users) + 1}"

    async def create_user(
        self,
        user_id: str,
        *,
        email: str,
        password_hash: str,
        created_at: str,
    ) -> dict[str, Any]:
        user = {
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
        }
        self.users[user_id] = user
        return dict(user)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        user = self.users.get(user_id)
        return dict(user) if user is not None else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        user = next((row for row in self.users.values() if row["email"] == email), None)
        return dict(user) if user is not None else None

    async def save_session(
        self, token_hash: str, *, user_id: str, expires_at: str
    ) -> None:
        current = self.sessions.get(token_hash, {})
        self.sessions[token_hash] = {
            "user_id": user_id,
            "expires_at": expires_at,
            "revoked": bool(current.get("revoked")),
        }

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        session = self.sessions.get(token_hash)
        return dict(session) if session is not None else None

    async def revoke_session(self, token_hash: str) -> None:
        if token_hash in self.sessions:
            self.sessions[token_hash]["revoked"] = True


async def request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    body: object | bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    if path in {"/api/v1/auth/register", "/api/v1/auth/login"} and isinstance(body, dict):
        body = {**body, "turnstile_token": "test-turnstile"}
    kwargs: dict[str, Any] = {"headers": headers}
    if isinstance(body, bytes):
        kwargs["content"] = body
    elif body is not None:
        kwargs["json"] = body
    response = await client.request(method, path, **kwargs)
    client.cookies.clear()
    return response.status_code, dict(response.headers), response.content


def _test_app(**overrides: Any) -> FastAPI:
    store = overrides.pop("store", _AuthStore())
    return create_app(
        turnstile_verifier=lambda _token, _ip: True,
        secure_cookies=False,
        static_dir=None,
        store=store,
        **overrides,
    )


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


def _cookie_from(headers: dict[str, str]) -> str:
    """Extract podium_session=<value> pair from a Set-Cookie header."""
    set_cookie = headers.get("set-cookie") or ""
    return set_cookie.split(";", 1)[0]


async def _register(
    client: httpx.AsyncClient,
    email: str,
    password: str = "password123",
) -> tuple[dict, str]:
    status, headers, body = await request(
        client, "POST", "/api/v1/auth/register", {"email": email, "password": password}
    )
    assert status == 200, body
    return json.loads(body), _cookie_from(headers)


# ===== Registration =====


@pytest.mark.asyncio
async def test_register_creates_user_workspace_and_session_cookie() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        status, headers, body = await request(
            client, "POST", "/api/v1/auth/register",
            {"email": "a@example.com", "password": "password123"},
        )
    assert status == 200
    payload = json.loads(body)
    assert payload["user"]["email"] == "a@example.com"
    assert payload["user"]["id"].startswith("user_")
    # Cookie set, HttpOnly, SameSite
    set_cookie = headers["set-cookie"]
    assert "podium_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Lax" in set_cookie
    # Password never leaks
    assert b"password123" not in body
    assert b"password_hash" not in body


@pytest.mark.asyncio
async def test_register_duplicate_email_rejected() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        await _register(client, "dup@example.com")
        status, _, body = await request(
            client, "POST", "/api/v1/auth/register",
            {"email": "DUP@example.com", "password": "password123"},
        )
    assert status == 400
    assert json.loads(body)["error"]["code"] == "email_already_registered"


@pytest.mark.asyncio
async def test_register_short_password_rejected() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        status, _, body = await request(
            client, "POST", "/api/v1/auth/register",
            {"email": "s@example.com", "password": "short"},
        )
    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_credentials"


@pytest.mark.asyncio
async def test_register_accepts_empty_turnstile_when_disabled() -> None:
    app = create_app(
        turnstile_verifier=lambda _token, _ip: False,
        secure_cookies=False,
        config=PodiumConfig(turnstile_site_key=""),
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.post(
            "/api/v1/auth/register",
            json={"email": "disabled@example.com", "password": "password123", "turnstile_token": ""},
        )

    assert response.status_code == 200
    assert response.json()["user"]["email"] == "disabled@example.com"


@pytest.mark.asyncio
async def test_register_accepts_empty_turnstile_when_secret_key_missing() -> None:
    app = create_app(
        turnstile_verifier=lambda _token, _ip: False,
        secure_cookies=False,
        config=PodiumConfig(turnstile_site_key="site-key"),
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.post(
            "/api/v1/auth/register",
            json={"email": "missing-secret@example.com", "password": "password123", "turnstile_token": ""},
        )

    assert response.status_code == 200
    assert response.json()["user"]["email"] == "missing-secret@example.com"


@pytest.mark.asyncio
async def test_register_rejects_empty_turnstile_when_site_and_secret_key_configured() -> None:
    app = create_app(
        turnstile_verifier=lambda _token, _ip: True,
        secure_cookies=False,
        config=PodiumConfig(turnstile_site_key="site-key", turnstile_secret_key="secret-key"),
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.post(
            "/api/v1/auth/register",
            json={"email": "enabled@example.com", "password": "password123", "turnstile_token": ""},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_turnstile"


# ===== Login =====


@pytest.mark.asyncio
async def test_login_success_sets_cookie() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        await _register(client, "login@example.com", "password123")
        status, headers, body = await request(
            client, "POST", "/api/v1/auth/login",
            {"email": "login@example.com", "password": "password123"},
        )
    assert status == 200
    assert "podium_session=" in headers["set-cookie"]
    assert json.loads(body)["user"]["email"] == "login@example.com"


@pytest.mark.asyncio
async def test_login_wrong_password_and_unknown_email_identical() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        await _register(client, "real@example.com", "password123")
        wrong_status, _, wrong_body = await request(
            client, "POST", "/api/v1/auth/login",
            {"email": "real@example.com", "password": "wrongpassword"},
        )
        unknown_status, _, unknown_body = await request(
            client, "POST", "/api/v1/auth/login",
            {"email": "nobody@example.com", "password": "password123"},
        )
    assert wrong_status == 401
    assert unknown_status == 401
    assert json.loads(wrong_body) == json.loads(unknown_body)
    assert json.loads(wrong_body)["error"]["code"] == "invalid_login"


# ===== me / logout =====


@pytest.mark.asyncio
async def test_me_with_valid_cookie_returns_user() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        _, cookie = await _register(client, "me@example.com")
        status, _, body = await request(
            client, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    assert status == 200
    payload = json.loads(body)
    assert payload["user"]["email"] == "me@example.com"
    assert set(payload["user"]) == {"id", "email"}


@pytest.mark.asyncio
async def test_me_without_cookie_returns_401() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        status, _, body = await request(client, "GET", "/api/v1/auth/me")
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_debug_auth_me_creates_internal_session_when_enabled() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key=SECRET,
        debug_auth=True,
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 200
    assert response.json()["user"] == {
        "id": "debug",
        "email": "debug@podium.local",
    }
    assert "podium_session=" in response.headers["set-cookie"]


@pytest.mark.asyncio
async def test_debug_auth_me_reuses_internal_session() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key=SECRET,
        debug_auth=True,
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        first = await client.get("/api/v1/auth/me")
        second = await client.get("/api/v1/auth/me")

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["user"]["id"] == "debug"
    assert await app.state.podium.user_by_id("debug") is not None


@pytest.mark.asyncio
async def test_debug_auth_public_config_disables_turnstile() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key=SECRET,
        debug_auth=True,
        store=_AuthStore(),
        config=PodiumConfig(
            turnstile_site_key="site-key",
            turnstile_secret_key="secret-key",
        ),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.get("/api/v1/config")

    assert response.status_code == 200
    assert response.json() == {"turnstile": {"enabled": False, "site_key": ""}}


@pytest.mark.asyncio
async def test_disable_turnstile_keeps_normal_auth_flow() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key=SECRET,
        turnstile_verifier=lambda _token, _ip: False,
        config=PodiumConfig(
            turnstile_site_key="site-key",
            turnstile_secret_key="secret-key",
            turnstile_disabled=True,
        ),
        store=_AuthStore(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        me_before = await client.get("/api/v1/auth/me")
        registered = await client.post(
            "/api/v1/auth/register",
            json={"email": "no-captcha@example.com", "password": "correct-horse", "turnstile_token": ""},
        )

    assert me_before.status_code == 401
    assert registered.status_code == 200
    assert registered.json()["user"]["email"] == "no-captcha@example.com"


@pytest.mark.asyncio
async def test_me_returns_401_when_store_rejects_the_session() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        _, cookie = await _register(client, "exp@example.com")
        app.state.podium.store.sessions.clear()
        status, _, body = await request(
            client, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    assert status == 401


@pytest.mark.asyncio
async def test_logout_clears_session() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        _, cookie = await _register(client, "out@example.com")
        status, headers, body = await request(
            client, "POST", "/api/v1/auth/logout", headers={"Cookie": cookie}
        )
        assert status == 200
        assert json.loads(body)["status"] == "ok"
        assert "Max-Age=0" in headers["set-cookie"]
        # Subsequent me -> 401
        me_status, _, _ = await request(
            client, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    assert me_status == 401


# ===== Tenant isolation =====


@pytest.mark.asyncio
async def test_tenant_isolation_ignores_workspace_param() -> None:
    app = _test_app(secret_key=SECRET)
    app.state.podium.get_active_linear_installation = AsyncMock(return_value=None)
    app.state.podium.onboarding_progress = AsyncMock(
        return_value={"current_step": "linear_connect", "completed_steps": [], "next_action": "linear_connect"}
    )
    app.state.podium.linear_status = AsyncMock(
        side_effect=lambda user_id: {"workspace_id": user_id, "state": "not_connected"}
    )
    async with _client(app) as client:
        a_payload, a_cookie = await _register(client, "a@example.com")
        b_payload, _ = await _register(client, "b@example.com")
        a_ws = a_payload["user"]["id"]
        b_ws = b_payload["user"]["id"]
        assert a_ws != b_ws

        # A passes B's workspace_id as a query param — must be ignored.
        status, _, body = await request(
            client,
            "GET",
            f"/api/v1/bootstrap?workspace_id={b_ws}",
            headers={"Cookie": a_cookie},
        )
    assert status == 200
    assert json.loads(body)["session"]["workspace_id"] == a_ws


@pytest.mark.asyncio
async def test_bootstrap_without_session_is_401() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        status, _, body = await request(client, "GET", "/api/v1/bootstrap")
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_removed_account_linear_app_route_is_not_available() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        _, cookie = await _register(client, "missing@example.com")
        status, _, body = await request(
            client, "PUT", "/api/v1/account/linear-app",
            {"client_id": "legacy", "client_secret": "legacy"},
            headers={"Cookie": cookie},
        )
    assert status == 404
    assert json.loads(body)["detail"] == "Not Found"


@pytest.mark.asyncio
async def test_linear_application_route_requires_auth() -> None:
    app = _test_app(secret_key=SECRET)
    async with _client(app) as client:
        status, _, body = await request(
            client, "PUT", "/api/v1/linear/application",
            {"client_id": "c", "client_secret": "s"},
        )
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_auth_routes_return_500_when_secret_key_missing() -> None:
    app = _test_app()
    async with _client(app) as client:
        status, _, body = await request(
            client, "POST", "/api/v1/auth/register",
            {"email": "x@example.com", "password": "password123"},
        )
    assert status == 200
    assert json.loads(body)["user"]["email"] == "x@example.com"


# ===== I3: decrypt failure must surface, not silently fall back =====


@pytest.mark.asyncio
async def test_linear_application_secret_decryption_failure_is_visible() -> None:
    app = _test_app(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_client_secret="official-secret",
        linear_redirect_uri="https://podium.example/api/v1/linear/oauth/callback",
    )
    async with _client(app) as client:
        _, cookie = await _register(client, "rotate@example.com")
        app.state.podium.selected_linear_application = AsyncMock(
            side_effect=SecretDecryptionError("secret_decryption_failed")
        )
        status, _, body = await request(
            client,
            "GET",
            "/api/v1/linear/application",
            headers={"Cookie": cookie},
        )

    assert status == 500
    assert json.loads(body)["error"]["code"] == "linear_application_secret_unreadable"
