from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import pytest
import httpx

from podium.linear_models import InstallationMetadata, InstallationStatus
from podium.linear_tokens import LinearTokenFailure, LinearTokenLifecycle
from podium.linear_oauth import refresh_public_token
from podium.oauth_state import OAuthCodeExchange
from podium.store.linear import LinearCredentials, LinearRepository
from podium.store.sqlite import SQLiteStore


def repository(path: Path) -> tuple[SQLiteStore, LinearRepository]:
    store = SQLiteStore(path)
    store.initialize()
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Symphony",
            "app-user-1",
            ("read", "write", "app:assignable"),
            None,
            InstallationStatus.DISCONNECTED,
            100,
            None,
        )
    )
    return store, linear


def token_payload(
    access: str = "access-new",
    refresh: str = "refresh-new",
    *,
    scopes: str = "read,write,app:assignable",
    actor: str = "app",
) -> dict[str, object]:
    return {
        "access_token": access,
        "refresh_token": refresh,
        "expires_in": 3600,
        "scope": scopes,
        "actor": actor,
        "token_type": "Bearer",
    }


async def verified(_access_token: str) -> dict[str, object]:
    return {
        "viewer": {"id": "app-user-1", "app": True},
        "organization": {"id": "organization-1"},
    }


@pytest.mark.asyncio
async def test_exchange_validates_identity_before_atomic_commit(tmp_path: Path) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    requests: list[OAuthCodeExchange] = []

    async def exchange(value: OAuthCodeExchange) -> dict[str, object]:
        requests.append(value)
        return token_payload()

    lifecycle = LinearTokenLifecycle(
        linear, exchange=exchange, refresh=lambda _token: None, verify=verified, now=lambda: 1000
    )
    code = OAuthCodeExchange("attempt-1", "one-time-code", "pkce-verifier")

    access = await lifecycle.exchange("installation-1", code)

    assert access == "access-new"
    assert requests == [code]
    assert linear.load_credentials("installation-1") == LinearCredentials(
        "access-new", "refresh-new", 4600
    )


@pytest.mark.asyncio
async def test_startup_reuses_valid_stored_credentials_without_authorization(
    tmp_path: Path,
) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.replace_credentials(
        "installation-1", "access-stored", "refresh-stored", expires_at=5000
    )
    store.close()
    reopened = SQLiteStore(tmp_path / "podium.db")
    reopened.initialize()
    linear = LinearRepository(reopened.connection)
    exchanges = 0
    refreshes = 0

    async def exchange(_code):
        nonlocal exchanges
        exchanges += 1

    async def refresh(_token):
        nonlocal refreshes
        refreshes += 1

    lifecycle = LinearTokenLifecycle(
        linear, exchange=exchange, refresh=refresh, verify=verified, now=lambda: 1000
    )

    assert await lifecycle.startup("installation-1") == "access-stored"
    assert exchanges == 0
    assert refreshes == 0


@pytest.mark.asyncio
async def test_startup_verification_outage_preserves_credentials_and_logs_safely(
    tmp_path: Path, caplog
) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    original = LinearCredentials(
        "access-token-sentinel", "refresh-token-sentinel", 5000
    )
    linear.replace_credentials(
        "installation-1",
        original.access_token,
        original.refresh_token,
        expires_at=original.expires_at,
    )

    async def unavailable(_token: str):
        raise OSError("temporary viewer outage")

    lifecycle = LinearTokenLifecycle(
        linear,
        exchange=lambda _code: None,
        refresh=lambda _token: None,
        verify=unavailable,
        now=lambda: 1000,
    )

    with pytest.raises(
        LinearTokenFailure, match="^linear_identity_verification_failed$"
    ):
        await lifecycle.startup("installation-1")

    assert linear.load_credentials("installation-1") == original
    record = linear.installation("installation-1")
    assert record.status is InstallationStatus.CONNECTED
    assert record.error_code is None
    assert "event=linear_identity_verification_failed" in caplog.text
    assert "access-token-sentinel" not in caplog.text
    assert "refresh-token-sentinel" not in caplog.text


@pytest.mark.asyncio
async def test_refresh_is_single_flight_and_rotates_pair_before_return(
    tmp_path: Path,
) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    linear.replace_credentials(
        "installation-1", "access-old", "refresh-old", expires_at=1000
    )
    calls = 0
    release = asyncio.Event()

    async def refresh(value: str) -> dict[str, object]:
        nonlocal calls
        calls += 1
        assert value == "refresh-old"
        await release.wait()
        return token_payload("access-rotated", "refresh-rotated")

    lifecycle = LinearTokenLifecycle(
        linear, exchange=lambda _code: None, refresh=refresh, verify=verified, now=lambda: 1000
    )
    first = asyncio.create_task(lifecycle.refresh("installation-1"))
    second = asyncio.create_task(lifecycle.refresh("installation-1"))
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, second) == ["access-rotated", "access-rotated"]
    assert calls == 1
    assert linear.load_credentials("installation-1") == LinearCredentials(
        "access-rotated", "refresh-rotated", 4600
    )


@pytest.mark.asyncio
async def test_refresh_is_single_flight_when_refresh_token_is_unchanged(
    tmp_path: Path,
) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    linear.replace_credentials(
        "installation-1", "access-old", "refresh-shared", expires_at=1000
    )
    calls = 0
    release = asyncio.Event()

    async def refresh(_value: str) -> dict[str, object]:
        nonlocal calls
        calls += 1
        await release.wait()
        return token_payload("access-rotated", "refresh-shared")

    lifecycle = LinearTokenLifecycle(
        linear, exchange=lambda _code: None, refresh=refresh, verify=verified, now=lambda: 1000
    )
    first = asyncio.create_task(lifecycle.refresh("installation-1"))
    second = asyncio.create_task(lifecycle.refresh("installation-1"))
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, second) == ["access-rotated", "access-rotated"]
    assert calls == 1


@pytest.mark.asyncio
async def test_refresh_rotation_write_failure_preserves_old_pair(tmp_path: Path) -> None:
    store, linear = repository(tmp_path / "podium.db")
    linear.replace_credentials(
        "installation-1", "access-old", "refresh-old", expires_at=1000
    )
    store.connection.execute(
        """CREATE TRIGGER reject_rotation BEFORE UPDATE OF refresh_token
        ON linear_installations BEGIN SELECT RAISE(ABORT, 'rotation rejected'); END"""
    )

    lifecycle = LinearTokenLifecycle(
        linear,
        exchange=lambda _code: None,
        refresh=lambda _token: token_payload("access-new", "refresh-new"),
        verify=verified,
        now=lambda: 1000,
    )

    with pytest.raises(sqlite3.IntegrityError, match="rotation rejected"):
        await lifecycle.refresh("installation-1")
    assert linear.load_credentials("installation-1") == LinearCredentials(
        "access-old", "refresh-old", 1000
    )


@pytest.mark.asyncio
async def test_public_refresh_request_never_contains_client_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=token_payload())

    await refresh_public_token(
        "refresh-token-sentinel", transport=httpx.MockTransport(handler)
    )

    assert b"client_id=public-client" in requests[0].content
    assert b"refresh_token=refresh-token-sentinel" in requests[0].content
    assert b"client_secret" not in requests[0].content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ("invalid_grant", "linear_invalid_grant"),
        ("invalid_request", "linear_token_refresh_failed"),
    ],
)
async def test_public_refresh_classifies_only_exact_invalid_grant(
    monkeypatch: pytest.MonkeyPatch, error: str, expected: str
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": error})

    with pytest.raises(ValueError, match=f"^{expected}$"):
        await refresh_public_token(
            "refresh-token", transport=httpx.MockTransport(handler)
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "identity", "error_code"),
    [
        (token_payload(scopes="read,write"), None, "linear_scope_invalid"),
        (token_payload(actor="user"), None, "linear_actor_invalid"),
        (token_payload(actor="APP"), None, "linear_actor_invalid"),
        (
            token_payload(),
            {"viewer": {"id": "other", "app": True}, "organization": {"id": "organization-1"}},
            "linear_identity_drift",
        ),
    ],
)
async def test_invalid_scope_actor_or_identity_clears_pair_and_records_failure(
    tmp_path: Path,
    payload: dict[str, object],
    identity: dict[str, object] | None,
    error_code: str,
) -> None:
    _store, linear = repository(tmp_path / f"{error_code}.db")

    async def exchange(_code):
        return payload

    async def verify(_token):
        return identity or await verified(_token)

    lifecycle = LinearTokenLifecycle(
        linear, exchange=exchange, refresh=lambda _token: None, verify=verify, now=lambda: 1000
    )

    with pytest.raises(LinearTokenFailure, match=f"^{error_code}$"):
        await lifecycle.exchange(
            "installation-1", OAuthCodeExchange("attempt", "code", "verifier")
        )

    assert linear.load_credentials("installation-1") is None
    record = linear.installation("installation-1")
    assert record.status is InstallationStatus.REAUTHORIZATION_REQUIRED
    assert record.error_code == error_code


@pytest.mark.asyncio
async def test_successful_exchange_clears_previous_error_code(tmp_path: Path) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    linear.reject_credentials("installation-1", "linear_invalid_grant")
    lifecycle = LinearTokenLifecycle(
        linear,
        exchange=lambda _code: token_payload(),
        refresh=lambda _token: None,
        verify=verified,
        now=lambda: 1000,
    )

    await lifecycle.exchange(
        "installation-1", OAuthCodeExchange("attempt", "code", "verifier")
    )

    record = linear.installation("installation-1")
    assert record.status is InstallationStatus.CONNECTED
    assert record.error_code is None


@pytest.mark.asyncio
async def test_invalid_grant_is_durable_and_never_logs_tokens(
    tmp_path: Path, caplog
) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    linear.replace_credentials(
        "installation-1",
        "access-token-sentinel",
        "refresh-token-sentinel",
        expires_at=1000,
    )

    async def refresh(_token):
        raise LinearTokenFailure("linear_invalid_grant")

    lifecycle = LinearTokenLifecycle(
        linear, exchange=lambda _code: None, refresh=refresh, verify=verified, now=lambda: 1000
    )

    with pytest.raises(LinearTokenFailure, match="^linear_invalid_grant$"):
        await lifecycle.refresh("installation-1")

    assert linear.load_credentials("installation-1") is None
    assert linear.installation("installation-1").error_code == "linear_invalid_grant"
    assert "access-token-sentinel" not in caplog.text
    assert "refresh-token-sentinel" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ValueError("linear_token_refresh_failed"), OSError("offline")])
async def test_transient_refresh_failure_preserves_credentials_and_logs_safely(
    tmp_path: Path, caplog, failure: Exception
) -> None:
    _store, linear = repository(tmp_path / "podium.db")
    original = LinearCredentials(
        "access-token-sentinel", "refresh-token-sentinel", 1000
    )
    linear.replace_credentials(
        "installation-1",
        original.access_token,
        original.refresh_token,
        expires_at=original.expires_at,
    )

    async def refresh(_token):
        raise failure

    lifecycle = LinearTokenLifecycle(
        linear, exchange=lambda _code: None, refresh=refresh, verify=verified, now=lambda: 1000
    )

    with pytest.raises(LinearTokenFailure, match="^linear_token_refresh_failed$"):
        await lifecycle.refresh("installation-1")

    assert linear.load_credentials("installation-1") == original
    record = linear.installation("installation-1")
    assert record.status is InstallationStatus.CONNECTED
    assert record.error_code is None
    assert "event=linear_token_refresh_failed" in caplog.text
    assert "access-token-sentinel" not in caplog.text
    assert "refresh-token-sentinel" not in caplog.text
