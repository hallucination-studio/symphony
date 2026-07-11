from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.config import PodiumConfig
from podium.linear_installation_acceptance import (
    LinearInstallationRejected,
    accepted_installation,
    rejected_installation,
)


DEFAULT_APP = {
    "linear_client_id": "default-client",
    "linear_client_secret": "default-secret",
    "linear_redirect_uri": "https://podium.test/api/v1/linear/oauth/callback",
    "linear_application_version": 7,
    "podium_base_url": "https://podium.test",
}
USER = {"id": "user-1", "email": "owner@example.com"}


def _application(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "application-1",
        "user_id": "user-1",
        "source": "default",
        "version": 7,
        "client_id": "default-client",
        "client_secret": "default-secret",
        "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
        "created_at": "2026-07-11T00:00:00Z",
        **overrides,
    }


def _acceptance(*, app: bool = True) -> dict[str, Any]:
    return {
        "viewer": {"id": "linear-app-user-1", "name": "Symphony", "app": app},
        "organization": {"id": "linear-org-1", "name": "Acme", "urlKey": "acme"},
        "projects": [
            {"id": "linear-project-1", "name": "Alpha", "slugId": "alpha"},
            {"id": "linear-project-2", "name": "Beta", "slugId": "beta"},
        ],
    }


def _token(access_token: str = "access-1", *, scope: str = "read write app:assignable") -> dict[str, Any]:
    return {
        "access_token": access_token,
        "refresh_token": f"refresh-{access_token}",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": scope,
        "actor": "app",
    }


def _app(*, store: Any = None, user: dict[str, str] | None = USER, **overrides: Any) -> Any:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "ok",
        secure_cookies=False,
        secret_key="test-secret-key",
        store=store if store is not None else object(),
        **DEFAULT_APP,
        **overrides,
    )
    app.state.podium.user_for_session = AsyncMock(return_value=user)
    return app


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


def test_config_reads_default_application_and_removes_global_actor_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "client-id")
    monkeypatch.setenv("LINEAR_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv(
        "LINEAR_REDIRECT_URI",
        "https://podium.test/api/v1/linear/oauth/callback",
    )
    monkeypatch.setenv("LINEAR_APPLICATION_VERSION", "9")
    monkeypatch.setenv("PODIUM_LINEAR_APPLICATION_ID", "removed-app-id")
    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "removed-app-token")

    config = PodiumConfig.from_env()

    assert config.linear_client_id == "client-id"
    assert config.linear_client_secret == "client-secret"
    assert config.linear_redirect_uri == "https://podium.test/api/v1/linear/oauth/callback"
    assert config.linear_application_version == 9
    assert not hasattr(config, "linear_application_id")
    assert not hasattr(config, "linear_app_access_token")
    assert not hasattr(config, "linear_webhook_secret")


@pytest.mark.asyncio
async def test_custom_application_uses_fixed_podium_url_and_never_returns_secret() -> None:
    store = SimpleNamespace(
        list_linear_application_configs=AsyncMock(return_value=[]),
        save_linear_application_config=AsyncMock(),
        set_linear_application_preference=AsyncMock(),
    )
    app = _app(store=store)

    async with _client(app) as client:
        rejected = await client.put(
            "/api/v1/linear/application",
            json={
                "client_id": "custom-client",
                "client_secret": "custom-secret",
                "redirect_uri": "https://attacker.test/callback",
            },
        )
        saved = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom-client", "client_secret": "custom-secret"},
        )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "invalid_linear_application"
    assert saved.status_code == 200
    assert saved.json()["application"] == {
        "id": saved.json()["application"]["id"],
        "source": "custom",
        "version": 1,
        "client_id": "custom-client",
        "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
    }
    assert "custom-secret" not in saved.text
    persisted = store.save_linear_application_config.await_args.args[0]
    assert persisted["client_secret_enc"] != "custom-secret"
    assert "client_secret" not in persisted


@pytest.mark.asyncio
async def test_default_application_is_selected_without_customer_configuration() -> None:
    store = SimpleNamespace(
        get_linear_application_preference=AsyncMock(return_value=None),
        list_linear_application_configs=AsyncMock(return_value=[]),
        save_linear_application_config=AsyncMock(),
        set_linear_application_preference=AsyncMock(),
    )
    app = _app(store=store)

    async with _client(app) as client:
        response = await client.get("/api/v1/linear/application")

    assert response.status_code == 200
    assert response.json()["application"]["source"] == "default"
    assert response.json()["application"]["version"] == 7
    assert response.json()["application"]["client_id"] == "default-client"
    store.save_linear_application_config.assert_awaited_once()
    store.set_linear_application_preference.assert_awaited_once()


def _prepare_callback_state(app: Any, *, active: dict[str, Any] | None = None) -> None:
    app.state.podium.consume_linear_oauth_state = AsyncMock(
        return_value={
            "workspace_id": "user-1",
            "application_config_id": "application-1",
            "application_config_version": 7,
            "code_verifier": "verifier-1",
        }
    )
    app.state.podium.get_linear_application_config = AsyncMock(
        return_value=_application()
    )
    app.state.podium.get_active_linear_installation = AsyncMock(return_value=active)
    app.state.podium.validate_candidate_project_access = AsyncMock()
    app.state.podium.save_linear_installation_record = AsyncMock()
    app.state.podium.activate_linear_installation = AsyncMock()
    app.state.podium.mark_linear_connected = AsyncMock()


@pytest.mark.asyncio
async def test_callback_uses_frozen_application_version_and_activates_fresh_installation() -> None:
    exchanged: dict[str, Any] = {}

    def exchange(code: str, application: dict[str, Any]) -> dict[str, Any]:
        exchanged.update({"code": code, "application": application})
        return _token("active-access")

    app = _app(
        user=None,
        linear_token_exchange=exchange,
        linear_installation_fetch=lambda _access_token: _acceptance(),
    )
    _prepare_callback_state(app)

    async with _client(app) as client:
        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "code-for-v7", "state": "state-1"},
            follow_redirects=False,
        )

    saved = app.state.podium.save_linear_installation_record.await_args.args[0]
    assert callback.status_code == 303
    assert callback.headers["location"] == "/setup/linear?linear=connected"
    assert exchanged["code"] == "code-for-v7"
    assert exchanged["application"]["id"] == "application-1"
    assert exchanged["application"]["version"] == 7
    assert saved["access_token"] == "active-access"
    assert saved["refresh_token"] == "refresh-active-access"
    assert "access_token" not in app.state.podium.linear_installation_public(saved)
    app.state.podium.activate_linear_installation.assert_awaited_once_with(
        "user-1", saved["id"]
    )


@pytest.mark.asyncio
async def test_same_application_reauthorization_rotates_tokens_without_candidate() -> None:
    active = {
        "id": "installation-active",
        "user_id": "user-1",
        "application_config_id": "application-1",
        "linear_organization_id": "linear-org-1",
        "app_user_id": "linear-app-user-1",
        "created_at": "2026-07-10T00:00:00Z",
    }
    app = _app(
        user=None,
        linear_token_exchange=lambda _code, _application: _token("rotated-access"),
        linear_installation_fetch=lambda _access_token: _acceptance(),
    )
    _prepare_callback_state(app, active=active)

    async with _client(app) as client:
        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "rotate", "state": "state-1"},
            follow_redirects=False,
        )

    saved = app.state.podium.save_linear_installation_record.await_args.args[0]
    assert callback.status_code == 303
    assert saved["id"] == "installation-active"
    assert saved["active"] is True
    assert saved["state"] == "ready"
    assert saved["access_token"] == "rotated-access"
    app.state.podium.activate_linear_installation.assert_not_awaited()


@pytest.mark.parametrize(
    ("token", "acceptance", "error_code"),
    [
        (_token(), _acceptance(app=False), "linear_viewer_not_app"),
        (_token(scope="read write"), _acceptance(), "linear_scope_missing"),
    ],
)
def test_installation_rejections_are_sanitized_and_require_reauthorization(
    token: dict[str, Any],
    acceptance: dict[str, Any],
    error_code: str,
) -> None:
    application = _application()
    with pytest.raises(LinearInstallationRejected) as raised:
        accepted_installation(
            user_id="user-1",
            application=application,
            token=token,
            acceptance=acceptance,
            installation_id="installation-rejected",
        )

    rejected = rejected_installation(
        user_id="user-1",
        application=application,
        installation_id="installation-rejected",
        rejection=raised.value,
    )
    assert rejected["state"] == "failed"
    assert rejected["error_code"] == error_code
    assert rejected["next_action"] == "reauthorize"
    assert rejected["access_token"] == ""
    assert rejected["refresh_token"] == ""


@pytest.mark.asyncio
async def test_callback_requires_code_and_valid_state() -> None:
    app = _app(user=None)
    _prepare_callback_state(app)

    async with _client(app) as client:
        missing_state = await client.get(
            "/api/v1/linear/oauth/callback", params={"code": "code"}
        )
        missing_code = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"state": "state-1"},
            follow_redirects=False,
        )

    assert missing_state.status_code == 400
    assert missing_state.json()["error"]["code"] == "missing_state"
    assert missing_code.status_code == 303
    assert "code=missing_code" in missing_code.headers["location"]


@pytest.mark.asyncio
async def test_project_selection_uses_stable_ids_and_rejects_invalid_sets() -> None:
    installation = {
        "linear_organization_id": "linear-org-1",
        "projects": [
            {"id": "linear-project-1", "name": "Alpha", "slug_id": "alpha"},
            {"id": "linear-project-2", "name": "Beta", "slug_id": "beta"},
        ],
    }
    selected_rows = [
        {
            "user_id": "user-1",
            "linear_organization_id": "linear-org-1",
            "linear_project_id": "linear-project-1",
            "project_slug": "alpha",
            "project_name": "Alpha",
            "access_state": "ready",
        },
        {
            "user_id": "user-1",
            "linear_organization_id": "linear-org-1",
            "linear_project_id": "linear-project-2",
            "project_slug": "beta",
            "project_name": "Beta",
            "access_state": "ready",
        },
    ]
    store = SimpleNamespace(
        replace_selected_linear_projects=AsyncMock(),
        list_selected_linear_projects=AsyncMock(return_value=selected_rows),
    )
    app = _app(store=store)
    app.state.podium.get_active_linear_installation = AsyncMock(
        return_value=installation
    )
    app.state.podium._mark_onboarding = AsyncMock()

    async with _client(app) as client:
        selected = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["linear-project-2", "linear-project-1"]},
        )
        unknown = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["missing-project"]},
        )
        duplicate = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["linear-project-1", "linear-project-1"]},
        )

    assert selected.status_code == 200
    assert [row["id"] for row in selected.json()["projects"] if row["selected"]] == [
        "linear-project-1",
        "linear-project-2",
    ]
    assert unknown.json()["error"]["code"] == "linear_project_not_accessible"
    assert duplicate.json()["error"]["code"] == "duplicate_linear_project"
    stored = store.replace_selected_linear_projects.await_args.args[1]
    assert [row["linear_project_id"] for row in stored] == [
        "linear-project-1",
        "linear-project-2",
    ]


@pytest.mark.asyncio
async def test_replacement_candidate_must_access_every_selected_project() -> None:
    store = SimpleNamespace(
        list_selected_linear_projects=AsyncMock(
            return_value=[
                {
                    "linear_organization_id": "linear-org-1",
                    "linear_project_id": "linear-project-2",
                }
            ]
        )
    )
    app = _app(store=store)
    candidate = {
        "linear_organization_id": "linear-org-1",
        "projects": [{"id": "linear-project-1", "name": "Alpha"}],
    }

    with pytest.raises(LinearInstallationRejected) as raised:
        await app.state.podium.validate_candidate_project_access("user-1", candidate)

    assert raised.value.code == "linear_selected_project_missing"
