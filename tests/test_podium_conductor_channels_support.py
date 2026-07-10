from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.store import PodiumStore


def make_app(
    *,
    linear_graphql_transport: Any = None,
    data_dir: Any = None,
    secret_key: str = "test-secret",
    store: Any = None,
    **overrides: Any,
):
    selected_store = store or PodiumStore(data_dir=data_dir)
    selected_transport = linear_graphql_transport or successful_project_label_transport
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        linear_graphql_transport=selected_transport,
        data_dir=data_dir,
        secret_key=secret_key,
        store=selected_store,
        **overrides,
    )


async def successful_project_label_transport(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content)
    operation = str(payload.get("operationName") or "")
    variables = payload.get("variables") or {}
    if operation == "ManagedProjectLabelLookup":
        data = {"projectLabels": {"nodes": []}}
    elif operation == "ManagedProjectLabelCreate":
        data = {
            "projectLabelCreate": {
                "success": True,
                "projectLabel": {"id": "managed-label", "name": variables["name"]},
            }
        }
    elif operation == "ManagedProjectAddLabel":
        data = {"projectAddLabel": {"success": True}}
    elif operation == "ManagedProjectLabelUpdate":
        data = {
            "projectLabelUpdate": {
                "success": True,
                "projectLabel": {"id": variables["labelId"], "name": variables["name"]},
            }
        }
    elif operation == "ManagedProjectRemoveLabel":
        data = {"projectRemoveLabel": {"success": True}}
    elif operation == "ManagedProjectLabelDelete":
        data = {"projectLabelDelete": {"success": True}}
    else:
        raise AssertionError(f"unexpected default Linear operation: {operation}")
    return httpx.Response(200, json={"data": data}, request=request)


class QueueResult:
    def __init__(self, *, status_code: int, body: dict[str, Any]) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, Any]:
        return dict(self._body)


async def queue_agent_session(app: Any, payload: dict[str, Any]) -> QueueResult:
    if payload.get("type") != "AgentSessionEvent":
        return QueueResult(status_code=200, body={"status": "ignored", "queued": 0})
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else {}
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else {}
    blocked_by = issue.get("blocked_by") if isinstance(issue.get("blocked_by"), list) else []
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    event = {
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "linear_organization_id": str(payload.get("organizationId") or ""),
        "linear_project_id": str(project.get("id") or ""),
        "project_slug": str(project.get("slugId") or ""),
        "issue_id": str(issue.get("id") or ""),
        "issue_identifier": str(issue.get("identifier") or ""),
        "issue_title": str(issue.get("title") or ""),
        "issue_description": str(issue.get("description") or ""),
        "agent_app_user_id": str(session.get("appUserId") or ""),
        "issue_delegate_id": str(delegate.get("id") or ""),
        "blocked_by": [str(item.get("id") or "") for item in blocked_by if isinstance(item, dict)],
        "parent_issue_id": str(parent.get("id") or payload.get("parent_issue_id") or ""),
        "managed_run_intent": dict(payload.get("managed_run_intent") or {}),
        "intake_key": f"linear-issue:{str(issue.get('id') or '')}",
    }
    queued = await app.state.podium.queue_dispatches(event)
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


async def activate_linear_installation(
    app: Any,
    user_id: str,
    *,
    access_token: str = "oauth-installation-token",
    app_user_id: str = "agent-alpha",
    projects: list[dict[str, str]] | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    installation_id = f"installation-{user_id}"
    application = await app.state.podium.stage_custom_linear_application(
        user_id,
        client_id="test-linear-client",
        client_secret="test-linear-client-secret",
    )
    await app.state.podium.save_linear_installation_record(
        {
            "id": installation_id,
            "user_id": user_id,
            "application_config_id": application["id"],
            "application_config_version": application["version"],
            "application_source": application["source"],
            "state": "accepted",
            "active": False,
            "access_token": access_token,
            "refresh_token": "oauth-refresh-token",
            "token_type": "Bearer",
            "actor": "app",
            "scope": ["read", "write", "app:assignable"],
            "expires_at": (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "linear_organization_id": f"org-{user_id}",
            "organization_url_key": "acme",
            "organization_name": "Acme",
            "app_user_id": app_user_id,
            "projects": projects or [{"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"}],
            "error_code": "",
            "sanitized_reason": "",
            "retryable": False,
            "action_required": "",
            "next_action": "",
            "created_at": now.isoformat().replace("+00:00", "Z"),
            "updated_at": now.isoformat().replace("+00:00", "Z"),
        }
    )
    await app.state.podium.activate_linear_installation(user_id, installation_id)
    return installation_id


async def bind_and_ack_conductor(
    app: Any,
    client: httpx.AsyncClient,
    user_id: str,
    enrolled: dict[str, Any],
    *,
    project_id: str = "project-alpha",
    project_slug: str = "ALPHA",
    app_user_id: str = "agent-alpha",
    instance_id: str = "inst-a",
    repository: str = "/repo/a",
    report_overrides: dict[str, Any] | None = None,
    report_extras: dict[str, Any] | None = None,
) -> tuple[httpx.Response, dict[str, Any]]:
    if app.state.podium.linear_graphql_transport is None:
        app.state.podium.linear_graphql_transport = successful_project_label_transport
    if await app.state.podium.get_active_linear_installation(user_id) is None:
        await activate_linear_installation(
            app,
            user_id,
            app_user_id=app_user_id,
            projects=[{"id": project_id, "name": project_slug.title(), "slug_id": project_slug}],
        )
    selected_ids = {
        str(row.get("linear_project_id") or "")
        for row in await app.state.podium.list_selected_linear_projects(user_id)
    }
    if project_id not in selected_ids:
        await app.state.podium.select_linear_projects(user_id, sorted({*selected_ids, project_id}))
    await app.state.podium.set_presence(enrolled["runtime_id"])
    bound = await client.put(
        f"/api/v1/conductors/{enrolled['runtime_id']}/binding",
        json={
            "linear_project_id": project_id,
            "repository": {"mode": "local_path", "value": repository},
        },
    )
    assert bound.status_code == 202, bound.text
    binding = bound.json()["binding"]
    payload = {
        "instance_id": instance_id,
        "name": project_slug.title(),
        "linear_project_id": project_id,
        "linear_project": project_slug,
        "project_slug": project_slug,
        "agent_app_user_id": app_user_id,
        "binding_config_version": binding["config_version"],
        "managed_run_profile": "default",
        "process_status": "stopped",
        "constraint_labels": [],
        "repo_source": {"type": "local_path", "value": repository},
        **(report_overrides or {}),
    }
    report = await client.post(
        "/api/v1/runtime/report",
        headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
        json={"bindings": [payload], **(report_extras or {})},
    )
    return report, binding


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


def agent_session_payload_with_managed_run_intent(*, workspace_id: str, project_slug: str, delegate_id: str) -> dict[str, Any]:
    payload = agent_session_payload(workspace_id=workspace_id, project_slug=project_slug, delegate_id=delegate_id)
    payload["managed_run_intent"] = {
        "required_gate_steps": [
            {"step": "pytest tests/test_smoke.py -q", "source": "acceptance_appendix"}
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
