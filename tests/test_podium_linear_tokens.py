from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.linear_token_service import LinearTokenUnavailable


def _installation(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "installation-1",
        "user_id": "user-1",
        "application_config_id": "application-1",
        "application_config_version": 7,
        "application_source": "default",
        "state": "ready",
        "active": True,
        "access_token": "access-old",
        "refresh_token": "refresh-old",
        "token_type": "Bearer",
        "actor": "app",
        "scope": ["app:assignable", "read", "write"],
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=30))
        .isoformat()
        .replace("+00:00", "Z"),
        "linear_organization_id": "organization-1",
        "app_user_id": "linear-app-user-1",
        "projects": [{"id": "project-1", "name": "Alpha", "slug_id": "alpha"}],
        "error_code": "",
        "sanitized_reason": "",
        "retryable": False,
        "action_required": "",
        "next_action": "",
        "created_at": "2026-07-11T00:00:00Z",
        "updated_at": "2026-07-11T00:00:00Z",
        **overrides,
    }


def _refreshed(value: str) -> dict[str, Any]:
    return {
        "access_token": f"access-{value}",
        "refresh_token": f"refresh-{value}",
        "token_type": "Bearer",
        "expires_in": 86400,
        "scope": "read write app:assignable",
    }


def _locking_store() -> Any:
    lock = asyncio.Lock()

    @asynccontextmanager
    async def linear_installation_token_lock(_installation_id: str):
        async with lock:
            yield

    return SimpleNamespace(linear_installation_token_lock=linear_installation_token_lock)


def _app(*, store: Any, **overrides: Any) -> Any:
    return create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
        **overrides,
    )


def _install_token_state(app: Any, initial: dict[str, Any]) -> list[dict[str, Any]]:
    current = dict(initial)
    saved: list[dict[str, Any]] = []

    async def get_active(_user_id: str) -> dict[str, Any]:
        return dict(current)

    async def save_installation(row: dict[str, Any]) -> None:
        current.clear()
        current.update(row)
        saved.append(dict(row))

    app.state.podium.get_active_linear_installation = AsyncMock(side_effect=get_active)
    app.state.podium.get_linear_application_config = AsyncMock(
        return_value={
            "id": "application-1",
            "client_id": "linear-client",
            "client_secret": "linear-secret",
        }
    )
    app.state.podium.save_linear_installation_record = AsyncMock(
        side_effect=save_installation
    )
    return saved


@pytest.mark.asyncio
async def test_proactive_refresh_is_single_flight_and_rotates_both_tokens() -> None:
    calls: list[tuple[str, str]] = []

    async def refresh(
        refresh_token: str, application: dict[str, Any]
    ) -> dict[str, Any]:
        calls.append((refresh_token, str(application["client_id"])))
        await asyncio.sleep(0.01)
        return _refreshed("rotated")

    installation = _installation()
    app = _app(store=_locking_store(), linear_token_refresh=refresh)
    saved = _install_token_state(app, installation)

    tokens = await asyncio.gather(
        *(app.state.podium.linear_access_token(installation) for _ in range(8))
    )

    assert tokens == ["access-rotated"] * 8
    assert calls == [("refresh-old", "linear-client")]
    assert saved[-1]["access_token"] == "access-rotated"
    assert saved[-1]["refresh_token"] == "refresh-rotated"
    assert saved[-1]["state"] == "ready"


@pytest.mark.asyncio
async def test_refresh_failure_requires_reauthorization_without_leaking_reason() -> None:
    async def refresh(
        _refresh_token: str, _application: dict[str, Any]
    ) -> dict[str, Any]:
        raise RuntimeError("upstream returned token=must-not-leak")

    installation = _installation()
    app = _app(store=_locking_store(), linear_token_refresh=refresh)
    saved = _install_token_state(app, installation)

    with pytest.raises(LinearTokenUnavailable) as raised:
        await app.state.podium.linear_access_token(installation)

    assert raised.value.code == "linear_reauthorization_required"
    assert str(raised.value) == "Linear authorization must be renewed"
    assert saved[-1]["state"] == "reauthorization_required"
    assert saved[-1]["action_required"] == "reauthorize"
    assert "must-not-leak" not in json.dumps(saved[-1])


@pytest.mark.asyncio
async def test_graphql_retries_exactly_once_with_refreshed_token_after_401() -> None:
    upstream_tokens: list[str] = []
    refresh_calls = 0

    async def refresh(
        _refresh_token: str, _application: dict[str, Any]
    ) -> dict[str, Any]:
        nonlocal refresh_calls
        refresh_calls += 1
        return _refreshed("retry")

    async def transport(request: httpx.Request) -> httpx.Response:
        token = request.headers["Authorization"]
        upstream_tokens.append(token)
        if token == "Bearer access-old":
            return httpx.Response(401, json={"errors": [{"message": "expired"}]})
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    installation = _installation(
        expires_at=(datetime.now(timezone.utc) + timedelta(hours=1))
        .isoformat()
        .replace("+00:00", "Z")
    )
    app = _app(
        store=_locking_store(),
        linear_token_refresh=refresh,
        linear_graphql_transport=transport,
    )
    _install_token_state(app, installation)

    result = await app.state.podium.linear_graphql_for_installation(
        installation,
        query="query Viewer { viewer { id } }",
        variables={},
        operation_name="Viewer",
    )

    assert result == {"viewer": {"id": "viewer-1"}}
    assert upstream_tokens == ["Bearer access-old", "Bearer access-retry"]
    assert refresh_calls == 1


@pytest.mark.asyncio
async def test_disconnect_revokes_both_credentials_and_clears_saved_tokens() -> None:
    revoked: list[tuple[str, str]] = []

    async def revoke(token: str, token_type_hint: str) -> None:
        revoked.append((token, token_type_hint))

    store = SimpleNamespace(disconnect_workspace_installation=AsyncMock())
    app = _app(store=store, linear_token_revoke=revoke)
    installation = _installation(access_token="access-current", refresh_token="refresh-current")
    app.state.podium.get_active_linear_installation = AsyncMock(
        return_value=installation
    )
    app.state.podium.save_linear_installation_record = AsyncMock()

    result = await app.state.podium.disconnect_linear_installation("user-1")

    saved = app.state.podium.save_linear_installation_record.await_args.args[0]
    assert result == {"state": "disconnected"}
    store.disconnect_workspace_installation.assert_awaited_once_with(
        "user-1", "installation-1"
    )
    assert revoked == [
        ("refresh-current", "refresh_token"),
        ("access-current", "access_token"),
    ]
    assert saved["access_token"] == ""
    assert saved["refresh_token"] == ""
    assert saved["state"] == "disconnected"


@pytest.mark.asyncio
async def test_failed_revocation_is_sanitized_and_can_be_retried() -> None:
    failing = True

    async def revoke(_token: str, _token_type_hint: str) -> None:
        if failing:
            raise RuntimeError("token=must-not-leak")

    installation = _installation(state="disconnected", active=False)
    app = _app(store=object(), linear_token_revoke=revoke)
    app.state.podium.save_linear_installation_record = AsyncMock()

    with pytest.raises(LinearTokenUnavailable) as raised:
        await app.state.podium._revoke_linear_credentials(installation)

    failed = app.state.podium.save_linear_installation_record.await_args.args[0]
    assert raised.value.code == "linear_token_revocation_failed"
    assert failed["state"] == "disconnected_revocation_failed"
    assert failed["next_action"] == "retry_revocation"
    assert "must-not-leak" not in json.dumps(failed)

    failing = False
    app.state.podium.get_linear_installation_record = AsyncMock(return_value=failed)
    app.state.podium.save_linear_installation_record.reset_mock()
    retried = await app.state.podium.retry_linear_revocation(
        "user-1", "installation-1"
    )

    saved = app.state.podium.save_linear_installation_record.await_args.args[0]
    assert retried == {"state": "disconnected"}
    assert saved["state"] == "disconnected"
    assert saved["access_token"] == ""
    assert saved["refresh_token"] == ""
