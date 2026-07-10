from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest

from podium.server import PodiumServer
from podium.store import PodiumStore
from test_podium_conductor_channels_support import (
    activate_linear_installation,
    successful_project_label_transport,
)


async def request(
    port: int,
    method: str,
    path: str,
    body: object | bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    if isinstance(body, bytes):
        raw = body
    elif body is None:
        raw = b""
    else:
        if path in {"/api/v1/auth/register", "/api/v1/auth/login"} and isinstance(body, dict):
            body = {**body, "turnstile_token": "test-turnstile"}
        raw = json.dumps(body).encode()
    request_headers = {"Host": "127.0.0.1", "Content-Length": str(len(raw))}
    if body is not None and not isinstance(body, bytes):
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    writer.write(
        f"{method} {path} HTTP/1.1\r\n".encode()
        + b"".join(f"{key}: {value}\r\n".encode() for key, value in request_headers.items())
        + b"\r\n"
        + raw
    )
    await writer.drain()
    status_line = await reader.readline()
    status = int(status_line.decode().split(" ")[1])
    response_headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in {b"\r\n", b"\n", b""}:
            break
        key, value = line.decode().split(":", 1)
        response_headers[key.strip().lower()] = value.strip()
    response_body = await reader.readexactly(int(response_headers.get("content-length", "0")))
    writer.close()
    await writer.wait_closed()
    return status, response_headers, response_body


@pytest.mark.asyncio
async def test_full_onboarding_flow_reaches_complete(tmp_path) -> None:
    """
    Walk a workspace through the product onboarding order via HTTP:
    authorize -> select project -> enroll named Conductor -> bind repository ->
    runtime acknowledgement -> smoke check -> complete.
    """
    async def proxy_transport(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if str(payload.get("operationName") or "").startswith("ManagedProject"):
            return await successful_project_label_transport(request)
        return httpx.Response(
            200,
            json={
                "data": {
                    "teams": {"nodes": [{"id": "team-1", "name": "Engineering"}]},
                    "projects": {"nodes": [{"id": "proj-1", "name": "Podium"}]},
                }
            },
            request=request,
        )

    server = PodiumServer(
        data_dir=tmp_path,
        secret_key="test-secret",
        linear_graphql_transport=proxy_transport,
    )
    await server.start(port=0)
    try:
        port = server.port
        assert port is not None

        # Establish a session; the workspace is derived from the user.
        _, reg_headers, reg_body = await request(
            port, "POST", "/api/v1/auth/register",
            {"email": "flow@example.com", "password": "password123"},
        )
        cookie = (reg_headers.get("set-cookie") or "").split(";", 1)[0]
        ws = json.loads(reg_body)["user"]["id"]
        await activate_linear_installation(
            server.app,
            ws,
            access_token="secret-linear-token",
            projects=[{"id": "proj-1", "name": "Podium", "slug_id": "POD"}],
        )
        auth = {"Cookie": cookie}

        # 1. Bootstrap - Linear is already connected in this fixture, so the
        #    derived linear_connect step is reconciled and the flow opens at
        #    scope_selection. No direct complete_step calls anywhere below.
        status, headers, body = await request(port, "GET", "/api/v1/bootstrap", headers=auth)
        assert status == 200
        boot = json.loads(body)
        assert boot["onboarding"]["current_step"] == "scope_selection"
        assert "linear_connect" in boot["onboarding"]["completed_steps"]
        assert b"secret-linear-token" not in body

        # 2. Discover and select a stable Linear project id.
        status, headers, body = await request(port, "GET", "/api/v1/linear/projects", headers=auth)
        assert status == 200
        scope_data = json.loads(body)
        assert scope_data["projects"][0]["id"] == "proj-1"
        assert b"secret-linear-token" not in body

        # 3. Persist the project selection. This is Podium scope and must not
        #    mutate Linear project membership.
        status, headers, body = await request(
            port,
            "PUT",
            "/api/v1/linear/projects",
            {"project_ids": ["proj-1"]},
            headers=auth,
        )
        assert status == 200
        assert json.loads(body)["projects"][0]["selected"] is True

        # 4. Reserve the named, unbound Conductor and generate its token.
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/runtime/enrollment-token",
            {"name": "Beethoven"},
            headers=auth,
        )
        assert status == 200
        token_payload = json.loads(body)
        token = token_payload["enrollment_token"]
        assert token_payload["conductor"]["name"] == "Beethoven"
        assert token_payload["conductor"]["binding"] is None
        assert token
        assert "PODIUM_ENROLLMENT_TOKEN=" in token_payload["install_command"]
        assert f"--enrollment-token {token}" not in token_payload["install_command"]

        # 5. A real runtime (Conductor) enrolls purely over HTTP using the
        #    one-time token, then heartbeats. No in-process service calls: this
        #    alone must drive runtime_enrollment complete via derived-step
        #    reconciliation.
        status, headers, body = await request(
            port, "POST", "/api/v1/runtime/enroll",
            {
                "enrollment_token": token,
                "hostname": "runtime-host",
                "version": "1.0.0",
                "service_identity": "symphony-conductor-test",
                "data_root": "/srv/symphony/conductors/test",
            },
        )
        assert status == 200
        enrollment = json.loads(body)
        runtime_id = enrollment["runtime_id"]

        await server.app.state.podium.set_presence(runtime_id)

        status, headers, body = await request(port, "GET", "/api/v1/onboarding/runtime/status", headers=auth)
        assert status == 200
        assert json.loads(body)["online_count"] == 1

        status, headers, body = await request(port, "GET", "/api/v1/onboarding/status", headers=auth)
        assert status == 200
        assert "runtime_enrollment" in json.loads(body)["completed_steps"]

        # 6. Bind the selected project and repository, then acknowledge the
        #    exact versioned binding from the enrolled Conductor.
        repository = "https://github.com/acme/repo.git"
        status, headers, body = await request(
            port,
            "PUT",
            f"/api/v1/conductors/{runtime_id}/binding",
            {
                "linear_project_id": "proj-1",
                "repository": {"mode": "git_url", "value": repository},
            },
            headers=auth,
        )
        assert status == 202
        binding = json.loads(body)["binding"]

        status, headers, body = await request(
            port,
            "POST",
            "/api/v1/runtime/report",
            {
                "bindings": [
                    {
                        "instance_id": "project-instance",
                        "linear_project_id": "proj-1",
                        "project_slug": "POD",
                        "agent_app_user_id": "agent-alpha",
                        "binding_config_version": binding["config_version"],
                        "repo_source": {"type": "git", "value": repository},
                        "process_status": "stopped",
                    }
                ]
            },
            headers={"Authorization": f"Bearer {enrollment['runtime_token']}"},
        )
        assert status == 200
        assert json.loads(body)["binding_state"] == "ready"

        # 7. Publish the runtime config and seed successful reconciliation
        #    evidence produced by this test's Linear transport.
        status, headers, body = await request(
            port,
            "POST",
            "/api/v1/runtime/config",
            _runtime_config(enrollment["runtime_group_id"]),
            headers={"Authorization": f"Bearer {enrollment['runtime_token']}"},
        )
        assert status == 200
        installation = await server.app.state.podium.get_active_linear_installation(ws)
        assert installation is not None
        await server.app.state.podium.update_linear_installation_health(
            installation,
            reconciliation_state="healthy",
            last_reconciliation_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )

        # 8. Smoke check starts asynchronously and completes only after the
        #    authenticated Conductor reports every required runtime check.
        status, headers, body = await request(
            port, "POST", "/api/v1/onboarding/smoke-check", {}, headers=auth
        )
        assert status == 202
        smoke = json.loads(body)
        assert smoke["status"] == "running"
        runtime_smoke = smoke["conductors"][0]
        status, headers, body = await request(
            port,
            "POST",
            "/api/v1/runtime/smoke-check/result",
            {
                "smoke_check_id": smoke["smoke_check_id"],
                "binding_id": runtime_smoke["binding_id"],
                "status": "passed",
                "checks": [
                    {"name": name, "passed": True}
                    for name in (
                        "binding_identity",
                        "repository_readiness",
                        "linear_proxy_access",
                        "runtime_config_validity",
                        "project_label_state",
                    )
                ],
                "error_code": "",
                "sanitized_reason": "",
                "retryable": False,
                "action_required": "",
                "next_action": "",
            },
            headers={"Authorization": f"Bearer {enrollment['runtime_token']}"},
        )
        assert status == 200
        smoke = json.loads(body)
        assert smoke["status"] == "passed"
        assert smoke["recommendations"] == []

        # 9. Final bootstrap - onboarding complete, reached over HTTP only
        status, headers, body = await request(port, "GET", "/api/v1/bootstrap", headers=auth)
        assert status == 200
        final = json.loads(body)
        assert final["onboarding"]["current_step"] == "complete"
        assert b"secret-linear-token" not in body
    finally:
        await server.stop()


def _runtime_config(runtime_group_id: str) -> dict[str, object]:
    return {
        "runtime_group_id": runtime_group_id,
        "version": 1,
        "managed_run_policy": {
            "policy_id": "onboarding-policy",
            "version": 1,
            "effective_at": "2026-07-10T00:00:00Z",
            "capacity": {"global": 3, "by_role": {"plan": 1, "work_item": 1, "verify": 1}},
        },
        "profiles": {
            role: {
                "name": role,
                "backend": "codex",
                "role": role,
                "settings": {"model": "gpt-5.3-codex"},
            }
            for role in ("plan", "work_item", "verify")
        },
    }


@pytest.mark.asyncio
async def test_onboarding_state_persists_across_server_restart() -> None:
    """Onboarding progress survives when server instances share the durable store."""
    store = PodiumStore()
    server1 = PodiumServer(secret_key="test-secret", store=store)
    await server1.start(port=0)
    try:
        _, reg_headers, reg_body = await request(
            server1.port, "POST", "/api/v1/auth/register",
            {"email": "persist@example.com", "password": "password123"},
        )
        cookie = (reg_headers.get("set-cookie") or "").split(";", 1)[0]
        await request(
            server1.port, "POST", "/api/v1/onboarding/repository",
            {"mode": "local_path", "value": "/srv/repo"},
            headers={"Cookie": cookie},
        )
    finally:
        await server1.stop()

    server2 = PodiumServer(secret_key="test-secret", store=store)
    await server2.start(port=0)
    try:
        # Log in again to obtain a fresh session for the same user.
        _, login_headers, _ = await request(
            server2.port, "POST", "/api/v1/auth/login",
            {"email": "persist@example.com", "password": "password123"},
        )
        cookie = (login_headers.get("set-cookie") or "").split(";", 1)[0]
        status, _, body = await request(
            server2.port, "GET", "/api/v1/onboarding/status",
            headers={"Cookie": cookie},
        )
        assert status == 200
        payload = json.loads(body)
        assert "repository_mapping" in payload["completed_steps"]
    finally:
        await server2.stop()
