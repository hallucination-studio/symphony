from __future__ import annotations

import asyncio
import json

import pytest

from conductor.conductor_api import ConductorApiServer
from conductor.conductor_models import InstanceRecord


class PipelineOnlyService:
    def __init__(self) -> None:
        self.instance = InstanceRecord.create(
            id="inst-1",
            name="Pipeline Runtime",
            repo_source_type="local_path",
            repo_source_value="/tmp/repo",
            resolved_repo_path="/tmp/repo",
            instance_dir="/tmp/conductor/instances/inst-1",
            workspace_root="/tmp/conductor/instances/inst-1/workspace/repo",
            persistence_path="/tmp/conductor/instances/inst-1/state/performer.json",
            log_path="/tmp/conductor/instances/inst-1/logs/performer.log",
            http_port=8801,
            linear_project="AI",
            linear_filters={},
        )

    def list_instances(self):
        return [self.instance]

    async def get_instance_coordinated(self, _instance_id: str):
        return self.instance

    def create_instance(self, _request):
        return self.instance

    def update_instance(self, _instance_id: str, patch):
        _ = patch
        return self.instance


@pytest.mark.asyncio
async def test_conductor_api_does_not_expose_workflow_management_routes() -> None:
    server = ConductorApiServer(PipelineOnlyService())

    routes = [
        ("POST", "/api/instances/preview-workflow", {"name": "Alpha"}),
        ("GET", "/api/templates/workflow-profiles", {}),
        ("POST", "/api/instances/inst-1/generate-workflow", {}),
        ("POST", "/api/instances/inst-1/validate-workflow", {"workflow_content": "---\n"}),
    ]

    for method, path, body in routes:
        status, payload = await server._route(method, path, json.dumps(body).encode())

        assert status == 404, path
        assert isinstance(payload, dict)
        assert payload["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_conductor_api_does_not_expose_legacy_run_routes() -> None:
    server = ConductorApiServer(PipelineOnlyService())

    routes = [
        ("GET", "/api/runs", {}),
        ("GET", "/api/runs/run-1", {}),
        ("POST", "/api/runs/run-1/human-answered", {"child_issue_id": "child-1"}),
    ]

    for method, path, body in routes:
        status, payload = await server._route(method, path, json.dumps(body).encode())

        assert status == 404, path
        assert isinstance(payload, dict)
        assert payload["error"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_conductor_api_does_not_expose_legacy_ops_routes() -> None:
    server = ConductorApiServer(PipelineOnlyService())

    routes = [
        ("GET", "/api/dashboard", {}),
        ("GET", "/api/issues", {}),
        ("GET", "/api/issues/issue-1", {}),
        ("POST", "/api/issues/issue-1/pin", {}),
        ("DELETE", "/api/issues/issue-1/pin", {}),
        ("GET", "/api/traces", {}),
        ("GET", "/api/retention", {}),
        ("POST", "/api/retention/collect", {}),
    ]

    for method, path, body in routes:
        status, payload = await server._route(method, path, json.dumps(body).encode())

        assert status == 404, path
        assert isinstance(payload, dict)
        assert payload["error"]["code"] == "not_found"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body", "status"),
    [
        ("GET", "/api/instances", {}, 200),
        ("GET", "/api/instances/inst-1", {}, 200),
        (
            "POST",
            "/api/instances",
            {
                "name": "Pipeline Runtime",
                "repo_source_type": "local_path",
                "repo_source_value": "/tmp/repo",
                "linear_project": "AI",
                "linear_filters": {},
            },
            201,
        ),
        ("PATCH", "/api/instances/inst-1", {"name": "Renamed"}, 200),
    ],
)
async def test_conductor_instance_api_hides_workflow_runtime_fields(
    method: str, path: str, body: dict[str, object], status: int
) -> None:
    server = ConductorApiServer(PipelineOnlyService())

    actual_status, payload = await server._route(method, path, json.dumps(body).encode())

    assert actual_status == status
    assert isinstance(payload, dict)
    serialized = json.dumps(payload, sort_keys=True)
    assert "workflow_content" not in serialized
    assert "workflow_path" not in serialized
    assert "workflow_profile" not in serialized
    assert "workflow_inputs" not in serialized


@pytest.mark.asyncio
async def test_conductor_instance_api_rejects_workflow_content_patch_before_service() -> None:
    server = ConductorApiServer(PipelineOnlyService())

    status, payload = await server._route(
        "PATCH",
        "/api/instances/inst-1",
        json.dumps({"workflow_content": "---\nlegacy: true\n---\n"}).encode(),
    )

    assert status == 400
    assert isinstance(payload, dict)
    assert payload["error"]["code"] == "workflow_runtime_surface_removed"


@pytest.mark.asyncio
async def test_podium_poll_loop_syncs_runtime_config_before_leasing_dispatch(monkeypatch) -> None:
    calls: list[str] = []

    async def no_sleep(_delay: float) -> None:
        raise asyncio.CancelledError

    class Service:
        async def post_podium_report(self):
            calls.append("report")
            return {"status": "ok", "config": {"version": 1}}

        async def poll_podium_dispatch_once(self):
            calls.append("lease")
            return {"status": "idle"}

        async def coordinate_background_once(self):
            calls.append("coordinate")
            return {"status": "ok"}

        def update_podium_connection(self, *_args, **_kwargs):
            calls.append("connection")

    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    server = ConductorApiServer(Service())

    with pytest.raises(asyncio.CancelledError):
        await server._poll_podium_dispatches()

    assert calls[:2] == ["report", "lease"]
