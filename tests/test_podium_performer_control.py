from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
import httpx
import pytest

from podium.live_conductor_relay import LiveConductorRelay, LiveRelayError
from podium.podium_routes_performer_control import register_performer_control_routes


OPERATIONS = (
    "performer.status",
    "performer.login",
    "performer.session.delete",
    "performer.config.read",
    "performer.config.write",
    "performer.check",
)


def _payload(operation: str) -> dict[str, Any]:
    return {
        "performer.login": {"method": "device_code"},
        "performer.session.delete": {"action": "cancel_login"},
        "performer.config.write": {
            "setting": "api_base_url",
            "value": "https://api.example.test/v1",
        },
    }.get(operation, {})


def _readiness(status: str = "unchecked", check: str = "none") -> dict[str, Any]:
    return {
        "performer_kind": "codex",
        "binding_generation": 1,
        "capability_version": 1,
        "execution_policy_sha256": "a" * 64,
        "status": status,
        "last_check_status": check,
        "error": None,
    }


def _result(request_id: str, operation: str) -> dict[str, Any]:
    result = {
        "protocol_version": 1,
        "request_id": request_id,
        "operation": operation,
        "status": "succeeded",
        "capabilities": None,
        "readiness": None,
        "account": None,
        "login": None,
        "configuration": None,
        "check": None,
        "error": None,
    }
    if operation == "performer.status":
        result.update(
            capabilities={
                "protocol_version": 1,
                "capability_version": 1,
                "performer_kind": "codex",
                "display_name": "Codex",
                "turn_kinds": ["plan", "execute", "gate"],
                "login_methods": ["device_code", "api_key"],
                "supports_session_delete": True,
                "editable_settings": ["api_base_url"],
                "config_source_visible": True,
                "check_supported": True,
            },
            readiness=_readiness(),
            account={"status": "unknown", "display_label": None},
            login={"status": "idle", "method": None},
        )
    elif operation == "performer.login":
        result.update(
            readiness=_readiness(),
            login={"status": "pending", "method": "device_code"},
        )
    elif operation == "performer.session.delete":
        result.update(
            readiness=_readiness(),
            account={"status": "logged_out", "display_label": None},
            login={"status": "idle", "method": None},
        )
    elif operation == "performer.config.read":
        result["configuration"] = {
            "settings": {"api_base_url": "https://api.example.test/v1"},
            "source_format": None,
            "source_text": None,
        }
    elif operation == "performer.config.write":
        result.update(
            readiness=_readiness(),
            configuration={
                "settings": {"api_base_url": "https://api.example.test/v1"},
                "source_format": None,
                "source_text": None,
            },
        )
    else:
        result.update(
            readiness=_readiness("ready", "passed"),
            check={
                "status": "passed",
                "started_at": "2026-07-13T00:00:00Z",
                "finished_at": "2026-07-13T00:00:01Z",
                "summary": "ready",
            },
        )
    return result


@pytest.mark.anyio
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_relay_supports_only_closed_generic_operations(operation: str) -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", operation, _payload(operation)))
    await asyncio.sleep(0)

    leased = await relay.lease("conductor-1")
    assert leased is not None
    assert leased["operation"] == operation
    assert await relay.lease("conductor-1") is None
    accepted = await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        _result(leased["request_id"], operation),
    )

    assert accepted is True
    response = await waiter
    assert response["control_result"]["operation"] == operation
    assert response["events"] == []
    assert not await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        _result(leased["request_id"], operation),
    )


@pytest.mark.anyio
async def test_relay_request_ids_always_satisfy_the_closed_identifier_contract(monkeypatch) -> None:
    import podium.live_conductor_relay as relay_module

    monkeypatch.setattr(relay_module.secrets, "token_urlsafe", lambda _size: "-leading-punctuation")
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer.status", {}))
    await asyncio.sleep(0)

    leased = await relay.lease("conductor-1")
    assert leased is not None
    assert leased["request_id"].startswith("live_")
    assert await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        _result(leased["request_id"], "performer.status"),
    )
    assert (await waiter)["control_result"]["request_id"] == leased["request_id"]


@pytest.mark.anyio
async def test_relay_preserves_device_challenge_as_closed_transient_event() -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(
        relay.request("conductor-1", "performer.login", {"method": "device_code"})
    )
    await asyncio.sleep(0)
    leased = await relay.lease("conductor-1")
    assert leased is not None
    event = {
        "protocol_version": 1,
        "request_id": leased["request_id"],
        "operation": "performer.login",
        "sequence": 1,
        "event_kind": "login.pending",
        "message": "Open the verification URL",
        "verification_url": "https://example.test/device",
        "user_code": "ABCD-EFGH",
        "expires_at": None,
    }

    assert await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        _result(leased["request_id"], "performer.login"),
        events=[event],
    )
    response = await waiter

    assert response["events"] == [event]


@pytest.mark.anyio
async def test_relay_rejects_unknown_requests_and_rate_limits_check() -> None:
    relay = LiveConductorRelay()
    with pytest.raises(LiveRelayError) as unsupported:
        await relay.request("conductor-1", "performer.codex.status", {})
    assert unsupported.value.code == "performer_live_operation_unsupported"
    with pytest.raises(LiveRelayError) as unknown:
        await relay.request("conductor-1", "performer.status", {"path": "/tmp/provider"})
    assert unknown.value.code == "performer_live_request_invalid"

    waiter = asyncio.create_task(relay.request("conductor-1", "performer.check", {}))
    await asyncio.sleep(0)
    with pytest.raises(LiveRelayError, match="in_progress"):
        await relay.request("conductor-1", "performer.check", {})
    leased = await relay.lease("conductor-1")
    assert leased is not None
    await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        _result(leased["request_id"], "performer.check"),
    )
    await waiter
    with pytest.raises(LiveRelayError, match="rate_limited"):
        await relay.request("conductor-1", "performer.check", {})


@pytest.mark.anyio
async def test_relay_deadline_purge_surfaces_a_closed_timeout_instead_of_cancellation() -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer.check", {}))
    await asyncio.sleep(0)
    async with relay._lock:
        request = next(iter(relay._requests.values()))
        request.deadline = time.monotonic() - 1

    assert await relay.lease("conductor-1") is None
    with pytest.raises(LiveRelayError) as expired:
        await waiter
    assert expired.value.code == "performer_live_check_timeout"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: {**value, "raw_sdk": {"secret": "value"}},
        lambda value: {**value, "thread_id": "provider-thread"},
        lambda value: {**value, "configuration": {"settings": {}, "source_format": "text", "source_text": "/private/provider/config.toml"}},
    ],
)
async def test_relay_rejects_unknown_raw_and_path_result_fields(mutation) -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer.status", {}))
    await asyncio.sleep(0)
    leased = await relay.lease("conductor-1")
    assert leased is not None

    with pytest.raises(LiveRelayError) as invalid:
        await relay.reply(
            "conductor-1",
            leased["request_id"],
            leased["lease_token"],
            mutation(_result(leased["request_id"], "performer.status")),
        )
    assert invalid.value.code == "performer_live_result_invalid"
    with pytest.raises(LiveRelayError) as owner_error:
        await asyncio.wait_for(waiter, timeout=0.1)
    assert owner_error.value.code == "performer_live_result_invalid"
    assert relay.pending_count == 0


class _RouteState:
    def __init__(self, *, online: bool = True) -> None:
        self.live_relay = LiveConductorRelay()
        self.online = online

    async def conductor_belongs_to_user(self, conductor_id: str, user_id: str) -> bool:
        return conductor_id == "conductor-1" and user_id == "user-1"

    async def is_runtime_online(self, conductor_id: str) -> bool:
        return conductor_id == "conductor-1" and self.online

    async def runtime_for_bearer(self, authorization: str) -> dict[str, str] | None:
        return {"id": "conductor-1"} if authorization == "Bearer runtime-token" else None


def _route_app(state: _RouteState, *, authenticated: bool = True) -> FastAPI:
    app = FastAPI()

    async def require_user(_request):
        return {"id": "user-1"} if authenticated else None

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

    register_performer_control_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    return app


@pytest.mark.anyio
async def test_owner_performer_route_rejects_an_offline_conductor_without_waiting() -> None:
    state = _RouteState(online=False)
    transport = httpx.ASGITransport(app=_route_app(state))

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await asyncio.wait_for(
            client.get("/api/v1/conductors/conductor-1/performer"),
            timeout=0.1,
        )

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["error"]["code"] == "conductor_offline"
    assert state.live_relay.pending_count == 0


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("method", "path", "body", "operation", "relay_payload"),
    [
        ("GET", "/api/v1/conductors/conductor-1/performer", None, "performer.status", {}),
        ("POST", "/api/v1/conductors/conductor-1/performer/login", {"method": "device_code"}, "performer.login", {"method": "device_code"}),
        ("DELETE", "/api/v1/conductors/conductor-1/performer/session", {"action": "cancel_login"}, "performer.session.delete", {"action": "cancel_login"}),
        ("GET", "/api/v1/conductors/conductor-1/performer/config", None, "performer.config.read", {}),
        ("PATCH", "/api/v1/conductors/conductor-1/performer/config", {"setting": "api_base_url", "value": "https://api.example.test/v1"}, "performer.config.write", {"setting": "api_base_url", "value": "https://api.example.test/v1"}),
        ("POST", "/api/v1/conductors/conductor-1/performer/check", {}, "performer.check", {}),
    ],
)
async def test_owner_routes_map_to_generic_live_operations(
    method: str,
    path: str,
    body: dict[str, Any] | None,
    operation: str,
    relay_payload: dict[str, Any],
) -> None:
    state = _RouteState()
    transport = httpx.ASGITransport(app=_route_app(state))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        owner = asyncio.create_task(client.request(method, path, json=body))
        await asyncio.sleep(0)
        lease = await client.post(
            "/api/v1/runtime/live/lease",
            headers={"Authorization": "Bearer runtime-token"},
        )
        leased = lease.json()["request"]
        assert leased["operation"] == operation
        assert leased["payload"] == relay_payload
        reply = await client.post(
            "/api/v1/runtime/live/reply",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "request_id": leased["request_id"],
                "lease_token": leased["lease_token"],
                "result": _result(leased["request_id"], operation),
                "events": [],
            },
        )
        response = await owner

    assert reply.status_code == 200
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["control_result"]["operation"] == operation


@pytest.mark.anyio
async def test_api_key_is_transient_and_unknown_or_secret_fields_fail_closed() -> None:
    state = _RouteState()
    transport = httpx.ASGITransport(app=_route_app(state))
    sentinel = "sentinel-api-key"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        owner = asyncio.create_task(
            client.post(
                "/api/v1/conductors/conductor-1/performer/login",
                json={"method": "api_key", "api_key": sentinel},
            )
        )
        await asyncio.sleep(0)
        lease = await state.live_relay.lease("conductor-1")
        assert lease is not None and lease["payload"]["api_key"] == sentinel
        await state.live_relay.reply(
            "conductor-1",
            lease["request_id"],
            lease["lease_token"],
            {
                **_result(lease["request_id"], "performer.login"),
                "login": {"status": "succeeded", "method": "api_key"},
            },
        )
        response = await owner
        assert sentinel not in response.text
        assert state.live_relay.pending_count == 0

        invalid = await client.post(
            "/api/v1/conductors/conductor-1/performer/login",
            json={"method": "device_code", "token": "must-not-enter-relay"},
        )
        path = await client.patch(
            "/api/v1/conductors/conductor-1/performer/config",
            json={"setting": "api_base_url", "value": "file:///private/provider/config"},
        )
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "performer_control_request_invalid"
    assert path.status_code == 400


@pytest.mark.anyio
async def test_owner_and_runtime_authorization_and_stale_reply_are_preserved() -> None:
    state = _RouteState()
    unauthenticated = httpx.ASGITransport(app=_route_app(state, authenticated=False))
    async with httpx.AsyncClient(transport=unauthenticated, base_url="http://test") as client:
        response = await client.get("/api/v1/conductors/conductor-1/performer")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"

    transport = httpx.ASGITransport(app=_route_app(state))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        runtime = await client.post("/api/v1/runtime/live/lease")
        stale = await client.post(
            "/api/v1/runtime/live/reply",
            headers={"Authorization": "Bearer runtime-token"},
            json={"request_id": "missing", "lease_token": "stale", "result": {}},
        )
    assert runtime.status_code == 401
    assert stale.status_code == 409


def test_app_registers_provider_neutral_routes_only() -> None:
    source = (__import__("pathlib").Path(__file__).parents[1] / "packages/podium/src/podium/app.py").read_text()
    assert "podium_routes_performer_control" in source
    assert "podium_routes_live_credentials" not in source
    assert "register_live_credential_routes" not in source
