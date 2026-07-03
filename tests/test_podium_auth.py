from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from podium.server import PodiumServer

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
    # A brand-new user has no custom Linear app configured.
    assert payload["user"]["linear_app"] is None


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


# ===== Custom Linear app =====


@pytest.mark.asyncio
async def test_linear_app_stored_encrypted_and_never_leaked(tmp_path) -> None:
    server = PodiumServer(secret_key=SECRET, data_dir=tmp_path)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "byo@example.com")
        status, _, body = await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {
                "client_id": "custom-client",
                "client_secret": "super-secret-value",
                "redirect_uri": "https://byo.example/cb",
            },
            headers={"Cookie": cookie},
        )
        assert status == 200
        payload = json.loads(body)
        assert payload["linear_app"]["client_id"] == "custom-client"
        assert payload["linear_app"]["configured"] is True
        # Secret never in response
        assert b"super-secret-value" not in body

        # me/public never leaks the secret
        _, _, me_body = await request(
            server.port, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
        assert b"super-secret-value" not in me_body
        assert json.loads(me_body)["user"]["linear_app"] == {
            "client_id": "custom-client",
            "redirect_uri": "https://byo.example/cb",
            "configured": True,
        }
    finally:
        await server.stop()

    # Raw secret bytes NOT present on disk
    users_json = (tmp_path / "users.json").read_bytes()
    assert b"super-secret-value" not in users_json


@pytest.mark.asyncio
async def test_linear_app_delete_reverts_to_official() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "del@example.com")
        await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "c", "client_secret": "s"},
            headers={"Cookie": cookie},
        )
        status, _, body = await request(
            server.port, "DELETE", "/api/v1/account/linear-app",
            headers={"Cookie": cookie},
        )
        assert status == 200
        assert json.loads(body)["linear_app"] is None

        _, _, me_body = await request(
            server.port, "GET", "/api/v1/auth/me", headers={"Cookie": cookie}
        )
        assert json.loads(me_body)["user"]["linear_app"] is None
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_linear_app_requires_fields() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        _, cookie = await _register(server.port, "missing@example.com")
        status, _, body = await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "only-id"},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()
    assert status == 400
    assert json.loads(body)["error"]["code"] == "invalid_linear_app"


@pytest.mark.asyncio
async def test_linear_app_requires_auth() -> None:
    server = PodiumServer(secret_key=SECRET)
    await server.start(port=0)
    try:
        status, _, body = await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "c", "client_secret": "s"},
        )
    finally:
        await server.stop()
    assert status == 401


# ===== Credential resolution (BYO app) =====


@pytest.mark.asyncio
async def test_authorization_url_uses_custom_client_when_configured() -> None:
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_redirect_uri="https://podium.example/cb",
    )
    await server.start(port=0)
    try:
        payload, cookie = await _register(server.port, "auth-url@example.com")
        ws = payload["user"]["id"]

        # Without custom app -> global client id.
        url_global = server.linear_service.build_authorization_url(state=ws)
        assert "client_id=official-client" in url_global

        # Configure custom app.
        await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "custom-client", "client_secret": "s"},
            headers={"Cookie": cookie},
        )
        url_custom = server.linear_service.build_authorization_url(state=ws)
        assert "client_id=custom-client" in url_custom
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_authorization_url_uses_global_without_custom_app() -> None:
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_redirect_uri="https://podium.example/cb",
    )
    await server.start(port=0)
    try:
        url = server.linear_service.build_authorization_url(state="ws_unknown")
    finally:
        await server.stop()
    assert "client_id=official-client" in url


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
async def test_resolve_credentials_raises_when_custom_app_decrypt_fails() -> None:
    # A custom app is configured but the secret key is rotated so decrypt fails.
    # This must surface (raise), not silently revert to the official app.
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_redirect_uri="https://podium.example/cb",
    )
    await server.start(port=0)
    try:
        payload, cookie = await _register(server.port, "rotate@example.com")
        ws = payload["user"]["id"]
        await request(
            server.port, "PUT", "/api/v1/account/linear-app",
            {"client_id": "custom-client", "client_secret": "s"},
            headers={"Cookie": cookie},
        )
    finally:
        await server.stop()

    # Simulate key rotation: swap AuthService to one with a different key.
    from podium.auth_service import AuthService

    server.auth_service = AuthService(server.store, "a-completely-different-key")
    with pytest.raises(Exception):
        server._resolve_linear_credentials(ws)


@pytest.mark.asyncio
async def test_resolve_credentials_uses_global_when_no_custom_app() -> None:
    server = PodiumServer(
        secret_key=SECRET,
        linear_client_id="official-client",
        linear_redirect_uri="https://podium.example/cb",
    )
    await server.start(port=0)
    try:
        payload, _ = await _register(server.port, "noapp@example.com")
        ws = payload["user"]["id"]
    finally:
        await server.stop()

    creds = server._resolve_linear_credentials(ws)
    assert creds.client_id == "official-client"
