from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from conductor.podium_client import PodiumRuntimeClient
from podium.podium_routes_runtime_ops import register_runtime_ops_routes


class FakeRuntimeState:
    def __init__(self) -> None:
        self.runtime = {"id": "runtime-1", "runtime_group_id": "group-1"}
        self.command = {
            "id": 7,
            "runtime_id": "runtime-1",
            "command": {"type": "project.configure", "config_version": 2},
            "fencing_token": 3,
        }
        self.acks: list[dict[str, Any]] = []
        self.smoke_results: list[dict[str, Any]] = []
        self.store = SimpleNamespace()

    async def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        return self.runtime if authorization == "Bearer runtime-token" else None

    async def lease_runtime_command(self, runtime_id: str) -> dict[str, Any] | None:
        if runtime_id != self.runtime["id"]:
            return None
        command, self.command = self.command, None
        return command

    async def ack_runtime_command(
        self,
        runtime_id: str,
        command_id: int,
        fencing_token: int,
        *,
        status: str,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.acks.append(
            {
                "runtime_id": runtime_id,
                "command_id": command_id,
                "fencing_token": fencing_token,
                "status": status,
                "result": result or {},
            }
        )
        return {"id": command_id, "status": status, "result": result or {}}

    async def submit_smoke_check_result(
        self,
        runtime: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self.smoke_results.append({"runtime": runtime, "payload": payload})
        return {"status": payload["status"], "smoke_check_id": payload["smoke_check_id"]}


@pytest.fixture
def runtime_state() -> FakeRuntimeState:
    return FakeRuntimeState()


@pytest.fixture
def runtime_app(runtime_state: FakeRuntimeState) -> FastAPI:
    app = FastAPI()

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    register_runtime_ops_routes(
        app,
        state=runtime_state,
        require_user=require_user,
        error_response=error_response,
    )
    return app


@pytest.mark.anyio
async def test_runtime_command_routes_lease_and_ack(runtime_app: FastAPI, runtime_state: FakeRuntimeState) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        lease = await client.post(
            "/api/v1/runtime/commands/lease",
            headers={"Authorization": "Bearer runtime-token"},
        )
        assert lease.status_code == 200
        assert lease.json()["command"]["fencing_token"] == 3

        ack = await client.post(
            "/api/v1/runtime/commands/ack",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "command_id": 7,
                "fencing_token": 3,
                "status": "completed",
                "result": {"status": "applied"},
            },
        )
    assert ack.status_code == 200
    assert runtime_state.acks == [
        {
            "runtime_id": "runtime-1",
            "command_id": 7,
            "fencing_token": 3,
            "status": "completed",
            "result": {"status": "applied"},
        }
    ]


@pytest.mark.anyio
async def test_runtime_command_ack_rejects_invalid_fence(runtime_app: FastAPI, runtime_state: FakeRuntimeState) -> None:
    async def stale_ack(*_args: Any, **_kwargs: Any) -> dict[str, str]:
        return {"_ack_error": "stale_runtime_command_lease"}

    runtime_state.ack_runtime_command = stale_ack  # type: ignore[method-assign]
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/commands/ack",
            headers={"Authorization": "Bearer runtime-token"},
            json={"command_id": 7, "fencing_token": 2, "status": "completed"},
        )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "stale_runtime_command_lease"


@pytest.mark.anyio
async def test_runtime_command_ack_records_a_failed_smoke_result(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    smoke_result = {
        "smoke_check_id": "smoke-1",
        "binding_id": "binding-1",
        "status": "failed",
        "checks": [],
    }
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/commands/ack",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "command_id": 7,
                "fencing_token": 3,
                "status": "failed",
                "result": {"command_type": "smoke.check", "result": smoke_result},
            },
        )
    assert response.status_code == 200
    assert runtime_state.smoke_results == [{"runtime": runtime_state.runtime, "payload": smoke_result}]
    assert runtime_state.acks[-1]["result"]["podium_smoke"] == {
        "status": "failed",
        "smoke_check_id": "smoke-1",
    }


class FakePodiumService:
    def __init__(self) -> None:
        self.store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
            )
        )
        self.commands: list[dict[str, Any]] = []

    async def handle_podium_command(self, command: dict[str, Any], *, post_smoke_result: Any) -> dict[str, Any]:
        self.commands.append(command)
        return {"status": "applied", "instance_id": "instance-1"}


@pytest.mark.anyio
async def test_runtime_client_polls_and_acks_one_command() -> None:
    service = FakePodiumService()
    ack_payload: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/commands/lease"):
            return httpx.Response(
                200,
                json={
                    "command": {
                        "id": 9,
                        "fencing_token": 4,
                        "command": {"type": "project.configure"},
                    }
                },
            )
        assert request.url.path.endswith("/commands/ack")
        assert request.headers["authorization"] == "Bearer runtime-token"
        ack_payload.update(json.loads(request.content))
        assert ack_payload["status"] == "completed"
        return httpx.Response(200, json={"command": {"id": 9, "status": "completed"}})

    result = await PodiumRuntimeClient(service).poll_command_once(transport=httpx.MockTransport(handler))
    assert result["status"] == "handled"
    assert service.commands == [{"type": "project.configure"}]
    assert ack_payload["result"]["command_type"] == "project.configure"
