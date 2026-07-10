from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from test_podium_conductor_channels_support import (
    activate_linear_installation,
    agent_session_payload,
    bind_and_ack_conductor,
    make_app,
    queue_agent_session,
    register,
)


class ProjectLabelTransport:
    def __init__(self, *, existing_label_id: str = "", fail_operation: str = "") -> None:
        self.existing_label_id = existing_label_id
        self.fail_operation = fail_operation
        self.requests: list[dict[str, Any]] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        self.requests.append(payload)
        operation = str(payload.get("operationName") or "")
        if operation == self.fail_operation:
            return httpx.Response(
                200,
                json={"errors": [{"message": "Linear rejected the project label operation"}]},
                request=request,
            )
        variables = payload.get("variables") or {}
        if operation == "ManagedProjectLabelLookup":
            nodes = []
            if self.existing_label_id:
                nodes.append({"id": self.existing_label_id, "name": variables["name"]})
            data = {"projectLabels": {"nodes": nodes}}
        elif operation == "ManagedProjectLabelCreate":
            data = {
                "projectLabelCreate": {
                    "success": True,
                    "projectLabel": {"id": "label-created", "name": variables["name"]},
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
            raise AssertionError(f"unexpected Linear operation: {operation}")
        return httpx.Response(200, json={"data": data}, request=request)


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


@pytest.mark.asyncio
async def test_ready_binding_creates_and_attaches_exact_managed_project_label() -> None:
    transport = ProjectLabelTransport()
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrollment = await _issue_enrollment(client, name="Beethoven")
        enrolled = await _enroll(client, enrollment)

        report, pending = await bind_and_ack_conductor(app, client, user_id, enrolled)
        ready = await app.state.podium.store.get_project_binding(pending["id"])
        request_count = len(transport.requests)
        repeated = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [
                    {
                        "instance_id": "inst-a",
                        "linear_project_id": "project-alpha",
                        "project_slug": "ALPHA",
                        "agent_app_user_id": "agent-alpha",
                        "binding_config_version": pending["config_version"],
                        "repo_source": {"type": "local_path", "value": "/repo/a"},
                        "process_status": "stopped",
                    }
                ]
            },
        )

    expected_name = f"symphony:conductor/Beethoven-{enrollment['conductor']['public_id']}"
    assert report.status_code == 200
    assert ready["state"] == "ready"
    assert ready["label_id"] == "label-created"
    assert ready["label_name"] == expected_name
    assert [request["operationName"] for request in transport.requests] == [
        "ManagedProjectLabelLookup",
        "ManagedProjectLabelCreate",
        "ManagedProjectAddLabel",
    ]
    assert transport.requests[-1]["variables"] == {
        "projectId": "project-alpha",
        "labelId": "label-created",
    }
    assert repeated.status_code == 200
    assert len(transport.requests) == request_count


@pytest.mark.asyncio
async def test_ready_binding_reuses_existing_managed_project_label_by_exact_name() -> None:
    transport = ProjectLabelTransport(existing_label_id="label-existing")
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrollment = await _issue_enrollment(client, name="Mozart")
        enrolled = await _enroll(client, enrollment)

        report, pending = await bind_and_ack_conductor(app, client, user_id, enrolled)
        ready = await app.state.podium.store.get_project_binding(pending["id"])

    assert report.status_code == 200
    assert ready["label_id"] == "label-existing"
    assert [request["operationName"] for request in transport.requests] == [
        "ManagedProjectLabelLookup",
        "ManagedProjectAddLabel",
    ]


@pytest.mark.asyncio
async def test_project_label_failure_keeps_binding_unroutable_and_visible(caplog: pytest.LogCaptureFixture) -> None:
    transport = ProjectLabelTransport(fail_operation="ManagedProjectLabelCreate")
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrolled = await _enroll(client, await _issue_enrollment(client, name="Ravel"))

        report, pending = await bind_and_ack_conductor(app, client, user_id, enrolled)
        failed = await app.state.podium.store.get_project_binding(pending["id"])
        runtimes = await client.get("/api/v1/runtimes")

    assert report.status_code == 409
    assert report.json()["error"]["code"] == "linear_project_label_sync_failed"
    assert failed["state"] == "failed"
    assert failed["error_code"] == "linear_project_label_sync_failed"
    assert failed["sanitized_reason"] == "Linear project label operation failed"
    visible = runtimes.json()["conductors"][0]["bindings"][0]
    assert visible["error_code"] == "linear_project_label_sync_failed"
    assert visible["sanitized_reason"] == "Linear project label operation failed"
    assert "event=linear_project_label_sync_failed" in caplog.text
    assert "next_action=retry_project_binding_report" in caplog.text


@pytest.mark.asyncio
async def test_rename_conductor_updates_managed_label_and_preserves_public_id() -> None:
    transport = ProjectLabelTransport()
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrollment = await _issue_enrollment(client, name="Beethoven")
        enrolled = await _enroll(client, enrollment)
        _, pending = await bind_and_ack_conductor(app, client, user_id, enrolled)
        request_count = len(transport.requests)

        renamed = await client.patch(
            f"/api/v1/conductors/{enrolled['runtime_id']}",
            json={"name": "Mozart"},
        )
        repeated = await client.patch(
            f"/api/v1/conductors/{enrolled['runtime_id']}",
            json={"name": "Mozart"},
        )
        binding = await app.state.podium.store.get_project_binding(pending["id"])

    expected = f"symphony:conductor/Mozart-{enrollment['conductor']['public_id']}"
    assert renamed.status_code == 200
    assert renamed.json()["conductor"]["name"] == "Mozart"
    assert renamed.json()["conductor"]["public_id"] == enrollment["conductor"]["public_id"]
    assert binding["label_id"] == "label-created"
    assert binding["label_name"] == expected
    update = transport.requests[request_count]
    assert update["operationName"] == "ManagedProjectLabelUpdate"
    assert update["variables"] == {
        "labelId": "label-created",
        "name": expected,
    }
    assert repeated.status_code == 200
    assert len(transport.requests) == request_count + 1


@pytest.mark.asyncio
async def test_rename_conductor_rejects_case_insensitive_duplicate_name() -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await _prepare_workspace(client, app)
        first = await _issue_enrollment(client, name="Bach")
        await _issue_enrollment(client, name="Mozart")

        renamed = await client.patch(
            f"/api/v1/conductors/{first['conductor']['id']}",
            json={"name": "mozart"},
        )

    assert renamed.status_code == 409
    assert renamed.json()["error"]["code"] == "conductor_name_taken"


@pytest.mark.asyncio
async def test_rename_label_failure_preserves_working_binding_and_surfaces_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    transport = ProjectLabelTransport(fail_operation="ManagedProjectLabelUpdate")
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrollment = await _issue_enrollment(client, name="Ravel")
        enrolled = await _enroll(client, enrollment)
        _, pending = await bind_and_ack_conductor(app, client, user_id, enrolled)

        renamed = await client.patch(
            f"/api/v1/conductors/{enrolled['runtime_id']}",
            json={"name": "Mahler"},
        )
        conductor = await app.state.podium.store.get_runtime(enrolled["runtime_id"])
        binding = await app.state.podium.store.get_project_binding(pending["id"])

    original_label = f"symphony:conductor/Ravel-{enrollment['conductor']['public_id']}"
    assert renamed.status_code == 502
    assert renamed.json()["error"]["code"] == "linear_project_label_rename_failed"
    assert conductor["name"] == "Ravel"
    assert binding["state"] == "ready"
    assert binding["label_name"] == original_label
    assert binding["error_code"] == "linear_project_label_rename_failed"
    assert binding["sanitized_reason"] == "Linear project label rename failed"
    assert "event=linear_project_label_rename_failed" in caplog.text


@pytest.mark.asyncio
async def test_unbind_waits_for_runtime_ack_then_removes_managed_label(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO", logger="podium.podium_project_bindings")
    transport = ProjectLabelTransport()
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrolled = await _enroll(client, await _issue_enrollment(client, name="Bach"))
        _, ready = await bind_and_ack_conductor(app, client, user_id, enrolled)
        request_count = len(transport.requests)

        started = await client.delete(f"/api/v1/conductors/{enrolled['runtime_id']}/binding")
        blocked_intake = await queue_agent_session(
            app,
            agent_session_payload(
                workspace_id=user_id,
                project_slug="ALPHA",
                delegate_id="agent-alpha",
            ),
        )
        command = app.state.podium.store._load_map("runtime_commands.json")[enrolled["runtime_id"]][-1]["command"]
        acknowledged = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [],
                "unbound_binding_id": ready["id"],
                "unbound_config_version": ready["config_version"] + 1,
            },
        )
        repeated = await client.delete(f"/api/v1/conductors/{enrolled['runtime_id']}/binding")
        binding = await app.state.podium.store.get_project_binding(ready["id"])
        runtimes = await client.get("/api/v1/runtimes")

    assert started.status_code == 202
    assert started.json()["binding"]["state"] == "pending_unbind"
    assert blocked_intake.json()["queued"] == 0
    assert command == {
        "type": "project.unconfigure",
        "binding_id": ready["id"],
        "config_version": ready["config_version"] + 1,
        "delete_repository": False,
    }
    assert acknowledged.status_code == 200
    assert acknowledged.json()["binding_state"] == "unbound"
    assert binding["active"] is False
    assert binding["state"] == "unbound"
    assert [request["operationName"] for request in transport.requests[request_count:]] == [
        "ManagedProjectRemoveLabel",
        "ManagedProjectLabelDelete",
    ]
    assert repeated.status_code == 200
    assert runtimes.json()["conductors"][0]["bindings"] == []
    assert "event=project_unbind_requested" in caplog.text
    assert "event=project_unbound" in caplog.text


@pytest.mark.asyncio
async def test_unbind_rejects_active_managed_run_dispatch(caplog: pytest.LogCaptureFixture) -> None:
    app = make_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrolled = await _enroll(client, await _issue_enrollment(client, name="Chopin"))
        _, ready = await bind_and_ack_conductor(app, client, user_id, enrolled)
        queued = await queue_agent_session(
            app,
            agent_session_payload(
                workspace_id=user_id,
                project_slug="ALPHA",
                delegate_id="agent-alpha",
            ),
        )

        rejected = await client.delete(f"/api/v1/conductors/{enrolled['runtime_id']}/binding")
        binding = await app.state.podium.store.get_project_binding(ready["id"])

    assert queued.json()["queued"] == 1
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "managed_runs_active"
    assert binding["state"] == "ready"
    assert "event=project_unbind_blocked" in caplog.text


@pytest.mark.asyncio
async def test_unbind_label_failure_remains_unroutable_and_visible(caplog: pytest.LogCaptureFixture) -> None:
    transport = ProjectLabelTransport(fail_operation="ManagedProjectRemoveLabel")
    app = make_app(linear_graphql_transport=transport)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        user_id = await _prepare_workspace(client, app)
        enrolled = await _enroll(client, await _issue_enrollment(client, name="Debussy"))
        _, ready = await bind_and_ack_conductor(app, client, user_id, enrolled)
        await client.delete(f"/api/v1/conductors/{enrolled['runtime_id']}/binding")

        acknowledged = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={
                "bindings": [],
                "unbound_binding_id": ready["id"],
                "unbound_config_version": ready["config_version"] + 1,
            },
        )
        binding = await app.state.podium.store.get_project_binding(ready["id"])

    assert acknowledged.status_code == 409
    assert acknowledged.json()["error"]["code"] == "linear_project_label_remove_failed"
    assert binding["active"] is True
    assert binding["state"] == "pending_unbind"
    assert binding["error_code"] == "linear_project_label_remove_failed"
    assert binding["sanitized_reason"] == "Linear project label removal failed"
    assert "event=linear_project_label_remove_failed" in caplog.text
