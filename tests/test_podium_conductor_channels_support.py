from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app


def make_app(
    *,
    linear_webhook_secret: str = "",
    linear_graphql_transport: Any = None,
    data_dir: Any = None,
    secret_key: str = "test-secret",
    pg_store: Any = None,
    redis_store: Any = None,
):
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_webhook_secret=linear_webhook_secret,
        linear_graphql_transport=linear_graphql_transport,
        data_dir=data_dir,
        secret_key=secret_key,
        pg_store=pg_store,
        redis_store=redis_store,
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
