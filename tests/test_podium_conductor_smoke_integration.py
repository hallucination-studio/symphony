from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from conductor.conductor_linear_direct import ProjectLabelLinearProxy
from conductor.conductor_models import ConductorSettings
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from conductor.podium_client import PodiumRuntimeClient
from podium.podium_shared import utc_now_iso
from test_podium_conductor_channels_support import (
    activate_linear_installation,
    enroll_conductor,
    make_app,
    register,
)


class LinearProjectFixture:
    def __init__(self) -> None:
        self.label_id = "managed-label-1"
        self.label_name = ""
        self.label_attached = False
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        operation = str(payload.get("operationName") or "")
        query = str(payload.get("query") or "")
        variables = payload.get("variables") if isinstance(payload.get("variables"), dict) else {}
        self.calls.append(
            {
                "operation": operation,
                "query": query,
                "authorization": request.headers.get("Authorization"),
            }
        )
        if operation == "ManagedProjectLabelLookup":
            data = {"projectLabels": {"nodes": []}}
        elif operation == "ManagedProjectLabelCreate":
            self.label_name = str(variables.get("name") or "")
            data = {
                "projectLabelCreate": {
                    "success": True,
                    "projectLabel": {"id": self.label_id, "name": self.label_name},
                }
            }
        elif operation == "ManagedProjectAddLabel":
            self.label_attached = True
            data = {"projectAddLabel": {"success": True}}
        elif "query ProjectLabelFindProject" in query:
            data = {
                "projects": {
                    "nodes": [{"id": "project-alpha", "slugId": "ALPHA", "name": "Alpha"}]
                }
            }
        elif "query ProjectLabels" in query:
            labels = (
                [{"id": self.label_id, "name": self.label_name}]
                if self.label_attached
                else []
            )
            data = {"project": {"id": "project-alpha", "labels": {"nodes": labels}}}
        else:
            raise AssertionError(f"unexpected Linear operation: {operation or query}")
        return httpx.Response(200, json={"data": data}, request=request)


def _runtime_config(version: int) -> dict[str, Any]:
    return {
        "version": version,
        "managed_run_policy": {
            "policy_id": "smoke-policy",
            "version": version,
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


def _conductor(tmp_path: Path, enrolled: dict[str, Any]) -> ConductorService:
    data_root = tmp_path / "conductor"
    store = ConductorStore(data_root)
    store.save_settings(
        ConductorSettings(
            podium_url="http://podium.test",
            podium_runtime_id=enrolled["runtime_id"],
            podium_runtime_token=enrolled["runtime_token"],
            podium_proxy_token=enrolled["proxy_token"],
            podium_ws_url=enrolled["websocket_url"],
            runtime_group_id=enrolled["runtime_group_id"],
            conductor_id=enrolled["runtime_id"],
            managed_mode=True,
        )
    )
    return ConductorService(store=store, data_root=data_root)


@pytest.mark.asyncio
async def test_podium_smoke_runs_through_real_conductor_and_linear_proxy(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "README.md").write_text("smoke fixture\n", encoding="utf-8")
    linear = LinearProjectFixture()
    app = make_app(
        data_dir=tmp_path / "podium",
        linear_graphql_transport=linear,
    )
    podium_transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=podium_transport, base_url="http://podium.test") as client:
        user_id = await register(client, "cross-role-smoke@example.com")
        await activate_linear_installation(
            app,
            user_id,
            access_token="oauth-installation-token",
            projects=[{"id": "project-alpha", "name": "Alpha", "slug_id": "ALPHA"}],
        )
        await app.state.podium.select_linear_projects(user_id, ["project-alpha"])
        enrolled = await enroll_conductor(client)
        conductor = _conductor(tmp_path, enrolled)
        runtime_client = PodiumRuntimeClient(conductor)

        await app.state.podium.set_presence(enrolled["runtime_id"])
        bound = await client.put(
            f"/api/v1/conductors/{enrolled['runtime_id']}/binding",
            json={
                "linear_project_id": "project-alpha",
                "repository": {"mode": "local_path", "value": str(repository)},
            },
        )
        assert bound.status_code == 202, bound.text
        project_row = await app.state.podium.store.next_runtime_command(enrolled["runtime_id"], after_id=0)
        assert project_row is not None
        assert project_row["command"]["type"] == "project.configure"
        configured = await runtime_client.handle_command(project_row["command"], transport=podium_transport)
        assert configured["status"] == "applied"

        config = await client.post(
            "/api/v1/runtime/config",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json=_runtime_config(1),
        )
        assert config.status_code == 200, config.text
        report = await conductor.post_podium_report(transport=podium_transport)
        assert report["status"] == "ok"
        assert report["binding_state"] == "ready"
        assert conductor._managed_run_runtime_config["version"] == 1

        installation = await app.state.podium.get_active_linear_installation(user_id)
        assert installation is not None
        await app.state.podium.update_linear_installation_health(
            installation,
            webhook_state="failed",
            reconciliation_state="healthy",
            last_reconciliation_at=utc_now_iso(),
        )
        binding = await app.state.podium.store.get_project_binding(bound.json()["binding"]["id"])
        assert binding is not None
        assert binding["state"] == "ready"
        assert binding["label_name"] == linear.label_name
        assert linear.label_attached is True

        conductor.project_label_proxy_factory = lambda _instance: ProjectLabelLinearProxy(
            endpoint="http://podium.test/api/v1/linear/graphql",
            api_key=enrolled["proxy_token"],
            transport=podium_transport,
        )
        started_response = await client.post("/api/v1/onboarding/smoke-check")
        assert started_response.status_code == 202, started_response.text
        started = started_response.json()
        smoke_row = await app.state.podium.store.next_runtime_command(
            enrolled["runtime_id"],
            after_id=int(project_row["id"]),
        )
        assert smoke_row is not None
        assert smoke_row["command"]["type"] == "smoke.check"
        assert smoke_row["command"]["expected_label"] == {
            "id": binding["label_id"],
            "name": binding["label_name"],
        }

        delivered = await runtime_client.handle_command(smoke_row["command"], transport=podium_transport)
        stored = await client.get("/api/v1/onboarding/smoke-check/result")
        progress = await client.get("/api/v1/onboarding/status")

    assert delivered["delivery_status"] == "delivered"
    assert delivered["result"]["status"] == "passed"
    assert all(check["passed"] for check in delivered["result"]["checks"])
    assert stored.json()["smoke_check_id"] == started["smoke_check_id"]
    assert stored.json()["status"] == "passed"
    assert "smoke_check" in progress.json()["completed_steps"]
    proxy_calls = [call for call in linear.calls if "query ProjectLabel" in call["query"]]
    assert len(proxy_calls) == 2
    assert {call["authorization"] for call in proxy_calls} == {"oauth-installation-token"}
