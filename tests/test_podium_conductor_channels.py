from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app


def make_app():
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret="",
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
