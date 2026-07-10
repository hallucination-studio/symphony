from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.config import PodiumConfig
from podium.linear_reconciliation import LinearReconciler
from test_podium_conductor_channels_support import (
    activate_linear_installation,
    bind_and_ack_conductor,
    enroll_conductor,
    make_app,
    register,
)


def _issue(*, issue_id: str = "issue-1", title: str = "Do the work", description: str = "") -> dict[str, Any]:
    return {
        "id": issue_id,
        "identifier": "ALPHA-1",
        "title": title,
        "description": description,
        "createdAt": "2026-07-10T10:00:00Z",
        "updatedAt": "2026-07-10T10:01:00Z",
        "project": {"id": "project-alpha", "slugId": "ALPHA"},
        "delegate": {"id": "agent-alpha"},
        "parent": None,
        "inverseRelations": {"nodes": []},
    }


async def _ready(client: httpx.AsyncClient, app: Any) -> tuple[str, dict[str, Any], str]:
    user_id = await register(client, "reconciliation-owner@example.com")
    installation_id = await activate_linear_installation(app, user_id, access_token="workspace-oauth-token")
    await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
    enrolled = await enroll_conductor(client)
    report, binding = await bind_and_ack_conductor(app, client, user_id, enrolled)
    assert report.status_code == 200
    return user_id, enrolled, binding["id"]


@pytest.mark.asyncio
async def test_reconciliation_uses_active_installation_token_and_stable_project_id() -> None:
    seen: dict[str, Any] = {}

    def transport(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("Authorization")
        seen["variables"] = json.loads(request.content)["variables"]
        return httpx.Response(200, json={"data": {"issues": {"nodes": [_issue()]}}})

    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, enrolled, binding_id = await _ready(client, app)
        result = await LinearReconciler(state=app.state.podium, transport=transport).reconcile_once()
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert result == {"installations": 1, "bindings": 1, "queued": 1, "errors": 0}
    assert seen["authorization"] == "Bearer workspace-oauth-token"
    assert seen["variables"]["projectId"] == "project-alpha"
    assert seen["variables"]["delegateId"] == "agent-alpha"
    assert lease.json()["dispatch"]["issue_id"] == "issue-1"
    state = await app.state.podium.store.get_linear_reconciliation_state(binding_id)
    assert state["cursor"] == "2026-07-10T10:01:00Z"
    assert state["last_error"] == ""


@pytest.mark.asyncio
async def test_webhook_and_reconciliation_share_issue_idempotency_key() -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"issues": {"nodes": [_issue()]}}})

    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled, _binding_id = await _ready(client, app)
        payload = {
            "type": "AgentSessionEvent",
            "action": "created",
            "organizationId": f"org-{user_id}",
            "webhookTimestamp": int(time.time() * 1000),
            "agentSession": {"id": "session-1", "appUserId": "agent-alpha", "issue": _issue()},
        }
        raw = json.dumps(payload, separators=(",", ":")).encode()
        signature = hmac.new(b"test-webhook-secret", raw, hashlib.sha256).hexdigest()
        webhook = await client.post(
            "/api/v1/linear/webhooks",
            content=raw,
            headers={
                "Content-Type": "application/json",
                "Linear-Delivery": "delivery-shared",
                "Linear-Signature": signature,
            },
        )
        reconciliation = await LinearReconciler(state=app.state.podium, transport=transport).reconcile_once()

    assert webhook.json()["queued"] == 1
    assert reconciliation["queued"] == 0
    dispatches = app.state.podium.store._load_map("dispatches.json")
    assert len(dispatches) == 1
    assert next(iter(dispatches.values()))["intake_key"] == "linear-issue:issue-1"


@pytest.mark.asyncio
async def test_reconciliation_failure_preserves_cursor_and_is_visible() -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})

    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        _user_id, _enrolled, binding_id = await _ready(client, app)
        await app.state.podium.store.save_linear_reconciliation_state(
            binding_id,
            {"binding_id": binding_id, "cursor": "2026-07-10T09:00:00Z"},
        )
        result = await LinearReconciler(state=app.state.podium, transport=transport).reconcile_once()
        installations = await client.get("/api/v1/linear/installations")

    assert result["errors"] == 1
    state = await app.state.podium.store.get_linear_reconciliation_state(binding_id)
    assert state["cursor"] == "2026-07-10T09:00:00Z"
    assert "linear_reconciliation_failed" in state["last_error"]
    active = installations.json()["active"]
    assert active["reconciliation_state"] == "degraded"
    assert active["reconciliation_retry_count"] == 1
    assert "linear_reconciliation_failed" in active["reconciliation_error"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("title", "description"),
    [
        ("[Human Action] Approve", ""),
        ("Generated work item", "SYMPHONY WORK ITEM"),
        ("Run report", "symphony:run-summary:start"),
    ],
)
async def test_reconciliation_ignores_symphony_projection_issues(title: str, description: str) -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": {"issues": {"nodes": [_issue(title=title, description=description)]}}},
        )

    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _ready(client, app)
        result = await LinearReconciler(state=app.state.podium, transport=transport).reconcile_once()

    assert result["queued"] == 0
    assert app.state.podium.store._load_map("dispatches.json") == {}


def test_podium_lifespan_always_starts_reconciliation_without_global_token() -> None:
    app = make_app()
    app.state.podium.config = PodiumConfig(linear_reconciliation_interval_seconds=1)

    with TestClient(app):
        assert app.state.linear_reconciliation_task is not None
        assert not app.state.linear_reconciliation_task.done()

    assert app.state.linear_reconciliation_task is None
