from __future__ import annotations

import urllib.parse
from typing import Any

import httpx
import pytest

from podium.app import create_app
from podium.config import PodiumConfig
from podium.store import PodiumStore


DEFAULT_APP = {
    "linear_client_id": "default-client",
    "linear_client_secret": "default-secret",
    "linear_redirect_uri": "https://podium.test/api/v1/linear/oauth/callback",
    "linear_application_version": 7,
    "podium_base_url": "https://podium.test",
}


def _acceptance(*, app: bool = True) -> dict[str, Any]:
    return {
        "viewer": {
            "id": "linear-app-user-1",
            "name": "Symphony",
            "app": app,
        },
        "organization": {"id": "linear-org-1", "name": "Acme", "urlKey": "acme"},
        "projects": [
            {"id": "linear-project-1", "name": "Alpha", "slugId": "alpha"},
            {"id": "linear-project-2", "name": "Beta", "slugId": "beta"},
        ],
    }


def _token(access_token: str = "access-1") -> dict[str, Any]:
    return {
        "access_token": access_token,
        "refresh_token": f"refresh-{access_token}",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "read write app:assignable",
        "actor": "app",
    }


def _client(**overrides: Any) -> tuple[httpx.AsyncClient, Any, PodiumStore]:
    store = overrides.pop("store", PodiumStore())
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "ok",
        secure_cookies=False,
        secret_key="test-secret-key",
        store=store,
        **DEFAULT_APP,
        **overrides,
    )
    return (
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test"),
        app,
        store,
    )


async def _register(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "owner@example.com", "password": "correct-horse", "turnstile_token": "ok"},
    )
    assert response.status_code == 200


def _oauth_params(response: httpx.Response) -> dict[str, str]:
    assert response.status_code == 200
    url = response.json()["authorization_url"]
    return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))


def test_config_reads_default_application_and_removes_global_actor_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "client-id")
    monkeypatch.setenv("LINEAR_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("LINEAR_REDIRECT_URI", "https://podium.test/api/v1/linear/oauth/callback")
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
async def test_custom_application_uses_fixed_podium_urls_and_never_returns_secrets() -> None:
    client, _app, _store = _client()
    async with client:
        await _register(client)
        rejected = await client.put(
            "/api/v1/linear/application",
            json={
                "client_id": "custom-client",
                "client_secret": "custom-secret",
                "redirect_uri": "https://attacker.test/callback",
            },
        )
        assert rejected.status_code == 400
        assert rejected.json()["error"]["code"] == "invalid_linear_application"

        saved = await client.put(
            "/api/v1/linear/application",
            json={
                "client_id": "custom-client",
                "client_secret": "custom-secret",
            },
        )
        assert saved.status_code == 200
        application = saved.json()["application"]
        assert application["source"] == "custom"
        assert application["client_id"] == "custom-client"
        assert application["callback_url"] == "https://podium.test/api/v1/linear/oauth/callback"
        assert application["version"] == 1
        assert "custom-secret" not in saved.text

        loaded = await client.get("/api/v1/linear/application")
        assert loaded.json()["application"] == application
        assert "secret" not in loaded.text.lower()


@pytest.mark.asyncio
async def test_default_application_is_selected_without_customer_configuration() -> None:
    client, _app, _store = _client()
    async with client:
        await _register(client)
        application = (await client.get("/api/v1/linear/application")).json()["application"]
        assert application["source"] == "default"
        assert application["version"] == 7
        assert application["client_id"] == "default-client"

        params = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        assert params["client_id"] == "default-client"
        assert params["redirect_uri"] == application["callback_url"]
        assert params["actor"] == "app"
        assert set(params["scope"].split(",")) == {"read", "write", "app:assignable"}
        assert params["code_challenge_method"] == "S256"
        assert params["code_challenge"]


@pytest.mark.asyncio
async def test_selecting_default_after_custom_keeps_both_versions_immutable() -> None:
    client, app, _store = _client()
    async with client:
        await _register(client)
        custom = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom", "client_secret": "custom-secret"},
        )
        selected_default = await client.post("/api/v1/linear/application/default")
        assert selected_default.status_code == 200
        assert selected_default.json()["application"]["source"] == "default"

    configs = await app.state.podium.list_linear_application_configs("user_1")
    assert {(row["source"], row["version"]) for row in configs} == {("custom", 1), ("default", 7)}
    assert custom.json()["application"]["id"] != selected_default.json()["application"]["id"]


@pytest.mark.asyncio
async def test_oauth_state_uses_the_immutable_application_version_that_started_it() -> None:
    exchanged: dict[str, Any] = {}

    def exchange(code: str, application: dict[str, Any]) -> dict[str, Any]:
        exchanged.update({"code": code, "application": application})
        return _token()

    client, _app, _store = _client(
        linear_token_exchange=exchange,
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with client:
        await _register(client)
        first = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom-v1", "client_secret": "secret-v1"},
        )
        first_config = first.json()["application"]
        oauth = await client.post("/api/v1/linear/installations/oauth")
        params = _oauth_params(oauth)
        assert params["client_id"] == "custom-v1"
        assert params["redirect_uri"] == "https://podium.test/api/v1/linear/oauth/callback"
        assert params["actor"] == "app"

        second = await client.put(
            "/api/v1/linear/application",
            json={"client_id": "custom-v2", "client_secret": "secret-v2"},
        )
        assert second.json()["application"]["version"] == 2

        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "code-for-v1", "state": params["state"]},
        )
        assert callback.status_code == 303

    assert exchanged["code"] == "code-for-v1"
    assert exchanged["application"]["id"] == first_config["id"]
    assert exchanged["application"]["version"] == 1
    assert exchanged["application"]["client_id"] == "custom-v1"
    assert exchanged["application"]["client_secret"] == "secret-v1"


@pytest.mark.asyncio
async def test_callback_acceptance_activates_fresh_installation_and_keeps_tokens_private() -> None:
    client, app, _store = _client(
        linear_token_exchange=lambda _code, _application: _token("active-access"),
        linear_installation_fetch=lambda token: _acceptance() if token == "active-access" else {},
    )
    async with client:
        await _register(client)
        oauth = await client.post("/api/v1/linear/installations/oauth")
        params = _oauth_params(oauth)
        callback = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "valid-code", "state": params["state"]},
        )
        assert callback.status_code == 303

        status = await client.get("/api/v1/linear/installations")
        assert status.status_code == 200
        active = status.json()["active"]
        assert active["state"] == "ready"
        assert active["linear_organization_id"] == "linear-org-1"
        assert active["app_user_id"] == "linear-app-user-1"
        assert active["project_count"] == 2
        assert status.json()["candidate"] is None
        assert "active-access" not in status.text
        assert "refresh-active-access" not in status.text

    stored = await app.state.podium.get_active_linear_installation("user_1")
    assert stored is not None
    assert stored["access_token"] == "active-access"
    assert stored["refresh_token"] == "refresh-active-access"


@pytest.mark.asyncio
async def test_rejected_candidate_never_replaces_the_active_installation() -> None:
    def exchange(code: str, _application: dict[str, Any]) -> dict[str, Any]:
        return _token(f"access-{code}")

    def fetch(token: str) -> dict[str, Any]:
        if token == "access-invalid":
            return _acceptance(app=False)
        return _acceptance()

    client, _app, _store = _client(linear_token_exchange=exchange, linear_installation_fetch=fetch)
    async with client:
        await _register(client)
        first = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        assert (
            await client.get(
                "/api/v1/linear/oauth/callback",
                params={"code": "active", "state": first["state"]},
            )
        ).status_code == 303

        await client.put(
            "/api/v1/linear/application",
            json={"client_id": "bad-client", "client_secret": "bad-secret"},
        )
        second = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))
        rejected = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "invalid", "state": second["state"]},
        )
        assert rejected.status_code == 303
        assert "code=linear_viewer_not_app" in rejected.headers["location"]

        status = (await client.get("/api/v1/linear/installations")).json()
        assert status["active"]["state"] == "ready"
        assert status["active"]["application_source"] == "default"
        assert "access_token" not in status["active"]
        assert status["candidate"]["state"] == "failed"
        assert status["candidate"]["error_code"] == "linear_viewer_not_app"
        assert "access-active" not in str(status)
        assert "access-invalid" not in str(status)


@pytest.mark.asyncio
async def test_callback_rejects_missing_required_scope_with_durable_reason() -> None:
    token = _token()
    token["scope"] = "read write"
    client, _app, _store = _client(
        linear_token_exchange=lambda _code, _application: token,
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with client:
        await _register(client)
        state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]
        rejected = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "missing-scope", "state": state},
        )
        assert rejected.status_code == 303
        assert "code=linear_scope_missing" in rejected.headers["location"]
        candidate = (await client.get("/api/v1/linear/installations")).json()["candidate"]
        assert candidate["state"] == "failed"
        assert candidate["error_code"] == "linear_scope_missing"
        assert candidate["next_action"] == "reauthorize"


@pytest.mark.asyncio
async def test_callback_state_is_one_time_and_works_across_app_workers() -> None:
    store = PodiumStore()
    first_client, _first_app, _store = _client(store=store)
    async with first_client:
        await _register(first_client)
        state = _oauth_params(await first_client.post("/api/v1/linear/installations/oauth"))["state"]

    second_client, _second_app, _store = _client(
        store=store,
        linear_token_exchange=lambda _code, _application: _token(),
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with second_client:
        accepted = await second_client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "cross-worker", "state": state},
        )
        replay = await second_client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "cross-worker", "state": state},
        )
    assert accepted.status_code == 303
    assert replay.status_code == 400
    assert replay.json()["error"]["code"] == "invalid_state"


@pytest.mark.asyncio
async def test_callback_requires_code_and_state() -> None:
    client, _app, _store = _client()
    async with client:
        await _register(client)
        missing_state = await client.get("/api/v1/linear/oauth/callback", params={"code": "code"})
        state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]
        missing_code = await client.get("/api/v1/linear/oauth/callback", params={"state": state})
    assert missing_state.status_code == 400
    assert missing_state.json()["error"]["code"] == "missing_state"
    assert missing_code.status_code == 303
    assert "code=missing_code" in missing_code.headers["location"]


@pytest.mark.asyncio
async def test_projects_are_selected_by_stable_id_without_mutating_linear_membership() -> None:
    upstream_calls: list[str] = []

    def transport(request: httpx.Request) -> httpx.Response:
        upstream_calls.append(request.content.decode())
        return httpx.Response(500, json={"errors": [{"message": "unexpected"}]})

    client, app, _store = _client(
        linear_token_exchange=lambda _code, _application: _token(),
        linear_installation_fetch=lambda _token: _acceptance(),
        linear_graphql_transport=transport,
    )
    async with client:
        await _register(client)
        state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]
        accepted = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "project-selection", "state": state},
        )
        assert accepted.status_code == 303

        available = await client.get("/api/v1/linear/projects")
        assert available.status_code == 200
        assert [(row["id"], row["selected"]) for row in available.json()["projects"]] == [
            ("linear-project-1", False),
            ("linear-project-2", False),
        ]

        selected = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["linear-project-2", "linear-project-1"]},
        )
        assert selected.status_code == 200
        assert [row["id"] for row in selected.json()["projects"] if row["selected"]] == [
            "linear-project-1",
            "linear-project-2",
        ]
        assert upstream_calls == []

    stored = await app.state.podium.list_selected_linear_projects("user_1")
    assert stored == [
        {
            "user_id": "user_1",
            "linear_organization_id": "linear-org-1",
            "linear_project_id": "linear-project-1",
            "project_slug": "alpha",
            "project_name": "Alpha",
            "access_state": "ready",
        },
        {
            "user_id": "user_1",
            "linear_organization_id": "linear-org-1",
            "linear_project_id": "linear-project-2",
            "project_slug": "beta",
            "project_name": "Beta",
            "access_state": "ready",
        },
    ]


@pytest.mark.asyncio
async def test_project_selection_rejects_unknown_or_duplicate_ids() -> None:
    client, _app, _store = _client(
        linear_token_exchange=lambda _code, _application: _token(),
        linear_installation_fetch=lambda _token: _acceptance(),
    )
    async with client:
        await _register(client)
        state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]
        await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "project-validation", "state": state},
        )

        unknown = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["missing-project"]},
        )
        duplicate = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["linear-project-1", "linear-project-1"]},
        )

    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "linear_project_not_accessible"
    assert duplicate.status_code == 400
    assert duplicate.json()["error"]["code"] == "duplicate_linear_project"


@pytest.mark.asyncio
async def test_replacement_candidate_must_access_every_selected_project() -> None:
    def exchange(code: str, _application: dict[str, Any]) -> dict[str, Any]:
        return _token(f"access-{code}")

    def fetch(token: str) -> dict[str, Any]:
        acceptance = _acceptance()
        if token == "access-replacement":
            acceptance["projects"] = [acceptance["projects"][0]]
        return acceptance

    client, _app, _store = _client(linear_token_exchange=exchange, linear_installation_fetch=fetch)
    async with client:
        await _register(client)
        first_state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]
        await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "active", "state": first_state},
        )
        await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["linear-project-2"]},
        )
        await client.put(
            "/api/v1/linear/application",
            json={"client_id": "replacement", "client_secret": "secret"},
        )
        replacement_state = _oauth_params(await client.post("/api/v1/linear/installations/oauth"))["state"]

        rejected = await client.get(
            "/api/v1/linear/oauth/callback",
            params={"code": "replacement", "state": replacement_state},
        )
        installations = (await client.get("/api/v1/linear/installations")).json()

    assert rejected.status_code == 303
    assert "code=linear_selected_project_missing" in rejected.headers["location"]
    assert installations["active"]["application_source"] == "default"
    assert installations["candidate"]["state"] == "failed"
    assert installations["candidate"]["error_code"] == "linear_selected_project_missing"
