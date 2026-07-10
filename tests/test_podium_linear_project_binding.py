from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from test_podium_conductor_channels_support import activate_linear_installation, make_app, register


async def _prepare_workspace(client: httpx.AsyncClient, app: Any) -> str:
    user_id = await register(client, "binding-owner@example.com")
    await activate_linear_installation(app, user_id)
    await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
    return user_id


async def _issue_enrollment(
    client: httpx.AsyncClient,
    *,
    name: str | None = None,
) -> dict[str, Any]:
    payload = {"name": name} if name is not None else {}
    response = await client.post("/api/v1/onboarding/runtime/enrollment-token", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def _enroll(client: httpx.AsyncClient, enrollment: dict[str, Any]) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/runtime/enroll",
        json={
            "enrollment_token": enrollment["enrollment_token"],
            "hostname": "host-a",
            "version": "1.0.0",
            "data_root": "/srv/symphony/conductors/test",
            "service_identity": "symphony-conductor-test",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_named_conductor_identity_is_reserved_before_enrollment_and_unique() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _prepare_workspace(client, app)
        first = await _issue_enrollment(client, name="Beethoven")
        duplicate = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "beethoven"},
        )

    conductor = first["conductor"]
    assert conductor["name"] == "Beethoven"
    assert re.fullmatch(r"[a-z0-9]{6}", conductor["public_id"])
    assert conductor["enrollment_state"] == "pending"
    assert conductor["binding"] is None
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "conductor_name_taken"


@pytest.mark.asyncio
async def test_automatic_conductor_names_and_public_ids_are_unique() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _prepare_workspace(client, app)
        first = await _issue_enrollment(client)
        second = await _issue_enrollment(client)

    assert first["conductor"]["name"].lower() != second["conductor"]["name"].lower()
    assert first["conductor"]["public_id"] != second["conductor"]["public_id"]


@pytest.mark.asyncio
async def test_enrolled_conductor_stays_unbound_until_operator_assigns_project_and_repository(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _prepare_workspace(client, app)
        enrollment = await _issue_enrollment(client, name="Mozart")
        enrolled = await _enroll(client, enrollment)

        assert enrolled["runtime_id"] == enrollment["conductor"]["id"]
        assert enrolled["conductor"]["binding"] is None

        offline = await client.put(
            f"/api/v1/conductors/{enrolled['runtime_id']}/binding",
            json={
                "linear_project_id": "project-alpha",
                "repository": {"mode": "local_path", "value": str(repository)},
            },
        )
        await app.state.podium.set_presence(enrolled["runtime_id"])
        bound = await client.put(
            f"/api/v1/conductors/{enrolled['runtime_id']}/binding",
            json={
                "linear_project_id": "project-alpha",
                "repository": {"mode": "local_path", "value": str(repository)},
            },
        )

    assert offline.status_code == 409
    assert offline.json()["error"]["code"] == "conductor_offline"
    assert bound.status_code == 202
    binding = bound.json()["binding"]
    assert binding["linear_project_id"] == "project-alpha"
    assert binding["repository"] == {"mode": "local_path", "value": str(repository)}
    assert binding["state"] == "pending_ack"
    assert binding["config_version"] == 1
    assert binding["acknowledged_config_version"] == 0
    command = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]][-1]["command"]
    assert command["type"] == "project.configure"
    assert command["linear_project_id"] == "project-alpha"
    assert command["config_version"] == 1


@pytest.mark.asyncio
async def test_binding_ack_enforces_one_project_per_conductor_and_one_conductor_per_project(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _prepare_workspace(client, app)
        first = await _enroll(client, await _issue_enrollment(client, name="Bach"))
        second = await _enroll(client, await _issue_enrollment(client, name="Chopin"))
        await app.state.podium.set_presence(first["runtime_id"])
        await app.state.podium.set_presence(second["runtime_id"])

        binding_response = await client.put(
            f"/api/v1/conductors/{first['runtime_id']}/binding",
            json={
                "linear_project_id": "project-alpha",
                "repository": {"mode": "local_path", "value": str(repository)},
            },
        )
        binding = binding_response.json()["binding"]
        duplicate_project = await client.put(
            f"/api/v1/conductors/{second['runtime_id']}/binding",
            json={
                "linear_project_id": "project-alpha",
                "repository": {"mode": "local_path", "value": str(repository)},
            },
        )
        multiple_report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {first['runtime_token']}"},
            json={"bindings": [{"instance_id": "one"}, {"instance_id": "two"}]},
        )
        acknowledged = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {first['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "project-instance",
                        "linear_project_id": "project-alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "binding_config_version": binding["config_version"],
                        "repo_source": {"type": "local_path", "value": str(repository)},
                        "process_status": "stopped",
                    }
                ]
            },
        )
        runtimes = await client.get("/api/v1/runtimes")

    assert duplicate_project.status_code == 409
    assert duplicate_project.json()["error"]["code"] == "linear_project_already_bound"
    assert multiple_report.status_code == 409
    assert multiple_report.json()["error"]["code"] == "multiple_project_bindings"
    assert acknowledged.status_code == 200
    assert acknowledged.json()["binding_state"] == "ready"
    ready = runtimes.json()["conductors"][0]["bindings"][0]
    assert ready["state"] == "ready"
    assert ready["acknowledged_config_version"] == binding["config_version"]
