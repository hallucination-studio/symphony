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
from podium.podium_routes_runtime_ops import register_runtime_ops_routes
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
