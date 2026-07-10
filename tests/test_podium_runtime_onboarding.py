from __future__ import annotations

import httpx
import pytest

from podium.app import create_app

PODIUM_BASE_URL = "https://podium.test-config.example"


def _make_app() -> httpx.AsyncClient:
    app = create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        podium_base_url=PODIUM_BASE_URL,
    )
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://podium.test")
    client._podium_app = app  # type: ignore[attr-defined]
    return client


async def _register(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": "user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
    )
    assert resp.status_code == 200


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
    async with _make_app() as client:
        await _register(client)
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
async def test_status_before_and_after_enrollment() -> None:
    async with _make_app() as client:
        await _register(client)

        before = await client.get("/api/v1/onboarding/runtime/status")
        assert before.status_code == 200
        assert before.json()["runtime_count"] == 0
        assert before.json()["online_count"] == 0
        assert before.json()["token_pending"] is False

        token_resp = await client.post("/api/v1/onboarding/runtime/enrollment-token")
        token = token_resp.json()["enrollment_token"]

        pending = await client.get("/api/v1/onboarding/runtime/status")
        assert pending.json()["token_pending"] is True
        assert pending.json()["runtime_count"] == 0
        assert pending.json()["enrolled"] is False

        # Machine-facing enroll route works unchanged.
        enroll = await client.post(
            "/api/v1/runtime/enroll",
            json={"enrollment_token": token},
        )
        assert enroll.status_code == 200
        enroll_body = enroll.json()
        runtime_id = enroll_body["runtime_id"]

        after = await client.get("/api/v1/onboarding/runtime/status")
        assert after.status_code == 200
        assert after.json()["runtime_count"] == 1
        assert after.json()["enrolled"] is True
        assert after.json()["online_count"] == 0
        assert after.json()["token_pending"] is False

        # Seed persisted presence -> online_count reflects it and onboarding step completes.
        app = client._podium_app  # type: ignore[attr-defined]
        await app.state.podium.set_presence(runtime_id)

        online = await client.get("/api/v1/onboarding/runtime/status")
        assert online.json()["online_count"] == 1

        onboarding_status = await client.get("/api/v1/onboarding/status")
        assert "runtime_enrollment" in onboarding_status.json()["completed_steps"]
