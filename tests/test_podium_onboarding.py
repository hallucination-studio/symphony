from __future__ import annotations

import httpx
import pytest

from podium.app import create_app
from podium.store.postgres import PgStore


def app_client(*, pg_store: PgStore | None = None) -> httpx.AsyncClient:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        pg_store=pg_store,
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://podium.test")


async def _register(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_onboarding_status_requires_auth() -> None:
    async with app_client() as client:
        resp = await client.get("/api/v1/onboarding/status")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_onboarding_status_initial_shape() -> None:
    async with app_client() as client:
        await _register(client)
        resp = await client.get("/api/v1/onboarding/status")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"current_step", "completed_steps", "next_action"}
        assert body["current_step"] == "linear_connect"
        assert body["completed_steps"] == []
        assert body["next_action"] == "linear_connect"


@pytest.mark.asyncio
async def test_onboarding_scope_and_repository_flow() -> None:
    async with app_client() as client:
        await _register(client)

        scope = await client.post(
            "/api/v1/onboarding/scope",
            json={"teams": ["ENG"], "projects": ["proj-1"]},
        )
        assert scope.status_code == 200
        assert "scope_selection" in scope.json()["onboarding"]["completed_steps"]

        repo = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "git_url", "value": "https://example.com/repo.git"},
        )
        assert repo.status_code == 200
        body = repo.json()
        assert body["repository"] == {
            "mode": "git_url",
            "value": "https://example.com/repo.git",
            "validation_state": "valid",
        }
        assert "repository_mapping" in body["onboarding"]["completed_steps"]

        bad = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "nope", "value": "x"},
        )
        assert bad.status_code == 400
        assert bad.json()["error"]["code"] == "invalid_mode"


@pytest.mark.asyncio
async def test_smoke_check_flow() -> None:
    async with app_client() as client:
        await _register(client)

        missing = await client.get("/api/v1/onboarding/smoke-check/result")
        assert missing.status_code == 404

        run = await client.post("/api/v1/onboarding/smoke-check")
        assert run.status_code == 200
        result = run.json()
        assert result["status"] == "passed"
        assert result["checks"] == [{"name": "runtime_online", "passed": True}]
        assert result["recommendations"] == []
        assert "timestamp" in result

        stored = await client.get("/api/v1/onboarding/smoke-check/result")
        assert stored.status_code == 200
        assert stored.json() == result

        status = await client.get("/api/v1/onboarding/status")
        assert "smoke_check" in status.json()["completed_steps"]


@pytest.mark.asyncio
async def test_onboarding_persists_across_app_instances_with_injected_store() -> None:
    store = PgStore()
    async with app_client(pg_store=store) as client:
        await _register(client)
        await client.post(
            "/api/v1/onboarding/scope",
            json={"teams": ["ENG"], "projects": ["proj-1"]},
        )
        await client.post("/api/v1/onboarding/smoke-check")

    async with app_client(pg_store=store) as restarted:
        login = await restarted.post(
            "/api/v1/auth/login",
            json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert login.status_code == 200
        progress = await restarted.get("/api/v1/onboarding/status")
        smoke = await restarted.get("/api/v1/onboarding/smoke-check/result")

    assert "scope_selection" in progress.json()["completed_steps"]
    assert "smoke_check" in progress.json()["completed_steps"]
    assert smoke.status_code == 200
    assert smoke.json()["status"] == "passed"
