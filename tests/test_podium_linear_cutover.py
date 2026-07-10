from __future__ import annotations

from datetime import datetime, timedelta, timezone
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


async def _candidate(app: Any, user_id: str) -> str:
    now = datetime.now(timezone.utc)
    application = await app.state.podium.stage_custom_linear_application(
        user_id,
        client_id="replacement-client",
        client_secret="replacement-secret",
    )
    installation_id = f"candidate-{user_id}"
    await app.state.podium.save_linear_installation_record(
        {
            "id": installation_id,
            "user_id": user_id,
            "application_config_id": application["id"],
            "application_config_version": application["version"],
            "application_source": "custom",
            "state": "draining",
            "active": False,
            "access_token": "replacement-access-token",
            "refresh_token": "replacement-refresh-token",
            "token_type": "Bearer",
            "actor": "app",
            "scope": ["read", "write", "app:assignable"],
            "expires_at": (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "linear_organization_id": f"org-{user_id}",
            "organization_url_key": "acme",
            "organization_name": "Acme",
            "app_user_id": "agent-beta",
            "projects": [{"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"}],
            "reconciliation_state": "pending",
            "last_reconciliation_at": None,
            "reconciliation_error": "",
            "reconciliation_retry_count": 0,
            "error_code": "",
            "sanitized_reason": "",
            "retryable": False,
            "action_required": "wait",
            "next_action": "drain_managed_runs",
            "created_at": now.isoformat().replace("+00:00", "Z"),
            "updated_at": now.isoformat().replace("+00:00", "Z"),
        }
    )
    return installation_id


async def _ready(client: httpx.AsyncClient, app: Any) -> tuple[str, dict[str, Any], dict[str, Any]]:
    user_id = await register(client, "cutover-owner@example.com")
    await activate_linear_installation(app, user_id)
    await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
    enrolled = await enroll_conductor(client)
    report, binding = await bind_and_ack_conductor(app, client, user_id, enrolled)
    assert report.status_code == 200
    return user_id, enrolled, binding


@pytest.mark.asyncio
async def test_candidate_stays_draining_while_dispatch_is_open() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, _enrolled, _binding = await _ready(client, app)
        candidate_id = await _candidate(app, user_id)
        queued = await app.state.podium.queue_dispatches(
            {
                "workspace_id": user_id,
                "linear_project_id": "project-alpha",
                "project_slug": "ALPHA",
                "issue_id": "issue-open",
                "issue_identifier": "ALPHA-1",
                "agent_session_id": "session-open",
                "agent_app_user_id": "agent-alpha",
                "issue_delegate_id": "agent-alpha",
            }
        )
        cutover = await client.post("/api/v1/linear/installations/cutover")

    assert queued == 1
    assert cutover.status_code == 200
    assert cutover.json()["candidate"]["id"] == candidate_id
    assert cutover.json()["candidate"]["state"] == "draining"
    assert cutover.json()["cutover_state"] == "waiting_for_drain"
    assert app.state.podium.store._load_map("runtime_commands.json")


@pytest.mark.asyncio
async def test_candidate_switches_only_after_every_binding_is_prepared() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id, enrolled, binding = await _ready(client, app)
        old_installation = await app.state.podium.get_active_linear_installation(user_id)
        candidate_id = await _candidate(app, user_id)

        preparing = await client.post("/api/v1/linear/installations/cutover")
        prepared_binding = (await app.state.podium.store.list_project_bindings_for_conductor(enrolled["runtime_id"]))[0]
        prepared_report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "linear_project_id": "project-alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "binding_config_version": binding["config_version"],
                        "prepared_installation_id": candidate_id,
                        "prepared_binding_config_version": prepared_binding["candidate_config_version"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                    }
                ]
            },
        )
        switched = await client.post("/api/v1/linear/installations/cutover")
        switched_binding = (await app.state.podium.store.list_project_bindings_for_conductor(enrolled["runtime_id"]))[0]
        activated_report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "linear_project_id": "project-alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-beta",
                        "binding_config_version": switched_binding["config_version"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                    }
                ]
            },
        )
        installations = await client.get("/api/v1/linear/installations")

    assert preparing.json()["cutover_state"] == "waiting_for_conductors"
    assert preparing.json()["candidate"]["state"] == "preparing"
    assert prepared_report.status_code == 200
    assert switched.json()["cutover_state"] == "switched"
    assert switched.json()["active"]["id"] == candidate_id
    assert switched_binding["state"] == "switching"
    assert switched_binding["agent_app_user_id"] == "agent-beta"
    commands = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]]
    assert [row["command"]["type"] for row in commands][-2:] == [
        "project.prepare_installation",
        "project.activate_installation",
    ]
    assert activated_report.status_code == 200
    assert activated_report.json()["binding_state"] == "ready"
    final_binding = (await app.state.podium.store.list_project_bindings_for_conductor(enrolled["runtime_id"]))[0]
    assert final_binding["state"] == "ready"
    assert installations.json()["active"]["id"] == candidate_id
    old_row = app.state.podium.store._load_map("linear_workspace_installations.json")[old_installation["id"]]
    assert old_row["state"] == "retired"
    assert old_row["active"] is False
