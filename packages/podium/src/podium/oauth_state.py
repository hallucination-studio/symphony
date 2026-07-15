from __future__ import annotations

import base64
import hashlib
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from threading import Lock

OAUTH_ATTEMPT_TTL_SECONDS = 300
MAX_STATE_LENGTH = 256
MAX_CODE_LENGTH = 2048


@dataclass(frozen=True)
class OAuthAttempt:
    attempt_id: str
    state: str = field(repr=False)
    verifier: str = field(repr=False)
    challenge: str
    expires_at: float


@dataclass(frozen=True)
class OAuthCodeExchange:
    attempt_id: str
    code: str = field(repr=False)
    verifier: str = field(repr=False)


class OAuthAttemptManager:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._attempts: dict[str, OAuthAttempt] = {}
        self._lock = Lock()

    def begin(self) -> OAuthAttempt:
        with self._lock:
            now = self._clock()
            self._prune_expired(now)
            while True:
                attempt = _new_attempt(now)
                if attempt.state in self._attempts or any(
                    current.attempt_id == attempt.attempt_id
                    for current in self._attempts.values()
                ):
                    continue
                self._attempts[attempt.state] = attempt
                return attempt

    def consume(self, state: str, code: str) -> OAuthCodeExchange:
        if not _bounded(state, MAX_STATE_LENGTH) or not _bounded(code, MAX_CODE_LENGTH):
            raise ValueError("oauth_attempt_invalid")
        attempt = self._take(state)
        return OAuthCodeExchange(attempt.attempt_id, code, attempt.verifier)

    def consume_denial(self, state: str) -> str:
        return self._take(state).attempt_id

    def _take(self, state: str) -> OAuthAttempt:
        if not _bounded(state, MAX_STATE_LENGTH):
            raise ValueError("oauth_attempt_invalid")
        with self._lock:
            attempt = self._attempts.pop(state, None)
        if attempt is None:
            raise ValueError("oauth_attempt_invalid")
        if self._clock() >= attempt.expires_at:
            raise ValueError("oauth_attempt_expired")
        return attempt

    def cancel(self, attempt_id: str) -> bool:
        if not _bounded(attempt_id, MAX_STATE_LENGTH):
            return False
        with self._lock:
            state = next(
                (
                    state
                    for state, attempt in self._attempts.items()
                    if attempt.attempt_id == attempt_id
                ),
                None,
            )
            if state is None:
                return False
            del self._attempts[state]
            return True

    @property
    def active_count(self) -> int:
        with self._lock:
            self._prune_expired(self._clock())
            return len(self._attempts)

    def _prune_expired(self, now: float) -> None:
        expired = [
            state
            for state, attempt in self._attempts.items()
            if now >= attempt.expires_at
        ]
        for state in expired:
            del self._attempts[state]


def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _new_attempt(now: float) -> OAuthAttempt:
    verifier, challenge = generate_pkce()
    return OAuthAttempt(
        attempt_id=secrets.token_urlsafe(32),
        state=secrets.token_urlsafe(32),
        verifier=verifier,
        challenge=challenge,
        expires_at=now + OAUTH_ATTEMPT_TTL_SECONDS,
    )


def _bounded(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum
