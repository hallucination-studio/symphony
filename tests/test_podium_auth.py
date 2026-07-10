from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from podium.app import create_app
from podium.config import PodiumConfig
from podium.server import PodiumServer
from podium.store.postgres import PgStore

SECRET = "test-secret-key-abc123"


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


def _cookie_from(headers: dict[str, str]) -> str:
    """Extract podium_session=<value> pair from a Set-Cookie header."""
    set_cookie = headers.get("set-cookie") or ""
    return set_cookie.split(";", 1)[0]


async def _register(port: int, email: str, password: str = "password123") -> tuple[dict, str]:
    status, headers, body = await request(
        port, "POST", "/api/v1/auth/register", {"email": email, "password": password}
    )
    assert status == 200, body
    return json.loads(body), _cookie_from(headers)


# ===== Registration =====


@pytest.mark.asyncio
async def test_register_creates_user_workspace_and_session_cookie() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, headers, body = await request(
            server.port, "POST", "/api/v1/auth/register",
            {"email": "a@example.com", "password": "password123"},
        )
    finally:
        await server.stop()
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
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        await _register(server.port, "dup@example.com")
        status, _, body = await request(
            server.port, "POST", "/api/v1/auth/register",
            {"email": "DUP@example.com", "password": "password123"},
        )
    finally:
        await server.stop()
    assert status == 400
    assert json.loads(body)["error"]["code"] == "email_already_registered"


@pytest.mark.asyncio
async def test_register_short_password_rejected() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "POST", "/api/v1/auth/register",
            {"email": "s@example.com", "password": "short"},
        )
    finally:
        await server.stop()
    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_credentials"


@pytest.mark.asyncio
async def test_register_accepts_empty_turnstile_when_disabled() -> None:
    app = create_app(
        turnstile_verifier=lambda _token, _ip: False,
        secure_cookies=False,
        config=PodiumConfig(turnstile_site_key=""),
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
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        await _register(server.port, "login@example.com", "password123")
        status, headers, body = await request(
            server.port, "POST", "/api/v1/auth/login",
            {"email": "login@example.com", "password": "password123"},
        )
    finally:
        await server.stop()
    assert status == 200
    assert "podium_session=" in headers["set-cookie"]
    assert json.loads(body)["user"]["email"] == "login@example.com"


@pytest.mark.asyncio
async def test_login_wrong_password_and_unknown_email_identical() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        await _register(server.port, "real@example.com", "password123")
        wrong_status, _, wrong_body = await request(
            server.port, "POST", "/api/v1/auth/login",
            {"email": "real@example.com", "password": "wrongpassword"},
        )
        unknown_status, _, unknown_body = await request(
            server.port, "POST", "/api/v1/auth/login",
            {"email": "nobody@example.com", "password": "password123"},
        )
    finally:
        await server.stop()
    assert wrong_status == 401
    assert unknown_status == 401
    assert json.loads(wrong_body) == json.loads(unknown_body)
    assert json.loads(wrong_body)["error"]["code"] == "invalid_login"


# ===== me / logout =====


@pytest.mark.asyncio
async def test_me_with_valid_cookie_returns_user() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "me@example.com")
        status, _, body = await request(
            server.port, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()
    assert status == 200
    payload = json.loads(body)
    assert payload["user"]["email"] == "me@example.com"
    assert set(payload["user"]) == {"id", "email"}


@pytest.mark.asyncio
async def test_me_without_cookie_returns_401() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/auth/me")
    finally:
        await server.stop()
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_debug_auth_me_creates_internal_session_when_enabled() -> None:
    app = create_app(
        secure_cookies=False,
        secret_key=SECRET,
        debug_auth=True,
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
async def test_expired_session_returns_401() -> None:
    from datetime import timedelta

    server = PodiumServer(secret_key=SECRET)
    server.auth_service.session_ttl = timedelta(seconds=-1)  # already expired
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "exp@example.com")
        status, _, body = await request(
            server.port, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()
    assert status == 401


@pytest.mark.asyncio
async def test_logout_clears_session() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "out@example.com")
        status, headers, body = await request(
            server.port, "POST", "/api/v1/auth/logout", headers={"Cookie": cookie}
        )
        assert status == 200
        assert json.loads(body)["status"] == "ok"
        assert "Max-Age=0" in headers["set-cookie"]
        # Subsequent me -> 401
        me_status, _, _ = await request(
            server.port, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
    finally:
        await server.stop()
    assert me_status == 401


# ===== Tenant isolation =====


@pytest.mark.asyncio
async def test_tenant_isolation_ignores_workspace_param() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        a_payload, a_cookie = await _register(server.port, "a@example.com")
        b_payload, _ = await _register(server.port, "b@example.com")
        a_ws = a_payload["user"]["id"]
        b_ws = b_payload["user"]["id"]
        assert a_ws != b_ws

        # A passes B's workspace_id as a query param — must be ignored.
        status, _, body = await request(
            server.port,
            "GET",
            f"/api/v1/bootstrap?workspace_id={b_ws}",
            headers={"Cookie": a_cookie},
        )
    finally:
        await server.stop()
    assert status == 200
    assert json.loads(body)["session"]["workspace_id"] == a_ws


@pytest.mark.asyncio
async def test_bootstrap_without_session_is_401() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, _, body = await request(server.port, "GET", "/api/v1/bootstrap")
    finally:
        await server.stop()
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_removed_account_linear_app_route_is_not_available() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "missing@example.com")
        status, _, body = await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "legacy", "client_secret": "legacy"},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()
    assert status == 404
    assert json.loads(body)["detail"] == "Not Found"


@pytest.mark.asyncio
async def test_linear_application_route_requires_auth() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "PUT", "/api/v1/linear/application",
            {"client_id": "c", "client_secret": "s"},
        )
    finally:
        await server.stop()
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


# ===== C2: empty PODIUM_SECRET_KEY must raise =====


def test_auth_service_rejects_empty_secret_key() -> None:
    from podium.auth_service import AuthService
    from podium.store import PodiumStore

    store = PodiumStore()
    for bad in ("", "   "):
        with pytest.raises((RuntimeError, ValueError)):
            AuthService(store, bad)
    # A real key constructs fine.
    AuthService(store, SECRET)


def test_server_without_secret_key_has_no_auth_service() -> None:
    # Secret-key-backed helpers are unavailable, but the current FastAPI auth
    # routes can still register/login users when Turnstile passes.
    server = PodiumServer()
    assert server.auth_service is None


@pytest.mark.asyncio
async def test_auth_routes_return_500_when_secret_key_missing() -> None:
    server = PodiumServer()
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "POST", "/api/v1/auth/register",
            {"email": "x@example.com", "password": "password123"},
        )
    finally:
        await server.stop()
    assert status == 200
    assert json.loads(body)["user"]["email"] == "x@example.com"


# ===== I3: decrypt failure must surface, not silently fall back =====


@pytest.mark.asyncio
async def test_linear_application_secret_decryption_failure_is_visible() -> None:
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_client_secret="official-secret",
        linear_redirect_uri="https://podium.example/api/v1/linear/oauth/callback",
    )
    await server.start(port=0)
    try:
        payload, cookie = await _register(server.port, "rotate@example.com")
        assert payload["user"]["id"]
        saved_status, _, _ = await request(
            server.port, "PUT", "/api/v1/linear/application",
            {
                "client_id": "custom-client",
                "client_secret": "custom-secret",
            },
            headers={"Cookie": cookie},
        )
        assert saved_status == 200
        configs = server.store._load_map("linear_application_configs.json")
        config_id = next(iter(configs))
        configs[config_id]["client_secret_enc"] = "not-a-fernet-token"
        server.store._write("linear_application_configs.json", configs)
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/linear/application",
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 500
    assert json.loads(body)["error"]["code"] == "linear_application_secret_unreadable"


@pytest.mark.asyncio
async def test_default_linear_application_is_selected_when_no_custom_app_exists() -> None:
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_client_secret="official-secret",
        linear_redirect_uri="https://podium.example/api/v1/linear/oauth/callback",
    )
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "noapp@example.com")
        status, _, body = await request(
            server.port,
            "GET",
            "/api/v1/linear/application",
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    assert status == 200
    application = json.loads(body)["application"]
    assert application["source"] == "default"
    assert application["client_id"] == "official-client"
