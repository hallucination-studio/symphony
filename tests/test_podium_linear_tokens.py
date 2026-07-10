from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from podium.app import create_app
from podium.linear_token_service import LinearTokenUnavailable
from podium.store import PodiumStore
from test_podium_conductor_channels_support import (
    activate_linear_installation,
    bind_and_ack_conductor,
    enroll_conductor,
    register,
    successful_project_label_transport,
)


def _app(**overrides: Any) -> Any:
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="test-secret",
        store=PodiumStore(),
        **overrides,
    )


def _refreshed(value: str) -> dict[str, Any]:
    return {
        "access_token": f"access-{value}",
        "refresh_token": f"refresh-{value}",
        "token_type": "Bearer",
        "expires_in": 86400,
        "scope": "read write app:assignable",
    }


@pytest.mark.asyncio
async def test_proactive_refresh_is_single_flight_and_rotates_both_tokens() -> None:
    calls: list[tuple[str, str]] = []

    async def refresh(refresh_token: str, application: dict[str, Any]) -> dict[str, Any]:
        calls.append((refresh_token, str(application["client_id"])))
        await asyncio.sleep(0.01)
        return _refreshed("rotated")

    app = _app(linear_token_refresh=refresh)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "refresh@example.com")
        await activate_linear_installation(app, user_id, access_token="access-old")
        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        installation = await app.state.podium.update_linear_installation_health(
            installation,
            expires_at=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat().replace("+00:00", "Z"),
        )
        tokens = await asyncio.gather(
            *(app.state.podium.linear_access_token(installation) for _ in range(8))
        )

    stored = await app.state.podium.get_active_linear_installation(user_id)
    assert tokens == ["access-rotated"] * 8
    assert calls == [("oauth-refresh-token", "test-linear-client")]
    assert stored is not None
    assert stored["access_token"] == "access-rotated"
    assert stored["refresh_token"] == "refresh-rotated"
    assert stored["state"] == "ready"
    assert stored["error_code"] == ""


@pytest.mark.asyncio
async def test_refresh_failure_requires_reauthorization_and_is_public() -> None:
    async def refresh(_refresh_token: str, _application: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("upstream returned token=must-not-leak")

    app = _app(linear_token_refresh=refresh)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "reauthorize@example.com")
        await activate_linear_installation(app, user_id)
        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        installation = await app.state.podium.update_linear_installation_health(
            installation,
            expires_at=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
        )
        with pytest.raises(LinearTokenUnavailable) as raised:
            await app.state.podium.linear_access_token(installation)
        public = await client.get("/api/v1/linear/installations")
        bootstrap = await client.get("/api/v1/bootstrap")

    assert raised.value.code == "linear_reauthorization_required"
    assert public.json()["active"]["state"] == "reauthorization_required"
    assert public.json()["active"]["action_required"] == "reauthorize"
    assert bootstrap.json()["linear"]["state"] == "reauthorization_required"
    assert "must-not-leak" not in public.text
    assert "must-not-leak" not in bootstrap.text


@pytest.mark.asyncio
async def test_proxy_refreshes_and_retries_exactly_once_after_401() -> None:
    upstream_tokens: list[str] = []
    refresh_calls = 0

    async def refresh(_refresh_token: str, _application: dict[str, Any]) -> dict[str, Any]:
        nonlocal refresh_calls
        refresh_calls += 1
        return _refreshed("retry")

    async def transport(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if str(payload.get("operationName") or "").startswith("ManagedProject"):
            return await successful_project_label_transport(request)
        token = request.headers["Authorization"]
        upstream_tokens.append(token)
        if token == "Bearer oauth-installation-token":
            return httpx.Response(401, json={"errors": [{"message": "expired"}]})
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    app = _app(linear_token_refresh=refresh, linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "proxy-refresh@example.com")
        await activate_linear_installation(app, user_id)
        await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
        enrolled = await enroll_conductor(client)
        report, _binding = await bind_and_ack_conductor(app, client, user_id, enrolled)
        assert report.status_code == 200
        response = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert response.status_code == 200
    assert response.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert upstream_tokens == ["Bearer oauth-installation-token", "Bearer access-retry"]
    assert refresh_calls == 1


@pytest.mark.asyncio
async def test_project_label_operations_use_proactively_refreshed_token() -> None:
    refresh_calls = 0
    label_tokens: list[str] = []

    async def refresh(_refresh_token: str, _application: dict[str, Any]) -> dict[str, Any]:
        nonlocal refresh_calls
        refresh_calls += 1
        return _refreshed("labels")

    async def transport(request: httpx.Request) -> httpx.Response:
        label_tokens.append(request.headers["Authorization"])
        return await successful_project_label_transport(request)

    app = _app(linear_token_refresh=refresh, linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "label-refresh@example.com")
        await activate_linear_installation(app, user_id)
        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        await app.state.podium.update_linear_installation_health(
            installation,
            expires_at=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat().replace("+00:00", "Z"),
        )
        await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
        enrolled = await enroll_conductor(client)
        report, _binding = await bind_and_ack_conductor(app, client, user_id, enrolled)

    assert report.status_code == 200
    assert refresh_calls == 1
    assert label_tokens
    assert set(label_tokens) == {"Bearer access-labels"}


@pytest.mark.asyncio
async def test_disconnect_revokes_credentials_and_removes_active_installation() -> None:
    revoked: list[tuple[str, str]] = []

    async def revoke(token: str, token_type_hint: str) -> None:
        revoked.append((token, token_type_hint))

    app = _app(linear_token_revoke=revoke)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "disconnect@example.com")
        await activate_linear_installation(app, user_id, access_token="access-current")
        response = await client.delete("/api/v1/linear/installations/current")
        installations = await client.get("/api/v1/linear/installations")

    rows = await app.state.podium.store.list_workspace_installations(user_id)
    assert response.status_code == 200
    assert response.json()["state"] == "disconnected"
    assert installations.json()["active"] is None
    assert rows[-1]["state"] == "disconnected"
    assert rows[-1]["active"] is False
    assert app.state.podium.decrypt_secret(rows[-1]["access_token_enc"]) == ""
    assert app.state.podium.decrypt_secret(rows[-1]["refresh_token_enc"]) == ""
    assert revoked == [
        ("oauth-refresh-token", "refresh_token"),
        ("access-current", "access_token"),
    ]


@pytest.mark.asyncio
async def test_failed_revocation_is_visible_and_can_be_retried() -> None:
    failing = True

    async def revoke(_token: str, _token_type_hint: str) -> None:
        if failing:
            raise RuntimeError("token=must-not-leak")

    app = _app(linear_token_revoke=revoke)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "retry-revoke@example.com")
        installation_id = await activate_linear_installation(app, user_id)
        failed = await client.delete("/api/v1/linear/installations/current")
        visible = await client.get("/api/v1/linear/installations")
        failing = False
        retried = await client.post(f"/api/v1/linear/installations/{installation_id}/revoke")
        after = await client.get("/api/v1/linear/installations")

    assert failed.status_code == 502
    assert failed.json()["error"]["code"] == "linear_token_revocation_failed"
    assert visible.json()["revocation"]["state"] == "disconnected_revocation_failed"
    assert visible.json()["revocation"]["next_action"] == "retry_revocation"
    assert "must-not-leak" not in visible.text
    assert retried.status_code == 200
    assert retried.json()["state"] == "disconnected"
    assert after.json()["revocation"] is None
