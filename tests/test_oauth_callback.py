from __future__ import annotations

import socket
import threading

import pytest

from podium.oauth_callback import OAuthCallbackListener
from podium.oauth_state import OAuthAttemptManager


class Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


def exchange_request(target: str, *, host: str = "127.0.0.1:43821"):
    manager = OAuthAttemptManager(clock=Clock())
    attempt = manager.begin()
    listener = OAuthCallbackListener(manager)
    outcome: list[object] = []
    thread = threading.Thread(target=_receive, args=(listener, outcome))
    thread.start()
    with socket.create_connection(("127.0.0.1", 43821)) as client:
        client.sendall(
            f"GET {target.format(state=attempt.state)} HTTP/1.1\r\n"
            f"Host: {host}\r\nConnection: close\r\n\r\n".encode("ascii")
        )
        response = _read_response(client)
    thread.join(2)
    assert not thread.is_alive()
    return attempt, manager, outcome[0], response


def _receive(listener: OAuthCallbackListener, outcome: list[object]) -> None:
    try:
        outcome.append(listener.receive(1))
    except BaseException as error:
        outcome.append(error)


def _read_response(client: socket.socket) -> bytes:
    response = bytearray()
    while chunk := client.recv(4096):
        response.extend(chunk)
    return bytes(response)


def test_exact_callback_returns_single_exchange_and_secure_local_page() -> None:
    attempt, manager, result, response = exchange_request(
        "/oauth/linear/callback?code=one-time&state={state}"
    )

    assert result.attempt_id == attempt.attempt_id
    assert result.code == "one-time"
    assert result.verifier == attempt.verifier
    assert manager.active_count == 0
    assert b"Authorization complete" in response
    for header in (
        b"Cache-Control: no-store",
        b"Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
        b"X-Content-Type-Options: nosniff",
        b"Referrer-Policy: no-referrer",
    ):
        assert header in response
    assert b"http://" not in response and b"https://" not in response


def test_denial_consumes_attempt_without_exposing_linear_detail() -> None:
    _attempt, manager, result, response = exchange_request(
        "/oauth/linear/callback?error=access_denied&state={state}"
    )

    assert isinstance(result, ValueError)
    assert str(result) == "oauth_callback_denied"
    assert manager.active_count == 0
    assert b"Authorization was not completed" in response
    assert b"access_denied" not in response


@pytest.mark.parametrize(
    ("target", "host"),
    [
        ("/wrong?code=x&state={state}", "127.0.0.1:43821"),
        ("/oauth/linear/callback?code=x&state={state}&extra=y", "127.0.0.1:43821"),
        ("/oauth/linear/callback?code=x&code=y&state={state}", "127.0.0.1:43821"),
        ("/oauth/linear/callback?code=x&state={state}", "localhost:43821"),
    ],
)
def test_wrong_path_query_or_host_is_invalid_and_closes(
    target: str, host: str
) -> None:
    _attempt, manager, result, response = exchange_request(target, host=host)

    assert isinstance(result, ValueError)
    assert str(result) == "oauth_callback_request_invalid"
    assert manager.active_count == 1
    assert b"Authorization failed" in response
    reopened = OAuthCallbackListener(manager)
    reopened.close()


def test_timeout_and_port_conflict_are_bounded_and_sanitized() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    manager.begin()
    listener = OAuthCallbackListener(manager)
    with pytest.raises(OSError, match="^oauth_callback_port_unavailable$"):
        OAuthCallbackListener(manager)
    with pytest.raises(TimeoutError, match="^oauth_callback_timeout$"):
        listener.receive(0.01)
    reopened = OAuthCallbackListener(manager)
    reopened.close()


def test_browser_open_without_exact_callback_never_succeeds() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    manager.begin()
    listener = OAuthCallbackListener(manager)

    with pytest.raises(TimeoutError, match="^oauth_callback_timeout$"):
        listener.receive(0.01)

    assert manager.active_count == 1


@pytest.mark.parametrize("timeout", [None, "1", True, 0, 241, float("inf"), float("nan")])
def test_invalid_timeout_closes_listener_and_uses_one_error(timeout: object) -> None:
    manager = OAuthAttemptManager(clock=Clock())
    manager.begin()
    listener = OAuthCallbackListener(manager)

    with pytest.raises(ValueError, match="^oauth_callback_timeout_invalid$"):
        listener.receive(timeout)  # type: ignore[arg-type]

    reopened = OAuthCallbackListener(manager)
    reopened.close()


def test_maximum_callback_timeout_is_an_accepted_boundary() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    manager.begin()
    listener = OAuthCallbackListener(manager)

    class TimedOutSocket:
        def settimeout(self, _timeout: float) -> None:
            pass

        def accept(self):
            raise socket.timeout

        def close(self) -> None:
            pass

    listener.socket.close()
    listener.socket = TimedOutSocket()  # type: ignore[assignment]
    with pytest.raises(TimeoutError, match="^oauth_callback_timeout$"):
        listener.receive(240)
