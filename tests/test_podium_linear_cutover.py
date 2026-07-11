from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app
from podium.podium_shared import hash_secret
from podium.store import PgStore


def _installation(
    installation_id: str,
    *,
    state: str,
    active: bool,
    app_user_id: str,
) -> dict[str, Any]:
    return {
        "id": installation_id,
        "user_id": "user-1",
        "state": state,
        "active": active,
        "app_user_id": app_user_id,
        "access_token": f"{installation_id}-access-token",
        "refresh_token": f"{installation_id}-refresh-token",
    }


def _app(store: object, **overrides: Any) -> Any:
    return create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
        **overrides,
    )


@pytest.mark.asyncio
async def test_candidate_stays_draining_while_dispatch_is_open() -> None:
    active = _installation(
        "installation-active",
        state="ready",
        active=True,
        app_user_id="agent-alpha",
    )
    candidate = _installation(
        "installation-candidate",
        state="draining",
        active=False,
        app_user_id="agent-beta",
    )
    store = SimpleNamespace(
        count_open_dispatches_for_user=AsyncMock(return_value=1),
    )
    app = _app(store)
    app.state.podium.user_for_session = AsyncMock(return_value={"id": "user-1"})
    app.state.podium.get_active_linear_installation = AsyncMock(return_value=active)
    app.state.podium.get_candidate_linear_installation = AsyncMock(return_value=candidate)
    app.state.podium.enqueue_runtime_command = AsyncMock()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        response = await client.post("/api/v1/linear/installations/cutover")

    assert response.status_code == 200
    assert response.json()["candidate"]["id"] == candidate["id"]
    assert response.json()["candidate"]["state"] == "draining"
    assert response.json()["cutover_state"] == "waiting_for_drain"
    store.count_open_dispatches_for_user.assert_awaited_once_with("user-1")
    app.state.podium.enqueue_runtime_command.assert_not_awaited()


@pytest.mark.asyncio
async def test_cutover_requires_prepare_and_activate_runtime_reports_before_binding_is_ready(
    postgres_database_url: str,
) -> None:
    runtime_token = "runtime-token"
    revoked: list[tuple[str, str]] = []

    async def revoke(token: str, token_type_hint: str) -> None:
        revoked.append((token, token_type_hint))

    store = await PgStore.connect(postgres_database_url)
    try:
        await store.migrate()
        await store.create_user(
            "user-1",
            email="operator@example.com",
            password_hash="password-hash",
            created_at="2026-07-11T00:00:00Z",
        )
        await store.upsert_runtime_group({"id": "group-1"})
        await store.upsert_conductor(
            {
                "id": "runtime-1",
                "user_id": "user-1",
                "runtime_group_id": "group-1",
                "name": "Bach",
                "public_id": "abc123",
                "enrollment_state": "enrolled",
                "runtime_token_hash": hash_secret(runtime_token),
                "proxy_token_hash": "proxy-token-hash",
                "created_at": "2026-07-11T00:00:00Z",
            }
        )
        app = _app(store, linear_token_revoke=revoke)
        app.state.podium.user_for_session = AsyncMock(return_value={"id": "user-1"})
        application = await app.state.podium.stage_custom_linear_application(
            "user-1",
            client_id="linear-client",
            client_secret="linear-secret",
        )
        installation = {
            "user_id": "user-1",
            "application_config_id": application["id"],
            "application_config_version": application["version"],
            "application_source": application["source"],
            "access_token": "installation-access-token",
            "refresh_token": "installation-refresh-token",
            "token_type": "Bearer",
            "actor": "app",
            "scope": ["read", "write", "app:assignable"],
            "linear_organization_id": "organization-1",
            "projects": [{"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"}],
            "created_at": "2026-07-11T00:00:00Z",
            "updated_at": "2026-07-11T00:00:00Z",
        }
        await app.state.podium.save_linear_installation_record(
            {
                **installation,
                "id": "installation-active",
                "state": "ready",
                "active": True,
                "app_user_id": "agent-alpha",
            }
        )
        await app.state.podium.save_linear_installation_record(
            {
                **installation,
                "id": "installation-candidate",
                "state": "draining",
                "active": False,
                "app_user_id": "agent-beta",
                "access_token": "candidate-access-token",
                "refresh_token": "candidate-refresh-token",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )
        await store.upsert_project_binding(
            {
                "id": "binding-1",
                "user_id": "user-1",
                "conductor_id": "runtime-1",
                "instance_id": "instance-1",
                "linear_project_id": "project-alpha",
                "project_slug": "ALPHA",
                "project_name": "Alpha",
                "installation_id": "installation-active",
                "agent_app_user_id": "agent-alpha",
                "repo_source": {"type": "local_path", "value": "/repo/a"},
                "config_version": 3,
                "acknowledged_config_version": 3,
                "state": "ready",
                "active": True,
                "label_id": "label-1",
                "label_name": "symphony:conductor/Bach-abc123",
                "updated_at": "2026-07-11T00:00:00Z",
            }
        )

        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://podium.test",
        ) as client:
            preparing = await client.post("/api/v1/linear/installations/cutover")
            prepared_binding = await store.get_project_binding("binding-1")
            assert prepared_binding is not None
            prepare_command = await store.next_runtime_command("runtime-1", after_id=0)
            assert prepare_command is not None
            still_waiting = await client.post("/api/v1/linear/installations/cutover")

            prepare_report = await client.post(
                "/api/v1/runtime/report",
                headers=headers,
                json={
                    "bindings": [
                        {
                            "instance_id": "instance-1",
                            "linear_project_id": "project-alpha",
                            "project_slug": "ALPHA",
                            "agent_app_user_id": "agent-alpha",
                            "binding_config_version": 3,
                            "repo_source": {"type": "local_path", "value": "/repo/a"},
                            "process_status": "running",
                            "prepared_installation_id": "installation-candidate",
                            "prepared_binding_config_version": prepared_binding[
                                "candidate_config_version"
                            ],
                        }
                    ]
                },
            )
            switched = await client.post("/api/v1/linear/installations/cutover")
            switching_binding = await store.get_project_binding("binding-1")
            assert switching_binding is not None
            activate_command = await store.next_runtime_command(
                "runtime-1",
                after_id=int(prepare_command["id"]),
            )
            assert activate_command is not None
            activate_report = await client.post(
                "/api/v1/runtime/report",
                headers=headers,
                json={
                    "bindings": [
                        {
                            "instance_id": "instance-1",
                            "linear_project_id": "project-alpha",
                            "project_slug": "ALPHA",
                            "agent_app_user_id": "agent-beta",
                            "binding_config_version": prepared_binding[
                                "candidate_config_version"
                            ],
                            "repo_source": {"type": "local_path", "value": "/repo/a"},
                            "process_status": "running",
                        }
                    ]
                },
            )

        installations = {
            row["id"]: row for row in await store.list_workspace_installations("user-1")
        }
        ready_binding = await store.get_project_binding("binding-1")
    finally:
        await store.close()

    assert preparing.status_code == 200
    assert preparing.json()["cutover_state"] == "waiting_for_conductors"
    assert still_waiting.status_code == 200
    assert still_waiting.json()["cutover_state"] == "waiting_for_conductors"
    assert prepare_report.status_code == 200
    assert switched.status_code == 200
    assert switched.json()["cutover_state"] == "switched"
    assert switched.json()["active"]["id"] == "installation-candidate"
    assert switching_binding["state"] == "switching"
    assert switching_binding["acknowledged_config_version"] == 3
    assert activate_report.status_code == 200
    assert activate_report.json()["binding_state"] == "ready"
    assert [prepare_command["command"]["type"], activate_command["command"]["type"]] == [
        "project.prepare_installation",
        "project.activate_installation",
    ]
    assert ready_binding is not None
    assert (
        ready_binding["state"],
        ready_binding["installation_id"],
        ready_binding["agent_app_user_id"],
        ready_binding["acknowledged_config_version"],
    ) == ("ready", "installation-candidate", "agent-beta", 4)
    assert installations["installation-active"]["state"] == "retired"
    assert installations["installation-active"]["active"] is False
    assert revoked == [
        ("installation-refresh-token", "refresh_token"),
        ("installation-access-token", "access_token"),
    ]
