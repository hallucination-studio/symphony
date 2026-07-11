from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app


USER = {"id": "user-1", "email": "flow@example.com"}
ONBOARDING_STEPS = [
    "linear_connect",
    "scope_selection",
    "runtime_enrollment",
    "repository_mapping",
    "smoke_check",
]


def _app() -> tuple[Any, list[str]]:
    completed: list[str] = []
    selected = {"value": False}
    bound = {"value": False}
    runtime = {
        "id": "runtime-1",
        "conductor_id": "runtime-1",
        "user_id": USER["id"],
        "runtime_group_id": "group-1",
        "name": "Beethoven",
        "public_id": "public1",
        "enrollment_state": "pending",
        "runtime_token_hash": "",
        "proxy_token_hash": "",
        "disabled": False,
        "revoked": False,
        "created_at": "2026-07-11T00:00:00Z",
    }
    installation = {
        "id": "installation-1",
        "user_id": USER["id"],
        "active": True,
        "state": "ready",
        "actor": "app",
        "scope": ["read", "write", "app:assignable"],
        "expires_at": "2099-01-01T00:00:00Z",
        "linear_organization_id": "org-1",
        "app_user_id": "agent-alpha",
    }
    binding = {
        "id": "binding-1",
        "conductor_id": "runtime-1",
        "linear_project_id": "proj-1",
        "project_slug": "POD",
        "state": "pending_ack",
        "config_version": 1,
        "acknowledged_config_version": 0,
        "repo_source": {"type": "git", "value": "https://github.com/acme/repo.git"},
    }
    enrollment_tokens: dict[str, dict[str, Any]] = {}
    runtime_config: dict[str, Any] = {}

    def mark(step: str) -> None:
        if step not in completed:
            completed.append(step)

    async def get_runtime(runtime_id: str) -> dict[str, Any] | None:
        return dict(runtime) if runtime_id == runtime["id"] else None

    async def upsert_conductor(conductor: dict[str, Any]) -> None:
        runtime.update(conductor)

    async def list_conductors(user_id: str) -> list[dict[str, Any]]:
        return [dict(runtime)] if user_id == USER["id"] else []

    async def runtime_by_hash(token_hash: str, *, proxy: bool = False) -> dict[str, Any] | None:
        key = "proxy_token_hash" if proxy else "runtime_token_hash"
        return dict(runtime) if runtime[key] == token_hash else None

    async def save_enrollment(token_hash: str, **values: Any) -> None:
        enrollment_tokens[token_hash] = {**values, "used": False}

    async def consume_enrollment(token_hash: str) -> tuple[dict[str, Any] | None, str | None]:
        row = enrollment_tokens.get(token_hash)
        if row is None or row["used"]:
            return None, "invalid_enrollment_token" if row is None else "enrollment_token_used"
        row["used"] = True
        return dict(row), None

    async def has_pending(group_id: str) -> bool:
        return any(row["runtime_group_id"] == group_id and not row["used"] for row in enrollment_tokens.values())

    async def get_config(group_id: str) -> dict[str, Any] | None:
        return dict(runtime_config) if runtime_config.get("runtime_group_id") == group_id else None

    async def save_config(_group_id: str, config: dict[str, Any]) -> None:
        runtime_config.update(config)

    store = SimpleNamespace(
        get_runtime=get_runtime,
        upsert_conductor=upsert_conductor,
        list_conductors_for_user=list_conductors,
        get_runtime_by_token_hash=runtime_by_hash,
        save_enrollment_token=save_enrollment,
        consume_enrollment_token=consume_enrollment,
        has_pending_enrollment=has_pending,
        get_runtime_config=get_config,
        save_runtime_config=save_config,
    )
    app = create_app(
        secure_cookies=False,
        static_dir=None,
        secret_key="test-secret",
        store=store,
    )
    state = app.state.podium

    async def progress(_user_id: str) -> dict[str, Any]:
        ordered = [step for step in ONBOARDING_STEPS if step in completed]
        current = next((step for step in ONBOARDING_STEPS if step not in ordered), "complete")
        return {
            "current_step": current,
            "completed_steps": ordered,
            "next_action": None if current == "complete" else current,
        }

    async def mark_progress(step: str) -> dict[str, Any]:
        mark(step)
        return await progress(USER["id"])

    async def mark_linear_connected(_user_id: str) -> dict[str, Any]:
        return await mark_progress("linear_connect")

    async def projects(_user_id: str) -> list[dict[str, Any]]:
        return [
            {
                "id": "proj-1",
                "name": "Podium",
                "slug_id": "POD",
                "selected": selected["value"],
                "access_state": "ready",
            }
        ]

    async def select_projects(_user_id: str, project_ids: list[str]) -> list[dict[str, Any]]:
        assert project_ids == ["proj-1"]
        selected["value"] = True
        mark("scope_selection")
        return await projects(USER["id"])

    async def conductor_public(conductor: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": conductor["id"],
            "name": conductor["name"],
            "public_id": conductor["public_id"],
            "enrollment_state": conductor["enrollment_state"],
            "binding": binding if bound["value"] else None,
        }

    async def bind(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        bound["value"] = True
        return dict(binding)

    async def apply_report(_runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert payload["bindings"][0]["binding_config_version"] == 1
        mark("repository_mapping")
        return {"status": "ok", "bindings_upserted": 1, "binding_state": "ready"}

    async def submit_smoke(_runtime: dict[str, Any], _payload: dict[str, Any]) -> dict[str, Any]:
        mark("smoke_check")
        return {
            "smoke_check_id": "smoke-1",
            "status": "passed",
            "conductors": [{"runtime_id": "runtime-1", "status": "passed"}],
            "recommendations": [],
        }

    state.user_for_session = AsyncMock(return_value=USER)
    state.get_active_linear_installation = AsyncMock(return_value=installation)
    state.mark_linear_connected = mark_linear_connected
    state.onboarding_progress = progress
    state.linear_status = AsyncMock(return_value={"workspace_id": USER["id"], "state": "connected"})
    state.linear_projects_public = projects
    state.select_linear_projects = select_projects
    state.reserve_conductor = AsyncMock(return_value=runtime)
    state.conductor_public = conductor_public
    state.set_presence = AsyncMock()
    state.runtime_presence_snapshot = AsyncMock(return_value={"runtime-1": "2026-07-11T00:00:00Z"})
    state.mark_runtime_enrolled = lambda _user_id: mark_progress("runtime_enrollment")
    state.bind_conductor_project = bind
    state.apply_runtime_report = apply_report
    state.start_smoke_check = AsyncMock(
        return_value={
            "smoke_check_id": "smoke-1",
            "status": "running",
            "conductors": [
                {
                    "runtime_id": "runtime-1",
                    "binding_id": "binding-1",
                    "status": "running",
                }
            ],
        }
    )
    state.submit_smoke_check_result = submit_smoke
    return app, completed


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    )


def _runtime_config(runtime_group_id: str) -> dict[str, object]:
    return {
        "runtime_group_id": runtime_group_id,
        "version": 1,
        "managed_run_policy": {
            "policy_id": "onboarding-policy",
            "version": 1,
            "effective_at": "2026-07-10T00:00:00Z",
            "capacity": {
                "global": 3,
                "by_role": {"plan": 1, "work_item": 1, "verify": 1},
            },
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


async def _request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    body: object | None = None,
    *,
    runtime_token: str = "",
) -> httpx.Response:
    headers = (
        {"Authorization": f"Bearer {runtime_token}"}
        if runtime_token
        else {"Cookie": "podium_session=test-session"}
    )
    return await client.request(method, path, json=body, headers=headers)


@pytest.mark.asyncio
async def test_full_onboarding_http_routes_reach_complete() -> None:
    app, completed_steps = _app()
    async with _client(app) as client:
        bootstrap = await _request(client, "GET", "/api/v1/bootstrap")
        assert bootstrap.status_code == 200
        assert bootstrap.json()["onboarding"]["current_step"] == "scope_selection"

        projects = await _request(client, "GET", "/api/v1/linear/projects")
        assert projects.json()["projects"][0]["selected"] is False
        selected = await _request(
            client,
            "PUT",
            "/api/v1/linear/projects",
            {"project_ids": ["proj-1"]},
        )
        assert selected.json()["projects"][0]["selected"] is True

        token_response = await _request(
            client,
            "POST",
            "/api/v1/onboarding/runtime/enrollment-token",
            {"name": "Beethoven"},
        )
        token_payload = token_response.json()
        assert token_response.status_code == 200
        assert token_payload["conductor"]["name"] == "Beethoven"
        assert token_payload["conductor"]["binding"] is None
        assert "PODIUM_ENROLLMENT_TOKEN=" in token_payload["install_command"]

        enrolled = await client.post(
            "/api/v1/runtime/enroll",
            json={
                "enrollment_token": token_payload["enrollment_token"],
                "hostname": "runtime-host",
                "version": "1.0.0",
                "service_identity": "symphony-conductor-test",
                "data_root": "/srv/symphony/conductors/test",
            },
        )
        assert enrolled.status_code == 200
        enrollment = enrolled.json()
        await app.state.podium.set_presence(enrollment["runtime_id"])
        runtime_status = await _request(
            client,
            "GET",
            "/api/v1/onboarding/runtime/status",
        )
        assert runtime_status.json()["online_count"] == 1

        repository = "https://github.com/acme/repo.git"
        bound = await _request(
            client,
            "PUT",
            f"/api/v1/conductors/{enrollment['runtime_id']}/binding",
            {
                "linear_project_id": "proj-1",
                "repository": {"mode": "git_url", "value": repository},
            },
        )
        assert bound.status_code == 202
        binding = bound.json()["binding"]
        report = await _request(
            client,
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
            runtime_token=enrollment["runtime_token"],
        )
        assert report.status_code == 200
        assert report.json()["binding_state"] == "ready"

        config = await _request(
            client,
            "POST",
            "/api/v1/runtime/config",
            _runtime_config(enrollment["runtime_group_id"]),
            runtime_token=enrollment["runtime_token"],
        )
        assert config.status_code == 200

        smoke = await _request(client, "POST", "/api/v1/onboarding/smoke-check", {})
        assert smoke.status_code == 202
        smoke_result = await _request(
            client,
            "POST",
            "/api/v1/runtime/smoke-check/result",
            {
                "smoke_check_id": smoke.json()["smoke_check_id"],
                "binding_id": "binding-1",
                "status": "passed",
                "checks": [],
                "error_code": "",
                "sanitized_reason": "",
                "retryable": False,
                "action_required": "",
                "next_action": "",
            },
            runtime_token=enrollment["runtime_token"],
        )
        assert smoke_result.status_code == 200
        assert smoke_result.json()["status"] == "passed"

        final = await _request(client, "GET", "/api/v1/bootstrap")

    assert final.status_code == 200
    assert final.json()["onboarding"]["current_step"] == "complete"
    assert completed_steps == ONBOARDING_STEPS
    response_text = " ".join(
        (bootstrap.text, projects.text, selected.text, final.text)
    )
    assert "runtime_token_hash" not in response_text
    assert "proxy_token_hash" not in response_text
    datetime.fromisoformat(token_payload["expires_at"].replace("Z", "+00:00"))
