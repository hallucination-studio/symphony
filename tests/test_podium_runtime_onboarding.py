from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app

PODIUM_BASE_URL = "https://podium.test-config.example"


def _make_app(*, store: Any = None) -> httpx.AsyncClient:
    selected_store = store or SimpleNamespace(get_session=AsyncMock(return_value=None))
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        podium_base_url=PODIUM_BASE_URL,
        store=selected_store,
    )
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://podium.test")
    client._podium_app = app  # type: ignore[attr-defined]
    return client


@pytest.mark.asyncio
async def test_enrollment_token_requires_auth() -> None:
    async with _make_app() as client:
        resp = await client.post("/api/v1/onboarding/runtime/enrollment-token")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_runtime_status_requires_auth() -> None:
    async with _make_app() as client:
        resp = await client.get("/api/v1/onboarding/runtime/status")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_enrollment_token_shape_and_install_command() -> None:
    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(return_value=[]),
        list_runtime_groups=AsyncMock(return_value=[]),
        list_all_conductors=AsyncMock(return_value=[]),
        upsert_runtime_group=AsyncMock(),
        upsert_conductor=AsyncMock(),
        save_enrollment_token=AsyncMock(),
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
        get_presence=AsyncMock(return_value=None),
    )
    async with _make_app(store=store) as client:
        app = client._podium_app  # type: ignore[attr-defined]
        app.state.podium.user_for_session = AsyncMock(
            return_value={"id": "user-1", "email": "user@example.com"}
        )
        resp = await client.post("/api/v1/onboarding/runtime/enrollment-token")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"enrollment_token", "install_command", "expires_at", "conductor"}
        assert body["conductor"]["enrollment_state"] == "pending"
        assert body["conductor"]["binding"] is None
        token = body["enrollment_token"]
        assert token
        assert PODIUM_BASE_URL in body["install_command"]
        assert token in body["install_command"]
        assert f"--enrollment-token {token}" not in body["install_command"]
        assert "PODIUM_ENROLLMENT_TOKEN=" in body["install_command"]
        assert body["expires_at"].endswith("Z")
        store.save_enrollment_token.assert_awaited_once()


@pytest.mark.asyncio
async def test_install_script_exists_and_uses_enrollment_token() -> None:
    async with _make_app() as client:
        response = await client.get("/install.sh")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/x-shellscript")
    script = response.text
    assert "--enrollment-token" in script
    assert 'ENROLLMENT_TOKEN="${PODIUM_ENROLLMENT_TOKEN:-}"' in script
    assert 'RUNTIME_GROUP_ID="' in script
    assert '"runtime_group_id": runtime_group_id' in script
    assert 'token = os.environ.get("PODIUM_ENROLLMENT_TOKEN", "")' in script
    assert '"$ENROLLMENT_TOKEN" <<' not in script
    assert "token = sys.argv[2]" not in script
    assert 'ENROLLMENT_RESULT_PATH="${PODIUM_ENROLLMENT_RESULT_PATH:-}"' in script
    assert 'umask 077' in script
    assert 'chmod 600 "$ENROLLMENT_RESULT_PATH"' in script
    assert "/api/v1/runtime/enroll" in script
    assert "/api/settings" in script


@pytest.mark.asyncio
async def test_runtime_status_projects_persisted_enrollment_and_presence() -> None:
    conductor = {
        "id": "runtime-1",
        "runtime_group_id": "group-1",
        "enrollment_state": "enrolled",
    }
    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(return_value=[conductor]),
        get_presence=AsyncMock(
            return_value={
                "runtime_id": "runtime-1",
                "last_seen_at": "2026-07-11T00:00:00Z",
            }
        ),
        has_pending_enrollment=AsyncMock(return_value=False),
    )
    async with _make_app(store=store) as client:
        app = client._podium_app  # type: ignore[attr-defined]
        app.state.podium.user_for_session = AsyncMock(
            return_value={"id": "user-1", "email": "user@example.com"}
        )
        app.state.podium.mark_runtime_enrolled = AsyncMock()
        response = await client.get("/api/v1/onboarding/runtime/status")

    assert response.status_code == 200
    assert response.json() == {
        "workspace_id": "user-1",
        "token_pending": False,
        "runtime_count": 1,
        "online_count": 1,
        "enrolled": True,
    }
    app.state.podium.mark_runtime_enrolled.assert_awaited_once_with("user-1")
