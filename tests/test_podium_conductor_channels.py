from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app


def make_app(*, linear_webhook_secret: str = "", linear_graphql_transport: Any = None):
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret=linear_webhook_secret,
        linear_graphql_transport=linear_graphql_transport,
    )


async def register(client: httpx.AsyncClient, email: str = "phase@example.com") -> str:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "correct-horse", "turnstile_token": "turnstile-ok"},
    )
    assert response.status_code == 200
    return str(response.json()["user"]["id"])


async def enroll_conductor(client: httpx.AsyncClient) -> dict[str, Any]:
    token_response = await client.post("/api/v1/onboarding/runtime/enrollment-token")
    assert token_response.status_code == 200
    enrolled = await client.post(
        "/api/v1/runtime/enroll",
        json={
            "enrollment_token": token_response.json()["enrollment_token"],
            "hostname": "server-a",
            "label": "Server A",
            "version": "0.2.0",
        },
    )
    assert enrolled.status_code == 200
    return enrolled.json()


def agent_session_payload(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    return {
        "type": "AgentSessionEvent",
        "workspace": {"id": workspace_id},
        "agentSession": {
            "id": "agent-session-1",
            "appUserId": delegate_id,
            "issue": {
                "id": "issue-1",
                "identifier": f"{project_slug}-1",
                "project": {"slugId": project_slug},
                "delegate": {"id": delegate_id},
            },
        },
    }


def signature(raw: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_runtime_report_upserts_conductor_bindings_metrics_and_log_tail() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client)
        enrolled = await enroll_conductor(client)

        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "hostname": "server-a",
                "label": "Server A",
                "version": "0.2.1",
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "name": "Alpha",
                        "linear_project": "Project Alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "workflow_profile": "gated-task",
                        "process_status": "running",
                        "constraint_labels": ["symphony:performer/Alpha", "symphony:profile/gated-task"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                    },
                    {
                        "instance_id": "inst-b",
                        "name": "Beta",
                        "linear_project": "Project Beta",
                        "project_slug": "BETA",
                        "agent_app_user_id": "agent-beta",
                        "workflow_profile": "task",
                        "process_status": "stopped",
                    },
                ],
                "metrics": {
                    "inst-a": {
                        "tokens": 10,
                        "runtime_seconds": 20,
                        "retries": 1,
                        "continuations": 2,
                        "blocked": 3,
                        "pending_human": 4,
                        "failures": 4,
                    }
                },
                "queue": {"inst-a": {"queued": 5, "leased": 1, "running": 1}},
                "log_tail": {
                    "inst-a": {
                        "generation": 7,
                        "offset_end": 123,
                        "lines": ["newest", "older"],
                    }
                },
            },
        )

        listed = await client.get("/api/v1/runtimes")
        logs = await client.get(f"/api/v1/runtimes/{enrolled['runtime_id']}/instances/inst-a/logs?tail=2&order=desc")

    assert report.status_code == 200
    assert report.json()["bindings_upserted"] == 2
    assert listed.status_code == 200
    conductor = listed.json()["conductors"][0]
    assert conductor["conductor_id"] == enrolled["runtime_id"]
    assert conductor["online"] is False
    assert [binding["project_slug"] for binding in conductor["bindings"]] == ["ALPHA", "BETA"]
    assert conductor["bindings"][0]["metrics"]["tokens"] == 10
    assert conductor["bindings"][0]["metrics"]["pending_human"] == 4
    assert conductor["bindings"][0]["queue"]["queue_depth"] == 6
    assert conductor["bindings"][0]["constraint_labels"] == [
        "symphony:performer/Alpha",
        "symphony:profile/gated-task",
    ]
    assert conductor["bindings"][1]["constraint_labels"] == []
    assert logs.status_code == 200
    assert logs.json()["logs"]["lines"] == ["newest", "older"]
    assert logs.json()["logs"]["cursor"] == 123


@pytest.mark.asyncio
async def test_dispatch_routes_by_project_binding_not_single_workspace_group() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "routing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"},
                    {"instance_id": "inst-b", "project_slug": "BETA", "agent_app_user_id": "agent-beta"},
                ]
            },
        )
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=json.dumps(agent_session_payload(workspace_id=user_id, project_slug="BETA", delegate_id="agent-beta")).encode(),
            headers={"Content-Type": "application/json", "Linear-Signature": "ignored"},
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )

    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert lease.status_code == 200
    dispatch = lease.json()["dispatch"]
    assert dispatch["project_binding_id"].endswith(":inst-b")
    assert dispatch["project_slug"] == "BETA"
    assert dispatch["instance_id"] == "inst-b"


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_signature_and_invalid_json() -> None:
    secret = "webhook-secret"
    app = make_app(linear_webhook_secret=secret)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        bad_signature = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={"type": "AgentSessionEvent"},
            headers={"Linear-Signature": "bad"},
        )

        bad_raw = b"{"
        bad_json = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=bad_raw,
            headers={"Linear-Signature": signature(bad_raw, secret)},
        )

    assert bad_signature.status_code == 401
    assert bad_signature.json()["error"]["code"] == "invalid_signature"
    assert bad_json.status_code == 400
    assert bad_json.json()["error"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_signed_webhook_queues_dispatch_and_runtime_ack_completes_it() -> None:
    secret = "webhook-secret"
    app = make_app(linear_webhook_secret=secret)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "signed-routing@example.com")
        enrolled = await enroll_conductor(client)
        await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "workflow_profile": "gated-task",
                    }
                ]
            },
        )

        rejected_payload = agent_session_payload(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="other-agent",
        )
        rejected_raw = json.dumps(rejected_payload).encode()
        rejected = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=rejected_raw,
            headers={"Content-Type": "application/json", "Linear-Signature": signature(rejected_raw, secret)},
        )

        queued_payload = agent_session_payload(
            workspace_id=user_id,
            project_slug="ALPHA",
            delegate_id="agent-alpha",
        )
        queued_raw = json.dumps(queued_payload).encode()
        queued = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            content=queued_raw,
            headers={"Content-Type": "application/json", "Linear-Signature": signature(queued_raw, secret)},
        )
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        )
        dispatch = lease.json()["dispatch"]
        ack = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "dispatch_id": dispatch["dispatch_id"],
                "status": "completed",
                "reason": "completed_by_runtime",
                "runtime_phase": "completed",
            },
        )

    assert rejected.status_code == 200
    assert rejected.json()["queued"] == 0
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1
    assert dispatch["issue_id"] == "issue-1"
    assert dispatch["issue_identifier"] == "ALPHA-1"
    assert dispatch["workflow_profile"] == "gated-task"
    assert ack.status_code == 200
    assert ack.json()["dispatch"]["status"] == "completed"
    assert ack.json()["dispatch"]["reason"] == "completed_by_runtime"
    assert ack.json()["dispatch"]["runtime_phase"] == "completed"


@pytest.mark.asyncio
async def test_linear_proxy_requires_proxy_token_and_audits_requests() -> None:
    seen_authorization: list[str] = []

    def linear_transport(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers["Authorization"])
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    app = make_app(linear_graphql_transport=linear_transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await register(client, "proxy@example.com")
        enrolled = await enroll_conductor(client)

        unauthorized = await client.post("/api/v1/linear/graphql", json={"query": "{ viewer { id } }"})
        missing_installation = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

        app.state.podium.linear_installations[user_id] = {
            "workspace_id": user_id,
            "access_token": "oauth-installation-token",
            "scope": "read write",
            "expires_at": None,
        }
        allowed = await client.post(
            "/api/v1/linear/graphql",
            json={"operationName": "Viewer", "query": "{ viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert unauthorized.status_code == 401
    assert missing_installation.status_code == 400
    assert missing_installation.json()["error"]["code"] == "linear_installation_not_found"
    assert allowed.status_code == 200
    assert allowed.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert seen_authorization == ["oauth-installation-token"]


@pytest.mark.asyncio
async def test_linear_proxy_can_use_environment_access_token_without_workspace_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str | None] = {}

    def linear_transport(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"data": {"viewer": {"id": "viewer-1"}}})

    monkeypatch.setenv("PODIUM_LINEAR_ACCESS_TOKEN", "operator-linear-token")
    app = make_app(linear_graphql_transport=linear_transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await register(client, "env-proxy@example.com")
        enrolled = await enroll_conductor(client)
        proxied = await client.post(
            "/api/v1/linear/graphql",
            json={"query": "query { viewer { id } }"},
            headers={"Authorization": f"Bearer {enrolled['proxy_token']}"},
        )

    assert proxied.status_code == 200
    assert proxied.json() == {"data": {"viewer": {"id": "viewer-1"}}}
    assert captured["authorization"] == "operator-linear-token"


def test_runtime_ws_presence_dispatch_wakeup_and_log_fetch_roundtrip() -> None:
    with TestClient(make_app()) as client:
        register_response = client.post(
            "/api/v1/auth/register",
            json={"email": "ws@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        assert register_response.status_code == 200
        user_id = register_response.json()["user"]["id"]
        token_response = client.post("/api/v1/onboarding/runtime/enrollment-token")
        enrolled = client.post("/api/v1/runtime/enroll", json={"enrollment_token": token_response.json()["enrollment_token"]}).json()
        client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [{"instance_id": "inst-a", "project_slug": "ALPHA", "agent_app_user_id": "agent-alpha"}]},
        )

        with client.websocket_connect(
            "/api/v1/runtime/ws",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        ) as ws:
            ws.send_json({"type": "hello"})
            assert ws.receive_json()["type"] == "ping"

            queued = client.post(
                "/api/v1/linear/webhooks/agent-session",
                content=json.dumps(agent_session_payload(workspace_id=user_id, project_slug="ALPHA", delegate_id="agent-alpha")).encode(),
                headers={"Content-Type": "application/json", "Linear-Signature": "ignored"},
            )
            assert queued.status_code == 200
            wakeup = ws.receive_json()
            assert wakeup["type"] == "dispatch.available"
            assert wakeup["instance_id"] == "inst-a"

            fetch = client.get(f"/api/v1/runtimes/{enrolled['runtime_id']}/instances/inst-a/logs?tail=3&previous=1")
            assert fetch.status_code == 202
            command = ws.receive_json()
            assert command["type"] == "log.fetch"
            assert command["instance_id"] == "inst-a"
            assert command["tail"] == 3
            assert command["previous"] is True
            chunk = client.post(
                "/api/v1/runtime/log-chunks",
                headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
                json={
                    "request_id": command["request_id"],
                    "instance_id": "inst-a",
                    "generation": 2,
                    "offset_start": 10,
                    "offset_end": 20,
                    "order": "desc",
                    "lines": ["tail-1", "tail-2"],
                },
            )
            assert chunk.status_code == 200
            result = client.get(f"/api/v1/runtime/log-fetches/{command['request_id']}")
            assert result.status_code == 200
            assert result.json()["logs"]["lines"] == ["tail-1", "tail-2"]

        listed = client.get("/api/v1/runtimes")
        assert listed.json()["conductors"][0]["online"] is False
