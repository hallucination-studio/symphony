from __future__ import annotations

import base64
import hashlib
from concurrent.futures import ThreadPoolExecutor

import pytest

from podium.oauth_state import OAUTH_ATTEMPT_TTL_SECONDS, OAuthAttemptManager


class Clock:
    def __init__(self, value: float = 100.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


def test_attempt_has_high_entropy_s256_material_and_fixed_ttl() -> None:
    clock = Clock()
    manager = OAuthAttemptManager(clock=clock)

    attempt = manager.begin()

    assert len(attempt.attempt_id) >= 32
    assert len(attempt.state) >= 43
    assert 43 <= len(attempt.verifier) <= 128
    assert attempt.challenge == base64.urlsafe_b64encode(
        hashlib.sha256(attempt.verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    assert attempt.expires_at == 100.0 + OAUTH_ATTEMPT_TTL_SECONDS


def test_attempt_consumes_code_once_without_retaining_it() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    attempt = manager.begin()

    exchange = manager.consume(attempt.state, "authorization-code-sentinel")

    assert exchange.attempt_id == attempt.attempt_id
    assert exchange.verifier == attempt.verifier
    assert exchange.code == "authorization-code-sentinel"
    with pytest.raises(ValueError, match="^oauth_attempt_invalid$"):
        manager.consume(attempt.state, "replay-code")
    assert manager.active_count == 0


def test_expired_and_cancelled_attempts_cannot_be_consumed() -> None:
    clock = Clock()
    manager = OAuthAttemptManager(clock=clock)
    expired = manager.begin()
    clock.value = expired.expires_at

    with pytest.raises(ValueError, match="^oauth_attempt_expired$"):
        manager.consume(expired.state, "code")

    current = manager.begin()
    assert manager.cancel(current.attempt_id) is True
    assert manager.cancel(current.attempt_id) is False
    with pytest.raises(ValueError, match="^oauth_attempt_invalid$"):
        manager.consume(current.state, "code")


def test_abandoned_expired_attempts_are_lazily_removed() -> None:
    clock = Clock()
    manager = OAuthAttemptManager(clock=clock)
    first = manager.begin()
    clock.value = first.expires_at

    assert manager.active_count == 0
    for _ in range(10):
        attempt = manager.begin()
        clock.value = attempt.expires_at

    assert manager.active_count == 0


def test_concurrent_callbacks_have_exactly_one_winner() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    attempt = manager.begin()

    def consume(index: int) -> str:
        try:
            manager.consume(attempt.state, f"code-{index}")
            return "consumed"
        except ValueError as error:
            return str(error)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(consume, range(16)))

    assert results.count("consumed") == 1
    assert results.count("oauth_attempt_invalid") == 15


def test_sensitive_attempt_material_is_not_in_default_representations() -> None:
    manager = OAuthAttemptManager(clock=Clock())
    attempt = manager.begin()
    exchange = manager.consume(attempt.state, "authorization-code-sentinel")

    assert attempt.state not in repr(attempt)
    assert attempt.verifier not in repr(attempt)
    assert "authorization-code-sentinel" not in repr(exchange)
    assert attempt.verifier not in repr(exchange)


@pytest.mark.parametrize(
    ("state", "code"),
    [("", "code"), ("unknown-state", "code"), ("state", ""), ("state", "x" * 2049)],
)
def test_invalid_callback_material_fails_closed(state: str, code: str) -> None:
    manager = OAuthAttemptManager(clock=Clock())
    if state == "state":
        state = manager.begin().state

    with pytest.raises(ValueError, match="^oauth_attempt_invalid$"):
        manager.consume(state, code)
