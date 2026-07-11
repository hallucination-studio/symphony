from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.podium_state import SecretDecryptionError


RUNTIME = {
    "id": "runtime-1",
    "runtime_group_id": "group-1",
    "user_id": "user-1",
    "disabled": False,
    "revoked": False,
}
BINDING = {
    "id": "binding-1",
    "conductor_id": "runtime-1",
    "user_id": "user-1",
    "linear_project_id": "project-1",
    "state": "ready",
    "active": True,
    "installation_id": "installation-1",
}
INSTALLATION = {
    "id": "installation-1",
    "user_id": "user-1",
    "actor": "app",
    "access_token": "linear-access-token",
}


def _app(store: object, **overrides: object) -> object:
    return create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
        **overrides,
    )


def _proxy_store(*, group_binding_id: str = "binding-1") -> object:
    return SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[BINDING]),
        get_runtime_group=AsyncMock(
            return_value={
                "id": "group-1",
                "project_binding_id": group_binding_id,
                "linear_workspace_id": "user-1",
            }
        ),
        list_selected_linear_projects=AsyncMock(
            return_value=[{"linear_project_id": "project-1"}]
        ),
    )


@pytest.mark.asyncio
async def test_runtime_auth_rechecks_persisted_disabled_state() -> None:
    store = SimpleNamespace(
        get_runtime_by_token_hash=AsyncMock(return_value={**RUNTIME, "disabled": True})
    )
    app = _app(store)

    runtime = await app.state.podium.runtime_for_bearer("Bearer runtime-token")

    assert runtime is None
    store.get_runtime_by_token_hash.assert_awaited_once()


def test_runtime_ws_rejects_invalid_fencing_token_without_closing_loop() -> None:
    store = SimpleNamespace(
        next_runtime_command=AsyncMock(return_value=None),
        list_active_workspace_installations=AsyncMock(return_value=[]),
        reap_expired_dispatch_leases=AsyncMock(return_value=0),
    )
    app = _app(store)
    app.state.podium.runtime_for_bearer = AsyncMock(return_value=RUNTIME)
    app.state.podium.attach_runtime_ws = AsyncMock(return_value=0)
    app.state.podium.set_presence = AsyncMock()
    app.state.podium.detach_runtime_ws = AsyncMock()

    with TestClient(app) as client:
        with client.websocket_connect(
            "/api/v1/runtime/ws",
            headers={"Authorization": "Bearer runtime-token"},
        ) as websocket:
            websocket.send_json(
                {
                    "type": "dispatch.ack",
                    "dispatch_id": "dispatch-1",
                    "fencing_token": "not-int",
                }
            )
            invalid = websocket.receive_json()
            websocket.send_json({"type": "heartbeat"})
            heartbeat = websocket.receive_json()

    assert invalid["type"] == "error"
    assert invalid["code"] == "invalid_fencing_token"
    assert heartbeat == {"type": "ping"}
    app.state.podium.set_presence.assert_awaited_once_with("runtime-1")


@pytest.mark.asyncio
async def test_linear_proxy_requires_proxy_token_and_audits_allowed_request() -> None:
    seen_authorization: list[str] = []

    async def transport(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers["Authorization"])
        return httpx.Response(
            200,
            json={"data": {"viewer": {"id": "viewer-1"}}},
            request=request,
        )

    app = _app(_proxy_store(), linear_graphql_transport=transport)
    app.state.podium.runtime_for_proxy_bearer = AsyncMock(
        side_effect=[None, RUNTIME]
    )
    app.state.podium.get_active_linear_installation = AsyncMock(
        return_value=INSTALLATION
    )
    app.state.podium.linear_access_token = AsyncMock(
        return_value="linear-access-token"
    )
    app.state.podium.record_proxy_audit = AsyncMock()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        unauthorized = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
        )
        allowed = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer proxy-token"},
        )

    assert unauthorized.status_code == 401
    assert allowed.status_code == 200
    assert allowed.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert seen_authorization == ["Bearer linear-access-token"]
    audit_events = [call.args[0] for call in app.state.podium.record_proxy_audit.await_args_list]
    assert audit_events[0]["reason"] == "unauthorized"
    assert audit_events[1]["allowed"] is True
    assert audit_events[1]["project_binding_id"] == "binding-1"
    assert "linear-access-token" not in str(audit_events)


@pytest.mark.asyncio
async def test_linear_proxy_rejects_runtime_group_binding_mismatch() -> None:
    forwarded = False

    async def transport(request: httpx.Request) -> httpx.Response:
        nonlocal forwarded
        forwarded = True
        return httpx.Response(200, json={"data": {}}, request=request)

    app = _app(
        _proxy_store(group_binding_id="binding-other"),
        linear_graphql_transport=transport,
    )
    app.state.podium.runtime_for_proxy_bearer = AsyncMock(return_value=RUNTIME)
    app.state.podium.record_proxy_audit = AsyncMock()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        response = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer proxy-token"},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "runtime_project_binding_mismatch"
    assert forwarded is False


@pytest.mark.asyncio
async def test_linear_proxy_surfaces_secret_decryption_failure_and_audits_reason() -> None:
    app = _app(_proxy_store())
    app.state.podium.runtime_for_proxy_bearer = AsyncMock(return_value=RUNTIME)
    app.state.podium.get_active_linear_installation = AsyncMock(
        side_effect=SecretDecryptionError("secret_decryption_failed")
    )
    app.state.podium.record_proxy_audit = AsyncMock()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        response = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer proxy-token"},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "secret_decryption_failed"
    audit = app.state.podium.record_proxy_audit.await_args.args[0]
    assert audit["reason"] == "secret_decryption_failed"


@pytest.mark.asyncio
async def test_linear_proxy_never_falls_back_to_environment_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forwarded = False

    async def transport(request: httpx.Request) -> httpx.Response:
        nonlocal forwarded
        forwarded = True
        return httpx.Response(200, json={"data": {}}, request=request)

    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "app-linear-token")
    monkeypatch.setenv("PODIUM_LINEAR_ACCESS_TOKEN", "operator-linear-token")
    store = SimpleNamespace(
        list_project_bindings_for_conductor=AsyncMock(return_value=[])
    )
    app = _app(store, linear_graphql_transport=transport)
    app.state.podium.runtime_for_proxy_bearer = AsyncMock(return_value=RUNTIME)
    app.state.podium.record_proxy_audit = AsyncMock()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        response = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "query Viewer { viewer { id } }"},
            headers={"Authorization": "Bearer proxy-token"},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "linear_project_binding_required"
    assert forwarded is False
