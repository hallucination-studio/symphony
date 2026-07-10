from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import httpx
import pytest

from test_podium_conductor_channels_support import (
    activate_linear_installation,
    bind_and_ack_conductor,
    enroll_conductor,
    make_app,
    register,
)


def _payload(user_id: str, *, timestamp: int | None = None, issue_id: str = "issue-1") -> dict[str, Any]:
    return {
        "type": "AgentSessionEvent",
        "action": "created",
        "organizationId": f"org-{user_id}",
        "webhookTimestamp": timestamp if timestamp is not None else int(time.time() * 1000),
        "webhookId": "webhook-config-1",
        "agentSession": {
            "id": "agent-session-1",
            "appUserId": "agent-alpha",
            "issue": {
                "id": issue_id,
                "identifier": "ALPHA-1",
                "title": "Implement the requested change",
                "description": "Acceptance fixture",
                "project": {"id": "project-alpha", "slugId": "ALPHA"},
                "delegate": {"id": "agent-alpha"},
                "parent": None,
                "inverseRelations": {"nodes": []},
            },
        },
    }


def _signed(payload: dict[str, Any], *, delivery_id: str, secret: str = "test-webhook-secret") -> tuple[bytes, dict[str, str]]:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {
        "Content-Type": "application/json",
        "Linear-Delivery": delivery_id,
        "Linear-Signature": signature,
        "Linear-Event": "AgentSessionEvent",
    }


async def _ready_runtime(client: httpx.AsyncClient, app: Any) -> tuple[str, dict[str, Any]]:
    user_id = await register(client, "webhook-owner@example.com")
    await activate_linear_installation(app, user_id)
    await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
    enrolled = await enroll_conductor(client)
    report, _binding = await bind_and_ack_conductor(app, client, user_id, enrolled)
    assert report.status_code == 200
    return user_id, enrolled


@pytest.mark.asyncio
async def test_signed_agent_session_webhook_queues_once_and_updates_health() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, enrolled = await _ready_runtime(client, app)
        raw, headers = _signed(_payload(user_id), delivery_id="delivery-1")

        accepted = await client.post("/api/v1/linear/webhooks", content=raw, headers=headers)
        replay = await client.post("/api/v1/linear/webhooks", content=raw, headers=headers)
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        installations = await client.get("/api/v1/linear/installations")

    assert accepted.status_code == 200
    assert accepted.json() == {"status": "accepted", "queued": 1, "delivery_id": "delivery-1"}
    assert replay.status_code == 200
    assert replay.json() == {"status": "duplicate", "queued": 0, "delivery_id": "delivery-1"}
    assert lease.json()["dispatch"]["issue_id"] == "issue-1"
    assert len(app.state.podium.store._load_map("dispatches.json")) == 1
    active = installations.json()["active"]
    assert active["webhook_state"] == "healthy"
    assert active["last_webhook_at"]


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_signature_and_stale_timestamp_before_dedupe() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled = await _ready_runtime(client, app)
        raw, headers = _signed(_payload(user_id), delivery_id="delivery-invalid")
        bad_headers = {**headers, "Linear-Signature": "0" * 64}
        invalid = await client.post("/api/v1/linear/webhooks", content=raw, headers=bad_headers)

        stale_raw, stale_headers = _signed(
            _payload(user_id, timestamp=int((time.time() - 120) * 1000)),
            delivery_id="delivery-stale",
        )
        stale = await client.post("/api/v1/linear/webhooks", content=stale_raw, headers=stale_headers)

    assert invalid.status_code == 401
    assert invalid.json()["error"]["code"] == "invalid_linear_webhook_signature"
    assert stale.status_code == 401
    assert stale.json()["error"]["code"] == "stale_linear_webhook"
    assert app.state.podium.store._load_map("linear_webhook_deliveries.json") == {}
    assert app.state.podium.store._load_map("dispatches.json") == {}


@pytest.mark.asyncio
async def test_webhook_validates_installation_app_and_bound_project() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled = await _ready_runtime(client, app)
        payload = _payload(user_id)
        payload["agentSession"]["appUserId"] = "different-app"
        payload["agentSession"]["issue"]["delegate"] = {"id": "different-app"}
        raw, headers = _signed(payload, delivery_id="delivery-wrong-app")

        rejected = await client.post("/api/v1/linear/webhooks", content=raw, headers=headers)

    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "linear_webhook_installation_mismatch"
    delivery = app.state.podium.store._load_map("linear_webhook_deliveries.json")["delivery-wrong-app"]
    assert delivery["status"] == "rejected"
    assert delivery["error_code"] == "linear_webhook_installation_mismatch"
    assert app.state.podium.store._load_map("dispatches.json") == {}
