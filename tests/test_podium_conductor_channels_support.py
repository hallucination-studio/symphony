from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.podium_routes_runtime import normalize_agent_session_event
from podium.store import PodiumStore


def make_app(
    *,
    linear_graphql_transport: Any = None,
    data_dir: Any = None,
    secret_key: str = "test-secret",
    store: Any = None,
):
    selected_store = store or PodiumStore(data_dir=data_dir)
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_graphql_transport=linear_graphql_transport,
        data_dir=data_dir,
        secret_key=secret_key,
        store=selected_store,
    )


class QueueResult:
    def __init__(self, *, status_code: int, body: dict[str, Any]) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, Any]:
        return dict(self._body)


async def queue_agent_session(app: Any, payload: dict[str, Any]) -> QueueResult:
    if payload.get("type") != "AgentSessionEvent":
        return QueueResult(status_code=200, body={"status": "ignored", "queued": 0})
    queued = await app.state.podium.queue_dispatches(normalize_agent_session_event(payload))
    return QueueResult(status_code=200, body={"status": "accepted", "queued": queued})


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


def agent_session_payload_with_pipeline_intent(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["pipeline_intent"] = {
        "required_gate_steps": [
            {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
        ],
        "parallel_dependency_shape": {
            "parallel_branch_node_ids": ["parallel-a", "parallel-b"],
            "downstream_node_ids": ["downstream"],
        },
    }
    return payload


def agent_session_payload_without_session_id(
    *,
    workspace_id: str,
    project_slug: str,
    delegate_id: str,
    issue_id: str,
    identifier: str,
) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["agentSession"].pop("id", None)
    payload["agentSession"]["issue"]["id"] = issue_id
    payload["agentSession"]["issue"]["identifier"] = identifier
    return payload


def agent_session_payload_with_distinct_session_app_user(
    *,
    workspace_id: str,
    project_slug: str,
    session_app_user_id: str,
    issue_delegate_id: str,
) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=session_app_user_id)
    payload["agentSession"]["appUserId"] = session_app_user_id
    payload["agentSession"]["issue"]["delegate"] = {"id": issue_delegate_id}
    return payload


def dependent_agent_session_payload(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["agentSession"]["issue"]["parent"] = {"id": "parent-1", "identifier": "ALPHA-ROOT"}
    payload["agentSession"]["issue"]["blocked_by"] = [{"id": "blocker-1", "identifier": "ALPHA-1"}]
    return payload


def signature(raw: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
