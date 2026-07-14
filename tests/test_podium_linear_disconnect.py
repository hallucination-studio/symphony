from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import anyio
import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from podium.linear_constants import LINEAR_REQUIRED_SCOPES
from podium.linear_token_service import LinearTokenUnavailable, PodiumLinearTokenMixin
from podium.podium_linear_cutover import PodiumLinearCutoverMixin
from podium.podium_routes_linear_disconnect import register_linear_disconnect_route


class DisconnectStore:
    def __init__(self, state: "DisconnectState") -> None:
        self.state = state
        self.disconnects: list[tuple[str, str]] = []
        self.token_lock = asyncio.Lock()

    @asynccontextmanager
    async def linear_installation_token_lock(self, _installation_id: str):
        async with self.token_lock:
            yield

    async def list_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        return list(self.state.bindings)

    async def list_all_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        if not self.state.active_work:
            return list(self.state.bindings)
        return [
            {
                "id": "binding-history-1",
                "conductor_id": "conductor-1",
                "config_version": 1,
                "active": False,
            }
        ]

    async def count_open_dispatches_for_user(self, _user_id: str) -> int:
        return 0

    async def get_managed_run_view(self, _conductor_id: str) -> dict[str, Any]:
        return {
            "binding_id": "binding-history-1",
            "binding_config_version": 1,
            "active_runs_total": 1 if self.state.active_work else 0,
            "runs": [],
        }

    async def disconnect_workspace_installation(
        self,
        user_id: str,
        installation_id: str,
    ) -> tuple[bool, list[str]]:
        blocked = [
            str(binding["linear_project_id"])
            for binding in self.state.bindings
            if binding.get("active", True)
        ]
        if blocked:
            return False, blocked
        self.disconnects.append((user_id, installation_id))
        self.state.installation["active"] = False
        self.state.installation["state"] = "disconnected"
        return True, []


class DisconnectState(PodiumLinearTokenMixin, PodiumLinearCutoverMixin):
    def __init__(
        self,
        *,
        bindings: list[dict[str, Any]] | None = None,
        active_work: bool = False,
        failed_hints: set[str] | None = None,
    ) -> None:
        self.installation = {
            "id": "installation-1",
            "user_id": "user-1",
            "active": True,
            "state": "ready",
            "access_token": "sentinel-access-token",
            "refresh_token": "sentinel-refresh-token",
            "application_config_id": "application-1",
            "scope": sorted(LINEAR_REQUIRED_SCOPES),
            "expires_at": "2026-07-14T00:00:00Z",
        }
        self.bindings = bindings or []
        self.active_work = active_work
        self.failed_hints = failed_hints or set()
        self.revocations: list[tuple[str, str]] = []
        self.saved: list[tuple[dict[str, Any], list[dict[str, Any]] | None]] = []
        self.store = DisconnectStore(self)
        self.linear_token_revoke = self._revoke

    async def get_active_linear_installation(self, _user_id: str) -> dict[str, Any] | None:
        return dict(self.installation) if self.installation.get("active") else None

    async def get_linear_installation_record(
        self,
        _user_id: str,
        _installation_id: str,
    ) -> dict[str, Any] | None:
        return dict(self.installation)

    async def get_linear_application_config(self, _config_id: str) -> dict[str, str]:
        return {"client_id": "client-1", "client_secret": "sentinel-client-secret"}

    async def _revoke(self, token: str, hint: str) -> None:
        self.revocations.append((token, hint))
        if hint in self.failed_hints:
            raise RuntimeError(f"failed {hint}")

    async def save_linear_installation_record(
        self,
        record: dict[str, Any],
        *,
        reauthorized_projects: list[dict[str, Any]] | None = None,
    ) -> list[str]:
        self.installation = dict(record)
        self.saved.append((dict(record), reauthorized_projects))
        return []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("bindings", "active_work", "next_action"),
    [
        ([{"linear_project_id": "project-1", "active": True}], False, "unbind_projects"),
        ([], True, "wait_for_managed_work"),
    ],
)
async def test_disconnect_blocks_resources_in_use_without_mutation(
    bindings: list[dict[str, Any]],
    active_work: bool,
    next_action: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = DisconnectState(bindings=bindings, active_work=active_work)
    before = dict(state.installation)

    with pytest.raises(LinearTokenUnavailable) as raised:
        await state.disconnect_linear_installation("user-1")

    assert raised.value.code == "linear_disconnect_in_use"
    assert raised.value.next_action == next_action
    assert state.installation == before
    assert state.store.disconnects == []
    assert state.revocations == []
    assert state.saved == []
    assert any(
        "event=linear_disconnect_blocked" in message
        and "error_code=linear_disconnect_in_use" in message
        and f"next_action={next_action}" in message
        for message in caplog.messages
    )


@pytest.mark.anyio
async def test_safe_disconnect_revokes_both_tokens_and_clears_projects() -> None:
    state = DisconnectState()

    result = await state.disconnect_linear_installation("user-1")

    assert result == {"state": "disconnected"}
    assert state.store.disconnects == [("user-1", "installation-1")]
    assert state.revocations == [
        ("sentinel-refresh-token", "refresh_token"),
        ("sentinel-access-token", "access_token"),
    ]
    saved, reauthorized_projects = state.saved[-1]
    assert saved["active"] is False
    assert saved["state"] == "disconnected"
    assert saved["access_token"] == ""
    assert saved["refresh_token"] == ""
    assert reauthorized_projects == []


@pytest.mark.anyio
async def test_partial_revocation_attempts_both_tokens_and_stays_retryable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = DisconnectState(failed_hints={"refresh_token"})

    with pytest.raises(LinearTokenUnavailable) as raised:
        await state.disconnect_linear_installation("user-1")

    assert raised.value.code == "linear_token_revocation_failed"
    assert [hint for _token, hint in state.revocations] == [
        "refresh_token",
        "access_token",
    ]
    failed, reauthorized_projects = state.saved[-1]
    assert failed["active"] is False
    assert failed["state"] == "disconnected_revocation_failed"
    assert failed["error_code"] == "linear_token_revocation_failed"
    assert failed["retryable"] is True
    assert reauthorized_projects is None
    visible = repr(caplog.messages)
    assert "linear_token_revocation_failed" in visible
    assert "sentinel-refresh-token" not in visible
    assert "sentinel-access-token" not in visible


@pytest.mark.anyio
async def test_revocation_retry_succeeds_and_is_idempotent() -> None:
    state = DisconnectState()
    state.installation.update(
        {
            "active": False,
            "state": "disconnected_revocation_failed",
            "error_code": "linear_token_revocation_failed",
        }
    )

    first = await state.retry_linear_revocation("user-1", "installation-1")
    second = await state.retry_linear_revocation("user-1", "installation-1")

    assert first == {"state": "disconnected"}
    assert second == {"state": "disconnected"}
    assert [hint for _token, hint in state.revocations] == [
        "refresh_token",
        "access_token",
    ]
    assert state.saved[-1][1] == []


@pytest.mark.anyio
async def test_disconnect_waits_for_refresh_and_revokes_latest_credentials() -> None:
    state = DisconnectState()
    refresh_started = asyncio.Event()
    release_refresh = asyncio.Event()

    async def refresh_token(
        _refresh_token: str,
        _application: dict[str, Any],
    ) -> dict[str, Any]:
        refresh_started.set()
        await release_refresh.wait()
        return {
            "access_token": "latest-access-token",
            "refresh_token": "latest-refresh-token",
            "token_type": "Bearer",
            "scope": sorted(LINEAR_REQUIRED_SCOPES),
            "expires_in": 3600,
        }

    state.linear_token_refresh = refresh_token
    refresh = asyncio.create_task(
        state.linear_access_token(dict(state.installation), force_refresh=True)
    )
    await refresh_started.wait()
    disconnect = asyncio.create_task(state.disconnect_linear_installation("user-1"))
    await asyncio.sleep(0)

    assert disconnect.done() is False

    release_refresh.set()
    assert await refresh == "latest-access-token"
    assert await disconnect == {"state": "disconnected"}
    assert state.revocations == [
        ("latest-refresh-token", "refresh_token"),
        ("latest-access-token", "access_token"),
    ]
    assert state.installation["active"] is False
    assert state.installation["access_token"] == ""
    assert state.installation["refresh_token"] == ""


@pytest.mark.anyio
async def test_stale_reauthorization_marker_does_not_revive_disconnected_installation() -> None:
    state = DisconnectState()
    stale = dict(state.installation)

    await state.disconnect_linear_installation("user-1")
    await state.mark_linear_reauthorization_required(
        stale,
        "linear_token_rejected_after_refresh",
    )

    assert state.installation["active"] is False
    assert state.installation["state"] == "disconnected"
    assert state.installation["access_token"] == ""
    assert state.installation["refresh_token"] == ""


@pytest.mark.anyio
async def test_refresh_failure_marks_reauthorization_without_relocking() -> None:
    state = DisconnectState()

    async def fail_refresh(
        _refresh_token: str,
        _application: dict[str, Any],
    ) -> dict[str, Any]:
        raise RuntimeError("refresh failed")

    state.linear_token_refresh = fail_refresh

    with pytest.raises(LinearTokenUnavailable) as raised:
        await state.linear_access_token(dict(state.installation), force_refresh=True)

    assert raised.value.code == "linear_reauthorization_required"
    assert state.installation["state"] == "reauthorization_required"
    assert state.installation["action_required"] == "reauthorize"


@pytest.mark.anyio
async def test_missing_application_marks_reauthorization_without_relocking() -> None:
    state = DisconnectState()

    async def missing_application(_config_id: str) -> None:
        return None

    state.get_linear_application_config = missing_application  # type: ignore[method-assign]

    with anyio.fail_after(1):
        with pytest.raises(LinearTokenUnavailable) as raised:
            await state.linear_access_token(dict(state.installation), force_refresh=True)

    assert raised.value.code == "linear_reauthorization_required"
    assert state.installation["state"] == "reauthorization_required"


@pytest.mark.anyio
async def test_disconnect_route_returns_conflict_with_next_action() -> None:
    state = DisconnectState(
        bindings=[{"linear_project_id": "project-1", "active": True}]
    )
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": code, "message": message}},
            status_code=status,
        )

    register_linear_disconnect_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.delete("/api/v1/linear/installations/current")

    assert response.status_code == 409
    assert response.json() == {
        "error": {
            "code": "linear_disconnect_in_use",
            "message": "Unbind active projects before disconnecting Linear",
            "next_action": "unbind_projects",
        }
    }


@pytest.mark.anyio
async def test_disconnect_route_exposes_sanitized_revocation_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = DisconnectState(failed_hints={"refresh_token"})
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": code, "message": message}},
            status_code=status,
        )

    register_linear_disconnect_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.delete("/api/v1/linear/installations/current")

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "linear_token_revocation_failed"
    assert state.saved[-1][0]["error_code"] == "linear_token_revocation_failed"
    visible = repr((response.json(), caplog.messages))
    assert "linear_token_revocation_failed" in visible
    assert "sentinel-refresh-token" not in visible
    assert "sentinel-access-token" not in visible
