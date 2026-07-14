from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from conductor.conductor_api import ConductorApiServer
from podium.linear_reconciliation import BindingScanResult, LinearReconciler
from podium.linear_reconciliation_model import active_blocker_ids
from podium.podium_dispatch import PodiumDispatchMixin
from podium.podium_routes_runtime_proxy import _ready_proxy_binding_or_error
from podium.podium_routes_runtime_ops import (
    ManagedRunReportError,
    _MAX_RUNTIME_REPORT_BYTES,
    _managed_run_report,
    _normalize_gate_summary,
    register_runtime_ops_routes,
)
from podium.podium_smoke_checks import PodiumSmokeChecksMixin
from podium.store._postgres_dispatch import DISPATCH_INSERT_SQL, LEASE_DISPATCH_SQL, _dispatch_values
from podium.store._postgres_schema_statements import POSTGRES_SCHEMA_STATEMENTS


class FakeRuntimeState:
    def __init__(self) -> None:
        self.runtime = {"id": "runtime-1"}
        self.command = {
            "id": 7,
            "runtime_id": "runtime-1",
            "command": {"type": "project.configure", "config_version": 2},
            "fencing_token": 3,
        }
        self.acks: list[dict[str, Any]] = []
        self.smoke_results: list[dict[str, Any]] = []
        self.managed_run_views: list[tuple[str, dict[str, Any]]] = []
        self.report_payloads: list[dict[str, Any]] = []
        self.store = SimpleNamespace(save_managed_run_view=self.save_managed_run_view)

    async def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        return self.runtime if authorization == "Bearer runtime-token" else None

    async def apply_runtime_report(self, _runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.report_payloads.append(payload)
        return {
            "status": "ok",
            "bindings_upserted": 1,
            "binding_id": "binding-1",
            "binding_config_version": 1,
        }

    async def save_managed_run_view(self, runtime_id: str, view: dict[str, Any]) -> None:
        self.managed_run_views.append((runtime_id, view))

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
        return {
            "id": command_id,
            "status": status,
            "result": result or {},
            "command": {
                "type": "project.configure",
                "binding_id": "binding-1",
                "config_version": 2,
            },
        }

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


@pytest.mark.parametrize(
    "gate",
    [
        {"passed": True, "score": 2, "threshold": 3, "commands": {"passed": 1, "total": 1}, "failure_code": ""},
        {"passed": True, "score": 4, "threshold": 3, "commands": {"passed": 0, "total": 1}, "failure_code": ""},
        {"passed": True, "score": 4, "threshold": 3, "commands": {"passed": 1, "total": 1}, "failure_code": "codex_gate_failed"},
        {"passed": False, "score": 4, "threshold": 3, "commands": {"passed": 0, "total": 1}, "failure_code": "codex_gate_failed"},
        {"passed": False, "score": 4, "threshold": 3, "commands": {"passed": 2, "total": 1}, "failure_code": "verification_command_failed"},
    ],
)
def test_gate_summary_rejects_inconsistent_verdicts(gate: dict[str, Any]) -> None:
    value = {
        "passed": False,
        "score": 2,
        "threshold": 3,
        "plan_version": 1,
        "manifest_count": 0,
        "commands": {"passed": 0, "total": 1},
        "rubric": [],
        "provenance": [],
        "artifact_count": 0,
        "failure_code": "verification_command_failed",
    } | gate

    with pytest.raises(ManagedRunReportError):
        _normalize_gate_summary(value)


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


@pytest.mark.anyio
async def test_failed_project_configure_ack_is_forwarded_once(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    result = {
        "command_type": "project.configure",
        "status": "rejected",
        "reason": "project_config_apply_failed",
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
                "result": result,
            },
        )

    assert response.status_code == 200
    assert runtime_state.acks[-1] == {
        "runtime_id": "runtime-1",
        "command_id": 7,
        "fencing_token": 3,
        "status": "failed",
        "result": result,
    }


@pytest.mark.anyio
async def test_runtime_report_keeps_only_a_bound_sanitized_managed_run_view(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "managed_runs": {
                    "binding_id": "binding-1",
                    "binding_config_version": 1,
                    "runs": [
                        {
                            "run_id": "run-1",
                            "parent_issue_id": "parent-1",
                            "issue_identifier": "APP-1",
                            "state": "executing",
                            "active_work_item_id": "implement login",
                            "latest_reason": "authorization: Bearer live-token",
                            "plan_version": 2,
                            "backend_session_id": "thread-1",
                            "acceptance": {
                                "catalog": {
                                    "id": "catalog-1",
                                    "rubric": [{"id": "correctness", "weight": 2, "threshold": 3, "token": "catalog-secret"}],
                                },
                                "manifest_count": 1,
                                "manifest_refs": ["manifest://run-1/secret-path"],
                            },
                            "untrusted": {"access_token": "live-token"},
                            "work_items": [
                                {
                                    "work_item_id": "implement login",
                                    "state": "in_progress",
                                    "gate_status": "execute_started",
                                    "gate": {
                                        "passed": True,
                                        "score": 4,
                                        "threshold": 3,
                                        "plan_version": 2,
                                        "catalog": {
                                            "id": "catalog-1",
                                            "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}],
                                        },
                                        "manifest_count": 1,
                                        "commands": {"passed": 1, "total": 1, "output": "output-secret"},
                                        "rubric": [{"id": "correctness", "score": 4, "weight": 2, "finding": "rubric-secret"}],
                                        "provenance": [{"source": "codex", "attempt_id": "attempt-1", "token": "provenance-secret"}],
                                        "artifact_count": 1,
                                        "failure_code": "",
                                        "findings": ["finding-secret"],
                                    },
                                    "payload": {
                                        "title": "Implement endpoint",
                                        "objective": r'{"access_token":"part\"unit-secret","authorization":"Bearer second-secret","accessToken":"third-secret","client-secret":"fourth-secret"}',
                                        "files_likely_touched": ["src/api.py"],
                                        "secret": "live-token",
                                    },
                                }
                            ],
                        }
                    ],
                }
            },
        )

    assert response.status_code == 200
    assert runtime_state.managed_run_views == [
        (
            "runtime-1",
            {
                "binding_id": "binding-1",
                "binding_config_version": 1,
                "active_runs_total": 1,
                "runs": [
                    {
                        "run_id": "run-1",
                        "parent_issue_id": "parent-1",
                        "issue_identifier": "APP-1",
                        "state": "executing",
                        "active_work_item_id": "implement login",
                        "latest_reason": "authorization: [REDACTED]",
                        "plan_version": 2,
                        "backend_session_id": "thread-1",
                        "work_items": [
                            {
                                "work_item_id": "implement login",
                                "state": "in_progress",
                                "gate_status": "execute_started",
                                "gate": {
                                    "passed": True,
                                    "score": 4,
                                    "threshold": 3,
                                    "plan_version": 2,
                                    "catalog": {
                                        "id": "catalog-1",
                                        "rubric": [{"id": "correctness", "weight": 2, "threshold": 3}],
                                    },
                                    "manifest_count": 1,
                                    "commands": {"passed": 1, "total": 1},
                                    "rubric": [{"id": "correctness", "score": 4, "weight": 2}],
                                    "provenance": [{"source": "codex", "attempt_id": "attempt-1"}],
                                    "artifact_count": 1,
                                    "failure_code": "",
                                },
                                "payload": {
                                    "title": "Implement endpoint",
                                    "objective": "{access_token=[REDACTED],authorization=[REDACTED],accessToken=[REDACTED],client-secret=[REDACTED]}",
                                    "files_likely_touched": ["src/api.py"],
                                },
                            }
                        ],
                    }
                ],
            },
        )
    ]


@pytest.mark.anyio
async def test_runtime_report_rejects_a_stale_managed_run_binding(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "managed_runs": {
                    "binding_id": "binding-previous",
                    "binding_config_version": 1,
                    "runs": [],
                }
            },
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "stale_managed_run_binding"
    assert runtime_state.managed_run_views == []


@pytest.mark.anyio
async def test_runtime_report_accepts_an_empty_managed_run_view_while_unbound(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    async def unbound_report(_runtime_id: str, _payload: dict[str, Any]) -> dict[str, Any]:
        return {"status": "ok", "bindings_upserted": 0, "binding_state": "unbound"}

    runtime_state.apply_runtime_report = unbound_report  # type: ignore[method-assign]
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={"managed_runs": {}},
        )

    assert response.status_code == 200
    assert runtime_state.managed_run_views == []


@pytest.mark.anyio
async def test_runtime_report_rejects_a_nonobject_managed_run_view(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={"managed_runs": []},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_managed_run_report"
    assert runtime_state.managed_run_views == []


@pytest.mark.anyio
async def test_runtime_report_rejects_nonstring_visible_fields(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "managed_runs": {
                    "binding_id": "binding-1",
                    "binding_config_version": 1,
                    "runs": [
                        {
                            "run_id": "run-1",
                            "parent_issue_id": "parent-1",
                            "issue_identifier": "APP-1",
                            "state": "executing",
                            "work_items": [
                                {
                                    "work_item_id": "task-1",
                                    "state": "in_progress",
                                    "gate": {
                                        "passed": True,
                                        "score": 4,
                                        "threshold": 3,
                                        "plan_version": 1,
                                        "catalog": {"id": {"secret": "unit-secret"}, "rubric": []},
                                        "manifest_count": 0,
                                        "commands": {"passed": 1, "total": 1},
                                        "rubric": [],
                                        "provenance": [],
                                        "artifact_count": 0,
                                        "failure_code": "",
                                    },
                                    "payload": {"title": "Implement endpoint", "files_likely_touched": []},
                                }
                            ],
                        }
                    ],
                }
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_managed_run_report"
    assert "unit-secret" not in response.text
    assert runtime_state.managed_run_views == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("provenance_source", "failure_code", "catalog_id"),
    [
        ("other-model", "", ""),
        ("codex", "unexpected_failure", ""),
        ("codex", "", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    ],
)
async def test_runtime_report_rejects_untrusted_gate_identity_fields(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
    provenance_source: str,
    failure_code: str,
    catalog_id: str,
) -> None:
    gate = {
        "passed": False,
        "score": 2,
        "threshold": 3,
        "plan_version": 1,
        "manifest_count": 0,
        "commands": {"passed": 0, "total": 1},
        "rubric": [],
        "provenance": [{"source": provenance_source, "attempt_id": "attempt-1"}],
        "artifact_count": 0,
        "failure_code": failure_code,
    }
    if catalog_id:
        gate["catalog"] = {"id": catalog_id, "rubric": []}
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "managed_runs": {
                    "binding_id": "binding-1",
                    "binding_config_version": 1,
                    "runs": [
                        {
                            "run_id": "run-1",
                            "parent_issue_id": "parent-1",
                            "issue_identifier": "APP-1",
                            "state": "executing",
                            "work_items": [
                                {
                                    "work_item_id": "task-1",
                                    "state": "in_progress",
                                    "gate": gate,
                                    "payload": {"title": "Implement endpoint", "files_likely_touched": []},
                                }
                            ],
                        }
                    ],
                }
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_managed_run_report"
    assert runtime_state.managed_run_views == []


@pytest.mark.anyio
async def test_runtime_report_redacts_escaped_and_prefixed_secret_fields(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    token_shaped_value = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "managed_runs": {
                    "binding_id": "binding-1",
                    "binding_config_version": 1,
                    "runs": [
                        {
                            "run_id": "run-1",
                            "parent_issue_id": "parent-1",
                            "issue_identifier": "APP-1",
                            "state": "executing",
                            "latest_reason": (
                                "Authorization: Token auth-secret, OPENAI_API_KEY=api-secret, "
                                f"GITHUB_TOKEN=github-secret, MY_ACCESS_TOKEN=access-secret, bare {token_shaped_value}"
                            ),
                            "work_items": [
                                {
                                    "work_item_id": "task-1",
                                    "state": "in_progress",
                                    "payload": {
                                        "title": "Implement endpoint",
                                        "objective": (
                                            r'{"access\u005ftoken":"unicode-key-secret","client\u002dsecret":"unicode-client-secret","openai\\u005fapi\\u005fkey":"double-escaped-secret","github\\x5ftoken":"hex-escaped-secret"}'
                                            f" bare {token_shaped_value}"
                                        ),
                                        "files_likely_touched": [],
                                    },
                                }
                            ],
                        }
                    ],
                }
            },
        )

    assert response.status_code == 200
    saved_view = runtime_state.managed_run_views[0][1]
    for value in (
        "auth-secret",
        "api-secret",
        "github-secret",
        "access-secret",
        "unicode-key-secret",
        "unicode-client-secret",
        "double-escaped-secret",
        "hex-escaped-secret",
        token_shaped_value,
    ):
        assert value not in str(saved_view)
    assert saved_view["runs"][0]["latest_reason"] == (
        "Authorization: [REDACTED], OPENAI_API_KEY=[REDACTED], "
        "GITHUB_TOKEN=[REDACTED], MY_ACCESS_TOKEN=[REDACTED], bare [REDACTED]"
    )
    assert saved_view["runs"][0]["work_items"][0]["payload"]["objective"] == (
        "{access_token=[REDACTED],client-secret=[REDACTED],openai_api_key=[REDACTED],github_token=[REDACTED]} "
        "bare [REDACTED]"
    )


@pytest.mark.anyio
async def test_runtime_report_rejects_a_body_above_its_input_limit(
    runtime_app: FastAPI,
    runtime_state: FakeRuntimeState,
) -> None:
    transport = httpx.ASGITransport(app=runtime_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": "Bearer runtime-token"},
            json={"untrusted": "x" * _MAX_RUNTIME_REPORT_BYTES},
        )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "runtime_report_too_large"
    assert runtime_state.report_payloads == []


@pytest.mark.anyio
async def test_managed_runs_view_hides_a_snapshot_from_a_previous_binding() -> None:
    class Store:
        async def get_managed_run_view(self, _runtime_id: str) -> dict[str, Any]:
            return {
                "binding_id": "binding-previous",
                "binding_config_version": 1,
                "runs": [{"run_id": "run-previous", "state": "executing"}],
            }

    class State:
        store = Store()

        async def is_runtime_online(self, _runtime_id: str) -> bool:
            return True

    report = await _managed_run_report(
        State(),
        {"id": "runtime-1", "name": "Bach", "public_id": "abc123"},
        {
            "id": "binding-current",
            "config_version": 2,
            "linear_project_id": "project-1",
            "project_slug": "APP",
            "project_name": "App",
            "instance_id": "instance-1",
            "state": "ready",
        },
    )

    assert report["managed_runs"] == {}


class FakePodiumService:
    def __init__(self) -> None:
        self.store = SimpleNamespace(
            get_settings=lambda: SimpleNamespace(
                podium_url="https://podium.example",
                podium_runtime_token="runtime-token",
            )
        )
        self.commands: list[dict[str, Any]] = []

    async def handle_podium_command(self, command: dict[str, Any]) -> dict[str, Any]:
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

    result = await ConductorApiServer(service)._poll_command_once(transport=httpx.MockTransport(handler))
    assert result["status"] == "handled"
    assert service.commands == [{"type": "project.configure"}]
    assert ack_payload["result"]["command_type"] == "project.configure"


def _relation(issue_id: str, state_type: str, relation_type: str = "blocks") -> dict[str, Any]:
    return {
        "type": relation_type,
        "issue": {"id": issue_id, "state": {"type": state_type}},
        "relatedIssue": {"id": "parent-1", "state": {"type": "started"}},
    }


def _blocker_response(
    relations: list[dict[str, Any]],
    *,
    has_next_page: bool = False,
    end_cursor: str | None = None,
) -> dict[str, Any]:
    return {
        "issue": {
            "inverseRelations": {
                "nodes": relations,
                "pageInfo": {"hasNextPage": has_next_page, "endCursor": end_cursor},
            }
        }
    }


def _dispatch(*, blocked_by: list[str] | None = None, reason: str = "") -> dict[str, Any]:
    return {
        "dispatch_id": "dispatch-1",
        "project_binding_id": "binding-1",
        "user_id": "user-1",
        "issue_id": "parent-1",
        "issue_identifier": "APP-1",
        "issue_title": "Work",
        "issue_description": "",
        "linear_workspace_id": "user-1",
        "project_slug": "APP",
        "agent_app_user_id": "agent-1",
        "issue_delegate_id": "agent-1",
        "blocked_by": list(blocked_by or []),
        "status": "queued",
        "reason": reason,
        "fencing_token": 2,
        "created_at": "2026-07-12T00:00:00Z",
        "updated_at": "2026-07-12T00:00:00Z",
    }


class FakeBlockerStore:
    def __init__(self, dispatch: dict[str, Any]) -> None:
        self.dispatch = dispatch
        self.runtime = {"id": "runtime-1"}
        self.binding = {
            "id": "binding-1",
            "instance_id": "instance-1",
            "installation_id": "installation-1",
            "agent_app_user_id": "agent-1",
        }
        self.requeues: list[dict[str, Any]] = []
        self.refreshes: list[dict[str, Any]] = []

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        return self.runtime if runtime_id == self.runtime["id"] else None

    async def list_project_bindings_for_conductor(self, runtime_id: str) -> list[dict[str, Any]]:
        return [self.binding] if runtime_id == self.runtime["id"] else []

    async def lease_dispatch(self, _runtime_id: str, **_kwargs: Any) -> dict[str, Any] | None:
        if self.dispatch["status"] != "queued" or self.dispatch["blocked_by"]:
            return None
        if self.dispatch["reason"] == "linear_blocker_check_failed":
            return None
        self.dispatch.update(
            status="leased",
            leased_conductor_id="runtime-1",
            fencing_token=int(self.dispatch["fencing_token"]) + 1,
        )
        return dict(self.dispatch)

    async def get_project_binding(self, binding_id: str) -> dict[str, Any] | None:
        return self.binding if binding_id == self.binding["id"] else None

    async def list_dispatches_requiring_blocker_recheck(self, binding_id: str) -> list[dict[str, Any]]:
        if binding_id != self.binding["id"] or self.dispatch["status"] != "queued":
            return []
        if self.dispatch["blocked_by"] or self.dispatch["reason"] == "linear_blocker_check_failed":
            return [dict(self.dispatch)]
        return []

    async def update_dispatch_blockers(
        self,
        dispatch_id: str,
        blocker_ids: list[str],
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if dispatch_id != self.dispatch["dispatch_id"] or self.dispatch["status"] != "queued":
            return None
        self.dispatch.update(blocked_by=list(blocker_ids), reason=reason)
        self.refreshes.append(dict(self.dispatch))
        return dict(self.dispatch)

    async def requeue_dispatch_for_blockers(
        self,
        runtime_id: str,
        dispatch_id: str,
        fencing_token: int,
        blocker_ids: list[str],
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if (
            runtime_id != self.runtime["id"]
            or dispatch_id != self.dispatch["dispatch_id"]
            or fencing_token != self.dispatch["fencing_token"]
            or self.dispatch["status"] != "leased"
        ):
            return None
        self.dispatch.update(
            status="queued",
            leased_conductor_id=None,
            blocked_by=list(blocker_ids),
            reason=reason,
        )
        self.requeues.append(dict(self.dispatch))
        return dict(self.dispatch)


class FakeBlockerState(PodiumDispatchMixin):
    def __init__(self, dispatch: dict[str, Any], responses: list[dict[str, Any] | Exception]) -> None:
        self.store = FakeBlockerStore(dispatch)
        self.responses = list(responses)
        self.queries: list[dict[str, Any]] = []

    async def get_active_linear_installation(self, user_id: str) -> dict[str, str] | None:
        if user_id != "user-1":
            return None
        return {"id": "installation-1", "user_id": "user-1", "app_user_id": "agent-1"}

    async def linear_graphql_for_installation(
        self,
        _installation: dict[str, Any],
        *,
        query: str,
        variables: dict[str, Any],
        operation_name: str,
    ) -> dict[str, Any]:
        assert "SymphonyDispatchBlockers" in query
        assert operation_name == "SymphonyDispatchBlockers"
        self.queries.append(dict(variables))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_active_blocker_ids_exclude_terminal_and_unrelated_relations() -> None:
    issue = {
        "inverseRelations": {
            "nodes": [
                _relation("blocker-active", "started"),
                _relation("blocker-done", "completed"),
                _relation("blocker-canceled", "canceled"),
                _relation("blocker-duplicate", "duplicate"),
                _relation("related-issue", "started", "related"),
            ]
        }
    }

    assert active_blocker_ids(issue) == ["blocker-active"]


@pytest.mark.anyio
async def test_blocked_dispatch_is_rechecked_after_its_blocker_clears() -> None:
    state = FakeBlockerState(
        _dispatch(blocked_by=["blocker-1"], reason="active_linear_blockers"),
        [
            _blocker_response([_relation("blocker-1", "completed")]),
            _blocker_response([]),
        ],
    )
    installation = {"id": "installation-1", "user_id": "user-1", "app_user_id": "agent-1"}
    binding = {"id": "binding-1"}

    refreshed = await state.refresh_blocked_dispatches(installation, binding)
    leased = await state.lease_dispatch("runtime-1")

    assert refreshed == 1
    assert state.store.dispatch["blocked_by"] == []
    assert state.store.dispatch["reason"] == ""
    assert leased is not None
    assert leased["issue_id"] == "parent-1"


@pytest.mark.anyio
async def test_dispatch_lease_requeues_when_a_later_blocker_page_is_active() -> None:
    state = FakeBlockerState(
        _dispatch(),
        [
            _blocker_response([_relation("blocker-complete", "completed")], has_next_page=True, end_cursor="page-2"),
            _blocker_response([_relation("blocker-active", "started")]),
        ],
    )

    leased = await state.lease_dispatch("runtime-1")

    assert leased is None
    assert state.queries == [
        {"issueId": "parent-1", "after": None},
        {"issueId": "parent-1", "after": "page-2"},
    ]
    assert state.store.requeues[-1]["blocked_by"] == ["blocker-active"]
    assert state.store.requeues[-1]["reason"] == "active_linear_blockers"
    assert state.store.requeues[-1]["fencing_token"] == 3


@pytest.mark.anyio
@pytest.mark.parametrize(
    "response",
    [
        RuntimeError("network unavailable"),
        _blocker_response([], has_next_page=True),
    ],
)
async def test_dispatch_lease_fails_closed_when_the_live_blocker_check_is_invalid(
    response: dict[str, Any] | Exception,
) -> None:
    state = FakeBlockerState(_dispatch(), [response])

    leased = await state.lease_dispatch("runtime-1")

    assert leased is None
    assert state.store.requeues[-1]["blocked_by"] == []
    assert state.store.requeues[-1]["reason"] == "linear_blocker_check_failed"


@pytest.mark.anyio
async def test_dispatch_lease_fails_closed_when_blocker_pagination_repeats_a_cursor() -> None:
    state = FakeBlockerState(
        _dispatch(),
        [
            _blocker_response([], has_next_page=True, end_cursor="loop"),
            _blocker_response([], has_next_page=True, end_cursor="loop"),
        ],
    )

    leased = await state.lease_dispatch("runtime-1")

    assert leased is None
    assert state.store.requeues[-1]["reason"] == "linear_blocker_check_failed"


@pytest.mark.anyio
async def test_reconciliation_refreshes_blocked_dispatches_after_a_completed_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class State:
        def __init__(self) -> None:
            self.store = SimpleNamespace(get_linear_reconciliation_state=self.get_linear_reconciliation_state)
            self.refresh_calls: list[tuple[dict[str, Any], dict[str, Any]]] = []

        async def get_linear_reconciliation_state(self, _binding_id: str) -> None:
            return None

        async def refresh_blocked_dispatches(
            self,
            installation: dict[str, Any],
            binding: dict[str, Any],
        ) -> int:
            self.refresh_calls.append((installation, binding))
            return 0

    state = State()
    reconciler = LinearReconciler(state=state)

    async def completed_scan(*_args: Any, **_kwargs: Any) -> BindingScanResult:
        return BindingScanResult(queued=0, complete=True, expected_state={})

    monkeypatch.setattr(reconciler, "_scan_binding_pages", completed_scan)
    installation = {"id": "installation-1", "user_id": "user-1"}
    project = {"linear_project_id": "project-1"}
    binding = {"id": "binding-1"}

    assert await reconciler._reconcile_binding(installation, project, binding) == 0
    assert state.refresh_calls == [(installation, binding)]


def test_dispatch_blocker_ids_have_a_fresh_schema_and_insert_contract() -> None:
    schema = "\n".join(POSTGRES_SCHEMA_STATEMENTS)
    values = _dispatch_values(_dispatch(blocked_by=["blocker-1"]))

    assert "blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb" in schema
    assert "blocked_by" in DISPATCH_INSERT_SQL
    assert len(values) == 28
    assert json.loads(values[15]) == ["blocker-1"]
    assert "jsonb_array_length(blocked_by)" in LEASE_DISPATCH_SQL


@pytest.mark.anyio
async def test_proxy_authorizes_the_runtime_owning_its_ready_binding_without_a_group_table() -> None:
    binding = {
        "id": "binding-1",
        "conductor_id": "runtime-1",
        "user_id": "user-1",
        "state": "ready",
        "active": True,
        "linear_project_id": "project-1",
    }

    class Store:
        async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
            return [binding] if conductor_id == "runtime-1" else []

        async def list_selected_linear_projects(self, workspace_id: str) -> list[dict[str, str]]:
            return [{"linear_project_id": "project-1"}] if workspace_id == "user-1" else []

    class State:
        store = Store()

        async def record_proxy_audit(self, _event: dict[str, Any]) -> None:
            return None

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

    result = await _ready_proxy_binding_or_error(
        State(),
        {"id": "runtime-1", "user_id": "user-1"},
        error_response,
    )

    assert result == binding
    denied = await _ready_proxy_binding_or_error(
        State(),
        {"id": "runtime-1", "user_id": "other-workspace"},
        error_response,
    )
    assert isinstance(denied, JSONResponse)
    assert denied.status_code == 409
    assert json.loads(denied.body)["error"]["code"] == "runtime_project_binding_mismatch"


@pytest.mark.anyio
async def test_smoke_context_derives_the_group_alias_from_its_conductor() -> None:
    binding = {
        "id": "binding-1",
        "conductor_id": "conductor-1",
        "user_id": "user-1",
        "state": "ready",
        "active": True,
        "config_version": 1,
        "acknowledged_config_version": 1,
        "installation_id": "installation-1",
        "agent_app_user_id": "agent-1",
        "repo_source": {"type": "local_path", "value": "/repo"},
        "label_id": "label-1",
        "label_name": "symphony:conductor/Bach-abc123",
        "instance_id": "instance-1",
        "linear_project_id": "project-1",
        "project_slug": "example",
    }

    class Store:
        async def get_runtime(self, runtime_id: str) -> dict[str, str] | None:
            if runtime_id == "conductor-1":
                return {
                    "id": runtime_id,
                    "user_id": "user-1",
                    "enrollment_state": "enrolled",
                    "name": "Bach",
                    "public_id": "abc123",
                }
            return None

    class State:
        store = Store()

        async def is_runtime_online(self, runtime_id: str) -> bool:
            return runtime_id == "conductor-1"

    context = await PodiumSmokeChecksMixin._smoke_binding_context(
        State(),
        binding,
        {"id": "installation-1", "app_user_id": "agent-1"},
    )

    assert context["runtime_group_id"] == "group_conductor-1"
    assert context["_binding_ready"] is True

    binding["label_name"] = "symphony:conductor/Mozart-abc123"
    stale = await PodiumSmokeChecksMixin._smoke_binding_context(
        State(),
        binding,
        {"id": "installation-1", "app_user_id": "agent-1"},
    )

    assert stale["_binding_ready"] is False
