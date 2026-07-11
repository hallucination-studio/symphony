from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any

import httpx

from podium.app import create_app
from podium.store.postgres import PgStore


USER_ID = "pg-multiworker-user"
RUNTIME_ID = "pg-multiworker-runtime"
BINDING_ID = "pg-multiworker-binding"
INSTALLATION_ID = "pg-multiworker-installation"
PROJECT_ID = "pg-multiworker-project"
ISSUE_ID = "pg-multiworker-issue-1"


def app_for(store: PgStore) -> Any:
    return create_app(
        turnstile_verifier=lambda _token, _ip: True,
        secure_cookies=False,
        secret_key="real-pg-multiworker-probe",
        store=store,
    )


async def seed_durable_route(state: Any) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    await state.store.create_user(
        USER_ID,
        email="pg-multiworker-probe@example.com",
        password_hash="not-used-by-probe",
        created_at=now,
    )
    application = await state.stage_custom_linear_application(
        USER_ID,
        client_id="probe-linear-client",
        client_secret="probe-linear-client-secret",
    )
    await state.save_linear_installation_record(
        {
            "id": INSTALLATION_ID,
            "user_id": USER_ID,
            "application_config_id": application["id"],
            "application_config_version": application["version"],
            "application_source": application["source"],
            "state": "accepted",
            "active": False,
            "access_token": "probe-access-token",
            "refresh_token": "probe-refresh-token",
            "token_type": "Bearer",
            "actor": "app",
            "scope": ["read", "write", "app:assignable"],
            "expires_at": "2099-01-01T00:00:00Z",
            "linear_organization_id": USER_ID,
            "organization_url_key": "probe",
            "organization_name": "Probe",
            "app_user_id": "agent-alpha",
            "projects": [{"id": PROJECT_ID, "name": "Alpha", "slug_id": "ALPHA"}],
            "created_at": now,
            "updated_at": now,
        }
    )
    await state.activate_linear_installation(USER_ID, INSTALLATION_ID)
    await state.store.replace_selected_linear_projects(
        USER_ID,
        [
            {
                "user_id": USER_ID,
                "linear_organization_id": USER_ID,
                "linear_project_id": PROJECT_ID,
                "project_slug": "ALPHA",
                "project_name": "Alpha",
                "access_state": "ready",
            }
        ],
    )
    await state.store.upsert_runtime_group({"id": "pg-multiworker-group"})
    await state.store.upsert_conductor(
        {
            "id": RUNTIME_ID,
            "user_id": USER_ID,
            "runtime_group_id": "pg-multiworker-group",
            "runtime_token_hash": "not-used-runtime-token-hash",
            "proxy_token_hash": "not-used-proxy-token-hash",
            "created_at": now,
        }
    )
    await state.store.upsert_project_binding(
        {
            "id": BINDING_ID,
            "conductor_id": RUNTIME_ID,
            "user_id": USER_ID,
            "instance_id": "pg-multiworker-instance",
            "linear_project_id": PROJECT_ID,
            "project_slug": "ALPHA",
            "agent_app_user_id": "agent-alpha",
            "installation_id": INSTALLATION_ID,
            "managed_run_profile": "gated-task",
            "state": "ready",
            "updated_at": now,
        }
    )


def linear_transport(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content)
    variables = payload.get("variables") or {}
    authorized = request.headers.get("Authorization") == "Bearer probe-access-token"
    correct_route = (
        variables.get("projectId") == PROJECT_ID
        and variables.get("delegateId") == "agent-alpha"
    )
    if not authorized or not correct_route:
        return httpx.Response(
            401 if not authorized else 400,
            json={"errors": [{"message": "probe rejected"}]},
        )
    return httpx.Response(
        200,
        json={
            "data": {
                "issues": {
                    "nodes": [_linear_issue()],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        },
    )


def _linear_issue() -> dict[str, Any]:
    return {
        "id": ISSUE_ID,
        "identifier": "ALPHA-1",
        "title": "PG multiworker reconciliation probe",
        "description": "Prove polling dispatch durability.",
        "createdAt": "2026-07-11T00:00:00Z",
        "updatedAt": "2026-07-11T00:01:00Z",
        "project": {"id": PROJECT_ID, "slugId": "ALPHA"},
        "delegate": {"id": "agent-alpha"},
        "parent": None,
        "inverseRelations": {"nodes": []},
    }


__all__ = [
    "BINDING_ID",
    "ISSUE_ID",
    "RUNTIME_ID",
    "app_for",
    "linear_transport",
    "seed_durable_route",
]
