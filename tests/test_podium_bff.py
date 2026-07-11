from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import parse_qsl, urlparse

import httpx
import pytest
from fastapi import FastAPI

from podium.app import create_app


USER = {"id": "user-1", "email": "operator@example.com"}


def _app(*, user: dict[str, str] | None = USER, store: Any = None, **overrides: Any) -> FastAPI:
    app = create_app(
        turnstile_verifier=lambda _token, _ip: True,
        secure_cookies=False,
        static_dir=None,
        secret_key="test-secret",
        store=store if store is not None else object(),
        **overrides,
    )
    app.state.podium.user_for_session = AsyncMock(return_value=user)
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


@pytest.mark.asyncio
async def test_bootstrap_requires_auth() -> None:
    app = _app(user=None)
    async with _client(app) as client:
        response = await client.get("/api/v1/bootstrap")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_bootstrap_returns_sanitized_session_onboarding_and_linear_state() -> None:
    app = _app()
    app.state.podium.get_active_linear_installation = AsyncMock(return_value=None)
    app.state.podium.onboarding_progress = AsyncMock(
        return_value={
            "current_step": "runtime_enrollment",
            "completed_steps": ["linear_connect", "scope_selection"],
            "next_action": "runtime_enrollment",
        }
    )
    app.state.podium.linear_status = AsyncMock(
        return_value={
            "workspace_id": "user-1",
            "state": "connected",
            "app_user_id": "linear-app-user",
        }
    )

    async with _client(app) as client:
        response = await client.get("/api/v1/bootstrap")

    assert response.status_code == 200
    assert response.json() == {
        "session": {
            "workspace_id": "user-1",
            "user_id": "user-1",
            "email": "operator@example.com",
        },
        "onboarding": {
            "current_step": "runtime_enrollment",
            "completed_steps": ["linear_connect", "scope_selection"],
            "next_action": "runtime_enrollment",
        },
        "linear": {
            "workspace_id": "user-1",
            "state": "connected",
            "app_user_id": "linear-app-user",
        },
    }
    for secret_field in (
        "access_token",
        "refresh_token",
        "password_hash",
        "runtime_token",
        "proxy_token",
    ):
        assert secret_field not in response.text


@pytest.mark.asyncio
async def test_linear_oauth_start_returns_app_actor_authorization_url() -> None:
    app = _app()
    app.state.podium.selected_linear_application = AsyncMock(
        return_value={
            "id": "application-1",
            "version": 7,
            "client_id": "client-1",
            "callback_url": "https://podium.example/api/v1/linear/oauth/callback",
        }
    )
    app.state.podium.create_linear_oauth_state = AsyncMock(
        return_value={"state": "state-1", "code_challenge": "challenge-1"}
    )

    async with _client(app) as client:
        response = await client.post("/api/v1/linear/installations/oauth", json={})

    query = dict(parse_qsl(urlparse(response.json()["authorization_url"]).query))
    assert response.status_code == 200
    assert query["actor"] == "app"
    assert query["state"] == "state-1"
    assert query["code_challenge_method"] == "S256"


@pytest.mark.asyncio
async def test_onboarding_scope_and_repository_routes_validate_and_delegate() -> None:
    progress = {
        "current_step": "runtime_enrollment",
        "completed_steps": ["scope_selection", "repository_mapping"],
        "next_action": "runtime_enrollment",
    }
    app = _app()
    app.state.podium.save_onboarding_scope = AsyncMock(return_value=progress)
    app.state.podium.save_onboarding_repository = AsyncMock(return_value=progress)

    async with _client(app) as client:
        scope = await client.post(
            "/api/v1/onboarding/scope",
            json={"teams": ["team-1"], "projects": ["project-1"]},
        )
        valid = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "git_url", "value": "https://github.com/acme/repo.git"},
        )
        invalid = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "git_url", "value": "not-a-url"},
        )
        unknown = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "unknown", "value": "repo"},
        )

    assert scope.status_code == 200
    assert valid.json()["repository"]["validation_state"] == "valid"
    assert invalid.json()["repository"]["validation_state"] == "invalid"
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "invalid_mode"
    app.state.podium.save_onboarding_scope.assert_awaited_once_with(
        "user-1", ["team-1"], ["project-1"]
    )
    assert app.state.podium.save_onboarding_repository.await_count == 2


@pytest.mark.asyncio
async def test_runtime_enroll_surfaces_invalid_persisted_token() -> None:
    app = _app(user=None)
    app.state.podium.consume_enrollment_token = AsyncMock(
        return_value=(None, "invalid_enrollment_token")
    )

    async with _client(app) as client:
        response = await client.post(
            "/api/v1/runtime/enroll",
            json={"enrollment_token": "never-issued"},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_enrollment_token"


@pytest.mark.asyncio
async def test_runtime_listing_projects_presence_from_store_results() -> None:
    runtime = {
        "id": "runtime-1",
        "user_id": "user-1",
        "version": "1.2.3",
        "metadata": {"hostname": "build-host"},
    }
    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(return_value=[runtime]),
        get_runtime=AsyncMock(return_value=runtime),
    )
    app = _app(store=store)
    app.state.podium.list_conductors_for_user = AsyncMock(
        return_value=[
            {
                "id": "runtime-1",
                "runtime_id": "runtime-1",
                "online": True,
                "bindings": [],
            }
        ]
    )
    app.state.podium.runtime_presence_snapshot = AsyncMock(
        return_value={"runtime-1": "2026-07-11T00:00:00Z"}
    )

    async with _client(app) as client:
        response = await client.get("/api/v1/runtimes")

    assert response.status_code == 200
    assert response.json()["runtimes"] == [
        {
            "runtime_id": "runtime-1",
            "online": True,
            "last_heartbeat": "2026-07-11T00:00:00Z",
            "version": "1.2.3",
            "metadata": {"hostname": "build-host"},
        }
    ]


@pytest.mark.asyncio
async def test_runtime_detail_returns_not_found_for_unknown_persisted_runtime() -> None:
    store = SimpleNamespace(get_runtime=AsyncMock(return_value=None))
    app = _app(store=store)

    async with _client(app) as client:
        response = await client.get("/api/v1/runtimes/missing")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_smoke_routes_return_capability_results_and_legacy_runs_stay_removed() -> None:
    result = {
        "smoke_check_id": "smoke-1",
        "status": "passed",
        "checks": [{"id": "runtime", "status": "passed"}],
    }
    app = _app()
    app.state.podium.start_smoke_check = AsyncMock(return_value=result)
    app.state.podium.get_smoke_result = AsyncMock(return_value=result)

    async with _client(app) as client:
        started = await client.post("/api/v1/onboarding/smoke-check", json={})
        loaded = await client.get("/api/v1/onboarding/smoke-check/result")
        recent = await client.get("/api/v1/runs/recent")
        detail = await client.get("/api/v1/runs/run-1")

    assert started.status_code == 200
    assert loaded.status_code == 200
    assert json.loads(loaded.content) == result
    assert (recent.status_code, detail.status_code) == (404, 404)
