from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from podium.linear_installation_acceptance import LinearInstallationRejected
from podium.linear_constants import LINEAR_REQUIRED_SCOPES
from podium.podium_routes_linear_oauth import register_linear_oauth_routes


SENTINELS = (
    "sentinel-oauth-code",
    "sentinel-oauth-state",
    "sentinel-code-verifier",
    "sentinel-access-token",
    "sentinel-refresh-token",
    "sentinel-client-secret",
    "sentinel-provider-error",
)


class CallbackState:
    def __init__(self) -> None:
        self.saved: list[dict[str, Any]] = []
        self.activated: list[tuple[str, str]] = []
        self.connected: list[str] = []

    async def consume_linear_oauth_state(self, value: str) -> dict[str, Any] | None:
        if value != SENTINELS[1]:
            return None
        return {
            "workspace_id": "workspace-1",
            "application_config_id": "application-1",
            "application_config_version": 1,
            "code_verifier": SENTINELS[2],
        }

    async def get_linear_application_config(self, _config_id: str) -> dict[str, Any]:
        return {
            "id": "application-1",
            "user_id": "workspace-1",
            "version": 1,
            "source": "default",
            "client_id": "client-1",
            "client_secret": SENTINELS[5],
            "callback_url": "https://podium.example/api/v1/linear/oauth/callback",
        }

    async def save_linear_installation_record(self, record: dict[str, Any]) -> list[str]:
        self.saved.append(dict(record))
        return []

    async def get_active_linear_installation(self, _user_id: str) -> None:
        return None

    async def validate_candidate_project_access(
        self,
        _user_id: str,
        _record: dict[str, Any],
    ) -> None:
        return None

    async def activate_linear_installation(self, user_id: str, installation_id: str) -> None:
        self.activated.append((user_id, installation_id))

    async def mark_linear_connected(self, user_id: str) -> None:
        self.connected.append(user_id)


def callback_app(
    state: CallbackState,
    *,
    token_exchange: Any,
) -> FastAPI:
    app = FastAPI()

    async def require_user(_request: Request) -> None:
        return None

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

    register_linear_oauth_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=token_exchange,
        linear_installation_fetch=lambda _token: {
            "viewer": {"id": "app-user-1", "app": True},
            "organization": {
                "id": "organization-1",
                "name": "Organization",
                "urlKey": "organization",
            },
            "projects": [
                {"id": "project-1", "name": "Project", "slugId": "project"},
            ],
        },
        linear_graphql_transport=None,
        error_response=error_response,
    )
    return app


async def get(app: FastAPI, path: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://podium.example",
        follow_redirects=False,
    ) as client:
        return await client.get(path)


def assert_safe_callback_surfaces(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    *responses: httpx.Response,
) -> None:
    captured = capsys.readouterr()
    visible = "\n".join(
        record.getMessage()
        for record in caplog.records
        if record.name == "podium.podium_routes_linear_oauth"
    )
    response_surfaces = [
        (response.status_code, response.headers, response.text)
        for response in responses
    ]
    visible += repr((captured.out, captured.err, response_surfaces))
    for sentinel in SENTINELS:
        assert sentinel not in visible


@pytest.mark.anyio
async def test_callback_logs_safe_early_rejections(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level("INFO")
    state = CallbackState()
    app = callback_app(state, token_exchange=lambda *_args: pytest.fail("unexpected exchange"))

    missing = await get(app, "/api/v1/linear/oauth/callback")
    invalid = await get(
        app,
        "/api/v1/linear/oauth/callback?state=invalid-sentinel-oauth-state",
    )

    assert missing.status_code == 400
    assert invalid.status_code == 400
    assert "outcome=rejected" in caplog.text
    assert "error_code=missing_state" in caplog.text
    assert "error_code=invalid_state" in caplog.text
    assert_safe_callback_surfaces(caplog, capsys, missing, invalid)


@pytest.mark.anyio
async def test_callback_logs_safe_denial_and_success(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level("INFO")
    state = CallbackState()
    app = callback_app(
        state,
        token_exchange=lambda *_args: {
            "access_token": SENTINELS[3],
            "refresh_token": SENTINELS[4],
            "token_type": "Bearer",
            "actor": "app",
            "scope": " ".join(sorted(LINEAR_REQUIRED_SCOPES)),
            "expires_in": 3600,
        },
    )

    denied = await get(
        app,
        f"/api/v1/linear/oauth/callback?state={SENTINELS[1]}&error={SENTINELS[6]}",
    )
    connected = await get(
        app,
        f"/api/v1/linear/oauth/callback?state={SENTINELS[1]}&code={SENTINELS[0]}",
    )

    assert denied.headers["location"] == "/setup/linear?linear=denied&code=linear_oauth_denied"
    assert connected.headers["location"] == "/setup/linear?linear=connected"
    assert "outcome=denied" in caplog.text
    assert "error_code=linear_oauth_denied" in caplog.text
    assert "outcome=connected" in caplog.text
    assert "error_code=none" in caplog.text
    assert_safe_callback_surfaces(caplog, capsys, denied, connected)


@pytest.mark.anyio
async def test_callback_logs_safe_expected_and_unexpected_failures(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level("INFO")
    rejected_state = CallbackState()
    rejected_app = callback_app(
        rejected_state,
        token_exchange=lambda *_args: (_ for _ in ()).throw(
            LinearInstallationRejected("linear_token_exchange_failed", "Sanitized failure")
        ),
    )
    rejected = await get(
        rejected_app,
        f"/api/v1/linear/oauth/callback?state={SENTINELS[1]}&code={SENTINELS[0]}",
    )

    failed_state = CallbackState()
    failed_app = callback_app(
        failed_state,
        token_exchange=lambda *_args: (_ for _ in ()).throw(RuntimeError(SENTINELS[6])),
    )
    failed = await get(
        failed_app,
        f"/api/v1/linear/oauth/callback?state={SENTINELS[1]}&code={SENTINELS[0]}",
    )

    assert rejected.headers["location"] == (
        "/setup/linear?linear=error&code=linear_token_exchange_failed"
    )
    assert failed.headers["location"] == (
        "/setup/linear?linear=error&code=linear_oauth_callback_failed"
    )
    assert "outcome=rejected" in caplog.text
    assert "error_code=linear_token_exchange_failed" in caplog.text
    assert "outcome=failed" in caplog.text
    assert "error_code=linear_oauth_callback_failed" in caplog.text
    assert failed_state.saved[0]["error_code"] == "linear_oauth_callback_failed"
    assert_safe_callback_surfaces(caplog, capsys, rejected, failed)
