from __future__ import annotations

import base64
import hashlib
import socket
import threading
import time

import pytest
import httpx

from podium.linear_manifest import LINEAR_OAUTH_REDIRECT_URI
from podium.linear_oauth import authorization_url, exchange_public_code, new_pkce, revoke_probe_tokens
from podium.oauth_callback import CALLBACK_HEADERS, OAuthCallbackListener
from podium.oauth_state import OAuthAttemptManager


def test_fixed_callback_and_s256_pkce(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client")
    verifier, challenge = new_pkce()
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    assert challenge == expected
    assert LINEAR_OAUTH_REDIRECT_URI == "http://127.0.0.1:43821/oauth/linear/callback"
    url = authorization_url("opaque", challenge)
    assert "client_id=public-client" in url
    assert "client_secret" not in url
    assert "code_challenge_method=S256" in url
    assert "actor=app" in url
    assert "prompt=consent" in url


def test_state_is_ttl_bounded_and_single_use() -> None:
    clock = _Clock(9)
    manager = OAuthAttemptManager(clock=clock)
    attempt = manager.begin()
    manager.consume(attempt.state, "code")
    with pytest.raises(ValueError, match="invalid"):
        manager.consume(attempt.state, "code")

    expired = manager.begin()
    clock.value = expired.expires_at
    with pytest.raises(ValueError, match="expired"):
        manager.consume(expired.state, "code")


def test_callback_security_headers_are_closed() -> None:
    assert CALLBACK_HEADERS == {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }


def callback(target: str) -> tuple[object, bytes]:
    manager = OAuthAttemptManager()
    attempt = manager.begin()
    listener = OAuthCallbackListener(manager)
    outcome: list[object] = []
    thread = threading.Thread(target=lambda: _receive(listener, outcome))
    thread.start()
    with socket.create_connection(("127.0.0.1", 43821)) as client:
        target = target.replace("opaque", attempt.state)
        client.sendall(
            f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1:43821\r\n\r\n".encode()
        )
        response = client.recv(4096)
    thread.join(2)
    return outcome[0], response


def _receive(listener: OAuthCallbackListener, outcome: list[object]) -> None:
    try:
        outcome.append(listener.receive(1))
    except BaseException as exc:
        outcome.append(exc)


def test_success_and_denied_close_listener() -> None:
    result, response = callback("/oauth/linear/callback?code=one-time&state=opaque")
    assert result.code == "one-time"
    assert b"Cache-Control: no-store" in response
    denied, response = callback("/oauth/linear/callback?error=access_denied&state=opaque")
    assert isinstance(denied, ValueError) and "denied" in str(denied)
    assert b"Authorization was not completed" in response
    assert b"access_denied" not in response


def test_timeout_and_port_conflict_fail_without_fallback() -> None:
    manager = OAuthAttemptManager()
    manager.begin()
    listener = OAuthCallbackListener(manager)
    with pytest.raises(OSError):
        OAuthCallbackListener(manager)
    with pytest.raises(TimeoutError):
        listener.receive(0.01)
    reopened = OAuthCallbackListener(manager)
    reopened.close()


def test_connected_client_cannot_hold_listener_past_timeout() -> None:
    manager = OAuthAttemptManager()
    manager.begin()
    listener = OAuthCallbackListener(manager)
    outcome: list[object] = []
    thread = threading.Thread(target=lambda: _receive(listener, outcome))
    thread.start()
    with socket.create_connection(("127.0.0.1", 43821)) as client:
        client.sendall(b"GET /oauth/linear/callback?code=x")
        thread.join(2)
    assert isinstance(outcome[0], TimeoutError)
    reopened = OAuthCallbackListener(manager)
    reopened.close()


def test_expired_and_replayed_callbacks_fail_closed() -> None:
    clock = _Clock(100)
    manager = OAuthAttemptManager(clock=clock)
    attempt = manager.begin()
    clock.value = attempt.expires_at
    expired = OAuthCallbackListener(manager)
    outcome: list[object] = []
    thread = threading.Thread(target=lambda: _receive(expired, outcome))
    thread.start()
    with socket.create_connection(("127.0.0.1", 43821)) as client:
        client.sendall(
            f"GET /oauth/linear/callback?code=x&state={attempt.state} HTTP/1.1\r\n"
            "Host: 127.0.0.1:43821\r\n\r\n".encode()
        )
    thread.join(2)
    assert isinstance(outcome[0], ValueError) and "expired" in str(outcome[0])

    replay_manager = OAuthAttemptManager()
    replay_attempt = replay_manager.begin()
    replay_manager.consume(replay_attempt.state, "first")
    replay = OAuthCallbackListener(replay_manager)
    outcome = []
    thread = threading.Thread(target=lambda: _receive(replay, outcome))
    thread.start()
    with socket.create_connection(("127.0.0.1", 43821)) as client:
        client.sendall(
            f"GET /oauth/linear/callback?code=x&state={replay_attempt.state} HTTP/1.1\r\n"
            "Host: 127.0.0.1:43821\r\n\r\n".encode()
        )
    thread.join(2)
    assert isinstance(outcome[0], ValueError) and "invalid" in str(outcome[0])


class _Clock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


@pytest.mark.asyncio
async def test_public_exchange_omits_secret_and_revocation_clears_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "access-sentinel", "refresh_token": "refresh-sentinel"})
        return httpx.Response(204)

    transport = httpx.MockTransport(handler)
    token = await exchange_public_code("one-time", "verifier", transport=transport)
    assert b"client_id=public-client" in requests[0].content
    assert b"client_secret" not in requests[0].content
    await revoke_probe_tokens(token, transport=transport)
    assert "access_token" not in token and "refresh_token" not in token
    assert len(requests) == 3


def test_missing_client_id_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LINEAR_CLIENT_ID", raising=False)
    with pytest.raises(ValueError, match="linear_client_id_missing"):
        authorization_url("opaque", "challenge")
