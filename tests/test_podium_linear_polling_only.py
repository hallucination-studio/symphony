from __future__ import annotations

import json
import urllib.parse
from pathlib import Path
from typing import Any

import httpx
import pytest

from podium.app import create_app
from podium.linear_constants import LINEAR_REQUIRED_SCOPES
from podium.store import PodiumStore


ROOT = Path(__file__).resolve().parents[1]


def _acceptance(*, organization_id: str = "linear-org-1") -> dict[str, Any]:
    return {
        "viewer": {"id": "linear-app-user-1", "name": "Symphony", "app": True},
        "organization": {"id": organization_id, "name": "Acme", "urlKey": "acme"},
        "projects": [{"id": "linear-project-1", "name": "Alpha", "slugId": "alpha"}],
    }


def _token(value: str) -> dict[str, Any]:
    return {
        "access_token": f"access-{value}",
        "refresh_token": f"refresh-{value}",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "read write app:assignable",
        "actor": "app",
    }


def _client(tmp_path: Path, **overrides: Any) -> tuple[httpx.AsyncClient, Any, PodiumStore]:
    store = PodiumStore(data_dir=tmp_path)
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "ok",
        secure_cookies=False,
        secret_key="test-secret-key",
        store=store,
        linear_client_id="default-client",
        linear_client_secret="default-secret",
        linear_redirect_uri="https://podium.test/api/v1/linear/oauth/callback",
        linear_application_version=7,
        podium_base_url="https://podium.test",
        **overrides,
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test"), app, store


async def _register(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "owner@example.com", "password": "correct-horse", "turnstile_token": "ok"},
    )
    assert response.status_code == 200


def _oauth_params(response: httpx.Response) -> dict[str, str]:
    assert response.status_code == 200
    return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(response.json()["authorization_url"]).query))


def test_linear_product_code_has_no_webhook_or_agent_session_compatibility() -> None:
    roots = [ROOT / "packages" / name / "src" for name in ("podium", "conductor", "performer")]
    forbidden = ("linear_webhook", "AgentSession", "agent_session", "supportsAgentSessions", "supports_agent_sessions")
    findings: list[str] = []
    for root in roots:
        for path in root.rglob("*.py"):
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for term in forbidden:
                    if term in line and "DROP" not in line:
                        findings.append(f"{path.relative_to(ROOT)}:{line_number}: {term}")
    assert findings == []


def test_linear_oauth_scope_is_the_polling_only_minimum() -> None:
    assert LINEAR_REQUIRED_SCOPES == {"read", "write", "app:assignable"}


@pytest.mark.asyncio
async def test_default_and_custom_apps_need_no_webhook_configuration(tmp_path: Path) -> None:
    client, _app, _store = _client(tmp_path)
    async with client:
        await _register(client)
        default = await client.get("/api/v1/linear/application")
        custom = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom-client", "client_secret": "custom-secret"},
        )
        missing_route = await client.post("/api/v1/linear/webhooks", json={})

    assert default.status_code == 200
    assert default.json()["application"] == {
        "id": default.json()["application"]["id"],
        "source": "default",
        "version": 7,
        "client_id": "default-client",
        "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
    }
    assert custom.status_code == 200
    assert custom.json()["application"]["source"] == "custom"
    assert "secret" not in custom.text.lower()
    assert missing_route.status_code == 404


@pytest.mark.asyncio
async def test_oauth_state_is_hashed_one_time_and_callback_redirects(tmp_path: Path) -> None:
    client, _app, _store = _client(
        tmp_path,
        linear_token_exchange=lambda code, _application: _token(code),
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with client:
        await _register(client)
        params = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        state_file = (tmp_path / "oauth_states.json").read_text(encoding="utf-8")
        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "ok", "state": params["state"]},
            follow_redirects=False,
        )
        replay = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "again", "state": params["state"]},
            follow_redirects=False,
        )

    assert params["state"] not in state_file
    assert callback.status_code == 303
    assert callback.headers["location"] == "/setup/linear?linear=connected"
    assert replay.status_code == 400


@pytest.mark.asyncio
async def test_denied_consent_is_durable_sanitized_and_consumes_state(tmp_path: Path) -> None:
    client, _app, _store = _client(tmp_path)
    async with client:
        await _register(client)
        params = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        denied = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"error": "access_denied", "error_description": "User denied access", "state": params["state"]},
            follow_redirects=False,
        )
        replay = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"error": "access_denied", "state": params["state"]},
            follow_redirects=False,
        )
        installations = await client.get("/api/v1/linear/installations")

    assert denied.status_code == 303
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(denied.headers["location"]).query))
    assert query == {"linear": "denied", "code": "linear_oauth_denied"}
    candidate = installations.json()["candidate"]
    assert candidate["state"] == "failed"
    assert candidate["error_code"] == "linear_oauth_denied"
    assert candidate["sanitized_reason"] == "Linear authorization was not approved"
    assert candidate["next_action"] == "reauthorize"
    assert "User denied access" not in installations.text
    assert replay.status_code == 400


@pytest.mark.asyncio
async def test_same_application_identity_reauthorization_rotates_without_candidate(tmp_path: Path) -> None:
    client, app, _store = _client(
        tmp_path,
        linear_token_exchange=lambda code, _application: _token(code),
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with client:
        await _register(client)
        first = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        await client.get("/api/v1/linear/oauth/callback", params={"code": "first", "state": first["state"]})
        first_installation = await app.state.podium.get_active_linear_installation("user_1")
        second = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        rotated = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "second", "state": second["state"]},
            follow_redirects=False,
        )
        status = (await client.get("/api/v1/linear/installations")).json()

    active = await app.state.podium.get_active_linear_installation("user_1")
    assert rotated.status_code == 303
    assert active is not None and first_installation is not None
    assert active["id"] == first_installation["id"]
    assert active["access_token"] == "access-second"
    assert active["refresh_token"] == "refresh-second"
    assert status["active"]["state"] == "ready"
    assert status["candidate"] is None
    persisted = json.loads((tmp_path / "linear_workspace_installations.json").read_text(encoding="utf-8"))
    assert len(persisted) == 1
