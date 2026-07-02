from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest

from podium.linear_service import LinearService
from podium.models import ConnectionState


def _signature(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_oauth_callback_stores_tokens_without_echoing() -> None:
    service = LinearService(
        token_exchange=lambda code: {
            "access_token": f"access-{code}",
            "refresh_token": "refresh-secret",
            "expires_in": 3600,
            "scope": "read,write",
            "app_user_id": "app-1",
            "workspace_id": "ws-1",
        }
    )
    status, payload = service.handle_oauth_callback({"code": "abc", "state": "ws-1"})
    assert status == 200
    assert payload["installation"]["workspace_id"] == "ws-1"
    assert "access-abc" not in json.dumps(payload)
    assert "refresh-secret" not in json.dumps(payload)
    # But stored internally
    assert service.get_installation("ws-1")["access_token"] == "access-abc"


def test_oauth_callback_missing_code_returns_400() -> None:
    service = LinearService()
    status, payload = service.handle_oauth_callback({"state": "ws-1"})
    assert status == 400
    assert payload["error"]["code"] == "missing_code"


def test_valid_signature_accepts_correct_hmac() -> None:
    service = LinearService(webhook_secret="secret")
    body = b'{"type":"AgentSessionEvent"}'
    headers = {"linear-signature": _signature(body, "secret")}
    assert service.valid_signature(body, headers) is True


def test_valid_signature_rejects_bad_hmac() -> None:
    service = LinearService(webhook_secret="secret")
    assert service.valid_signature(b"body", {"linear-signature": "bad"}) is False


@pytest.mark.asyncio
async def test_forward_graphql_injects_token_and_never_leaks_it() -> None:
    captured: dict[str, str] = {}

    async def transport(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"data": {"viewer": {"id": "me"}}}, request=request)

    service = LinearService(graphql_transport=transport)
    result = await service.forward_graphql({"query": "{ viewer { id } }"}, "linear-token")
    assert captured["auth"] == "Bearer linear-token"
    assert "linear-token" not in json.dumps(result)


def test_connection_status_is_ui_safe() -> None:
    service = LinearService(
        installations={"ws-1": {"workspace_id": "ws-1", "access_token": "secret", "scope": "read"}}
    )
    status = service.connection_status("ws-1")
    assert status is not None
    assert status.state == ConnectionState.CONNECTED
    assert "secret" not in json.dumps(status.to_dict())


def test_connection_status_none_when_not_connected() -> None:
    service = LinearService()
    assert service.connection_status("ws-unknown") is None


def test_build_authorization_url_includes_state_and_client() -> None:
    service = LinearService(client_id="client-1", redirect_uri="https://p.example/cb")
    url = service.build_authorization_url(state="ws-1")
    assert url.startswith("https://linear.app/oauth/authorize?")
    assert "state=ws-1" in url
    assert "client_id=client-1" in url
