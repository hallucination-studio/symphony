from __future__ import annotations

import asyncio

import pytest

from podium.live_conductor_relay import LiveConductorRelay, LiveRelayError


@pytest.mark.anyio
async def test_live_relay_leases_once_and_delivers_ephemeral_reply() -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer_credentials.inspect", {"limit": 25}))
    await asyncio.sleep(0)

    leased = await relay.lease("conductor-1")
    assert leased is not None
    assert await relay.lease("conductor-1") is None
    assert await relay.reply("conductor-1", leased["request_id"], leased["lease_token"], {"slots": []})
    result = await waiter
    assert result["version"] == 1
    assert result["conductor_id"] == "conductor-1"
    assert result["slots"] == []
    assert not await relay.reply("conductor-1", leased["request_id"], leased["lease_token"], {"slots": []})


@pytest.mark.anyio
async def test_live_relay_rejects_parallel_queries_and_rate_limits_checks() -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer_credentials.check", {"slot_id": "main"}))
    await asyncio.sleep(0)

    with pytest.raises(LiveRelayError, match="in_progress"):
        await relay.request("conductor-1", "performer_credentials.check", {"slot_id": "main"})

    leased = await relay.lease("conductor-1")
    assert leased is not None
    await relay.reply("conductor-1", leased["request_id"], leased["lease_token"], {"status": "passed"})
    await waiter
    with pytest.raises(LiveRelayError, match="rate_limited"):
        await relay.request("conductor-1", "performer_credentials.check", {"slot_id": "main"})


@pytest.mark.anyio
async def test_live_relay_allowlists_reply_fields_and_drops_secrets() -> None:
    relay = LiveConductorRelay()
    waiter = asyncio.create_task(relay.request("conductor-1", "performer_credentials.inspect", {"limit": 25}))
    await asyncio.sleep(0)
    leased = await relay.lease("conductor-1")
    assert leased is not None
    await relay.reply(
        "conductor-1",
        leased["request_id"],
        leased["lease_token"],
        {
            "observed_at": "2026-07-13T00:00:00Z",
            "access_token": "secret",
            "slots": [{"slot_id": "main", "display_name": "Main", "state": "active", "auth_method": "oauth", "token": "secret"}],
        },
    )

    result = await waiter
    assert result["slots"][0] == {
        "slot_id": "main",
        "display_name": "Main",
        "performer_kind": "codex",
        "state": "active",
        "selected": False,
        "precheck": None,
    }
    assert "secret" not in str(result)
