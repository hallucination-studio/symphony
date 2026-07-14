from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from podium.podium_routes_conductor_bindings import register_conductor_binding_routes
from podium.podium_routes_core_onboarding import register_onboarding_routes
from podium.podium_routes_runtime_enrollment import (
    _register_onboarding_runtime_status_route,
    register_runtime_identity_routes,
)
from podium.podium_project_bindings import PodiumProjectBindingsMixin, ProjectBindingError
from podium.podium_runtime import PodiumRuntimeMixin
from podium.podium_state import PodiumStateBaseMixin
from podium.store._postgres_project_replacements import (
    PgProjectReplacementsMixin,
    _record_project_binding_failure_on,
)


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class BindingRouteState:
    def __init__(self, error_code: str = "") -> None:
        self.requests: list[dict[str, Any]] = []
        self.error_code = error_code

    async def bind_conductor_project(
        self,
        user_id: str,
        conductor_id: str,
        *,
        linear_project_id: str,
        repository: dict[str, Any],
    ) -> dict[str, Any]:
        if self.error_code:
            raise ProjectBindingError(self.error_code, "Project binding conflict")
        self.requests.append(
            {
                "user_id": user_id,
                "conductor_id": conductor_id,
                "linear_project_id": linear_project_id,
                "repository": repository,
            }
        )
        return {
            "id": "binding-1",
            "state": "pending_ack",
            "error_code": "",
            "sanitized_reason": "",
        }

    def binding_public(self, binding: dict[str, Any]) -> dict[str, Any]:
        return {**binding, "next_action": "wait_for_conductor_ack"}


def binding_app(state: BindingRouteState, *, authenticated: bool = True) -> FastAPI:
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str] | None:
        return {"id": "user-1"} if authenticated else None

    register_conductor_binding_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    return app


@pytest.mark.anyio
async def test_binding_route_accepts_only_the_exact_binding_body() -> None:
    state = BindingRouteState()
    transport = httpx.ASGITransport(app=binding_app(state))
    body = {
        "linear_project_id": "project-1",
        "repository": {
            "mode": "git_url",
            "value": "https://example.invalid/repo.git",
        },
    }

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        accepted = await client.put("/api/v1/conductors/conductor-1/binding", json=body)
        extra_top_level = await client.put(
            "/api/v1/conductors/conductor-1/binding",
            json={**body, "workspace_id": "must-not-be-accepted"},
        )
        extra_repository = await client.put(
            "/api/v1/conductors/conductor-1/binding",
            json={**body, "repository": {**body["repository"], "token": "must-not-be-accepted"}},
        )

    assert accepted.status_code == 202
    assert accepted.json()["binding"]["state"] == "pending_ack"
    assert state.requests == [
        {
            "user_id": "user-1",
            "conductor_id": "conductor-1",
            "linear_project_id": "project-1",
            "repository": body["repository"],
        }
    ]
    for response in (extra_top_level, extra_repository):
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_project_binding"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "error_code",
    ["conductor_already_bound", "linear_project_already_bound"],
)
async def test_binding_route_reports_uniqueness_conflicts(error_code: str) -> None:
    state = BindingRouteState(error_code)
    transport = httpx.ASGITransport(app=binding_app(state))

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put(
            "/api/v1/conductors/conductor-1/binding",
            json={
                "linear_project_id": "project-1",
                "repository": {"mode": "local_path", "value": "/srv/repo"},
            },
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == error_code


class OnboardingStore:
    def __init__(self) -> None:
        self.row: dict[str, Any] = {
            "completed_steps": [
                "linear_connect",
                "scope_selection",
                "runtime_enrollment",
                "repository_mapping",
            ],
            "metadata": {"repository": {"mode": "local_path", "value": "/stale"}},
        }
        self.selected = [
            {"linear_project_id": "project-1"},
            {"linear_project_id": "project-2"},
        ]
        self.bindings = [
            {
                "id": "binding-1",
                "linear_project_id": "project-1",
                "conductor_id": "conductor-1",
                "config_version": 1,
                "state": "ready",
                "active": True,
            },
            {
                "id": "binding-2",
                "linear_project_id": "project-2",
                "conductor_id": "conductor-2",
                "config_version": 1,
                "state": "pending_ack",
                "active": True,
            },
        ]
        self.conductors = [
            {"id": "conductor-1", "enrollment_state": "enrolled"},
            {"id": "conductor-2", "enrollment_state": "enrolled"},
        ]
        self.smoke_result: dict[str, Any] | None = None

    async def get_onboarding_state(self, _workspace_id: str) -> dict[str, Any]:
        return self.row

    async def save_onboarding_state(
        self,
        _workspace_id: str,
        completed_steps: list[str],
        metadata: dict[str, Any],
    ) -> None:
        self.row = {"completed_steps": completed_steps, "metadata": metadata}

    async def list_selected_linear_projects(self, _workspace_id: str) -> list[dict[str, Any]]:
        return self.selected

    async def list_project_bindings_for_user(self, _workspace_id: str) -> list[dict[str, Any]]:
        return self.bindings

    async def list_conductors_for_user(self, _workspace_id: str) -> list[dict[str, Any]]:
        return self.conductors

    async def get_smoke_result(self, _workspace_id: str) -> dict[str, Any] | None:
        return self.smoke_result


class OnboardingState(PodiumStateBaseMixin):
    def __init__(self) -> None:
        self.store = OnboardingStore()

    async def is_runtime_online(self, _runtime_id: str) -> bool:
        return True


@pytest.mark.anyio
async def test_repository_completion_requires_ready_bindings_for_every_selected_project() -> None:
    state = OnboardingState()

    pending = await state.onboarding_progress("user-1")

    assert pending["current_step"] == "repository_mapping"
    assert "repository_mapping" not in pending["completed_steps"]

    state.store.bindings[1]["state"] = "ready"
    ready = await state.onboarding_progress("user-1")

    assert "repository_mapping" in ready["completed_steps"]
    assert ready["current_step"] == "smoke_check"


@pytest.mark.anyio
async def test_runtime_completion_requires_one_conductor_for_each_missing_binding() -> None:
    state = OnboardingState()
    state.store.bindings = [state.store.bindings[0]]
    state.store.conductors = [state.store.conductors[0]]

    missing = await state.onboarding_progress("user-1")

    assert missing["current_step"] == "runtime_enrollment"
    assert "runtime_enrollment" not in missing["completed_steps"]
    assert "repository_mapping" not in missing["completed_steps"]

    state.store.conductors.append(
        {"id": "conductor-2", "enrollment_state": "enrolled"}
    )
    enough = await state.onboarding_progress("user-1")

    assert enough["current_step"] == "repository_mapping"
    assert "runtime_enrollment" in enough["completed_steps"]


@pytest.mark.anyio
async def test_adding_a_project_reopens_only_downstream_setup_work() -> None:
    state = OnboardingState()
    state.store.row["completed_steps"] = [
        "linear_connect",
        "scope_selection",
        "runtime_enrollment",
        "repository_mapping",
        "smoke_check",
    ]
    state.store.bindings[1]["state"] = "ready"
    state.store.selected.append({"linear_project_id": "project-3"})

    progress = await state.onboarding_progress("user-1")

    assert progress["current_step"] == "runtime_enrollment"
    assert progress["completed_steps"] == ["linear_connect", "scope_selection"]


@pytest.mark.anyio
async def test_adding_a_project_uses_spare_capacity_without_reopening_linear() -> None:
    state = OnboardingState()
    state.store.row["completed_steps"] = [
        "linear_connect",
        "scope_selection",
        "runtime_enrollment",
        "repository_mapping",
        "smoke_check",
    ]
    state.store.bindings[1]["state"] = "ready"
    state.store.selected.append({"linear_project_id": "project-3"})
    state.store.conductors.append(
        {"id": "conductor-3", "enrollment_state": "enrolled"}
    )

    progress = await state.onboarding_progress("user-1")

    assert progress["current_step"] == "repository_mapping"
    assert progress["completed_steps"] == [
        "linear_connect",
        "scope_selection",
        "runtime_enrollment",
    ]


@pytest.mark.anyio
async def test_smoke_completion_matches_current_binding_identity_and_version() -> None:
    state = OnboardingState()
    state.store.row["completed_steps"] = [
        "linear_connect",
        "scope_selection",
        "runtime_enrollment",
        "repository_mapping",
        "smoke_check",
    ]
    state.store.bindings[1]["state"] = "ready"
    state.store.smoke_result = {
        "status": "passed",
        "conductors": [
            {
                "linear_project_id": "project-1",
                "binding_id": "binding-1",
                "binding_config_version": 1,
            },
            {
                "linear_project_id": "project-2",
                "binding_id": "binding-2",
                "binding_config_version": 1,
            },
        ],
    }

    complete = await state.onboarding_progress("user-1")

    assert complete["current_step"] == "complete"

    state.store.bindings[1]["config_version"] = 2
    stale = await state.onboarding_progress("user-1")

    assert stale["current_step"] == "smoke_check"
    assert "smoke_check" not in stale["completed_steps"]


@pytest.mark.anyio
async def test_retired_onboarding_repository_route_and_state_mutation_are_absent() -> None:
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1", "email": "user@example.com"}

    register_onboarding_routes(
        app,
        state=object(),
        require_user=require_user,
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/onboarding/repository",
            json={"mode": "local_path", "value": "/tmp/repo"},
        )

    assert response.status_code == 404
    assert not hasattr(OnboardingState(), "save_onboarding_repository")


@pytest.mark.anyio
async def test_runtime_status_does_not_own_onboarding_completion() -> None:
    class RuntimeStatusStore:
        async def list_conductors_for_user(self, _workspace_id: str) -> list[dict[str, Any]]:
            return [{"id": "conductor-1", "enrollment_state": "enrolled"}]

    class RuntimeStatusState:
        def __init__(self) -> None:
            self.store = RuntimeStatusStore()
            self.marked = False

        async def runtime_presence_snapshot(self, _runtime_ids: list[str]) -> dict[str, Any]:
            return {"conductor-1": {"online": True}}

        async def has_pending_enrollment(self, _conductor_id: str) -> bool:
            return False

        async def mark_runtime_enrolled(self, _workspace_id: str) -> None:
            self.marked = True

    state = RuntimeStatusState()
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    _register_onboarding_runtime_status_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/onboarding/runtime/status")

    assert response.status_code == 200
    assert response.json()["online_count"] == 1
    assert state.marked is False


class RuntimeProjectionState(PodiumRuntimeMixin):
    def __init__(self, binding: dict[str, Any]) -> None:
        self.binding = binding
        self.store = RuntimeProjectionStore(binding)

    async def conductor_public(self, conductor: dict[str, Any]) -> dict[str, Any]:
        return dict(conductor)

    async def runtime_presence_snapshot(self, _runtime_ids: list[str]) -> dict[str, Any]:
        return {}


class RuntimeProjectionStore:
    def __init__(self, binding: dict[str, Any]) -> None:
        self.binding = binding

    async def list_conductors_for_user(self, _workspace_id: str) -> list[dict[str, Any]]:
        return [
            {
                "id": "conductor-1",
                "conductor_id": "conductor-1",
                "name": "Bach",
                "public_id": "k7m3p2",
                "enrollment_state": "enrolled",
                "hostname": "host-1",
                "label": "Bach",
                "version": "1.0.0",
                "service_identity": "symphony-conductor-k7m3p2",
                "data_root": "/tmp/conductor-1",
                "online": True,
            }
        ]

    async def list_project_bindings_for_conductor(self, _conductor_id: str) -> list[dict[str, Any]]:
        return [self.binding]

    async def get_metrics_snapshot(self, _conductor_id: str, _instance_id: str) -> None:
        return None

    async def get_runtime(self, _runtime_id: str) -> None:
        return None


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("state_name", "error_code", "reason", "next_action"),
    [
        ("pending_ack", "", "", "wait_for_conductor_ack"),
        ("ready", "", "", ""),
        (
            "failed",
            "project_config_apply_failed",
            "Conductor rejected project configuration",
            "retry_project_binding_report",
        ),
    ],
)
async def test_runtimes_projects_binding_state_for_refresh_recovery(
    state_name: str,
    error_code: str,
    reason: str,
    next_action: str,
) -> None:
    binding = {
        "id": "binding-1",
        "state": state_name,
        "error_code": error_code,
        "sanitized_reason": reason,
    }
    state = RuntimeProjectionState(binding)
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    register_runtime_identity_routes(
        app,
        state=state,
        require_user=require_user,
        podium_base_url="http://test",
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/runtimes")

    assert response.status_code == 200
    projected = response.json()["conductors"][0]["bindings"][0]
    assert projected["state"] == state_name
    assert projected["error_code"] == error_code
    assert projected["sanitized_reason"] == reason
    assert projected["next_action"] == next_action


class FailurePool:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def fetchrow(self, statement: str, *args: Any) -> None:
        self.calls.append((statement, args))
        return None


@pytest.mark.anyio
async def test_project_binding_failure_is_fenced_by_identity_state_and_config_version() -> None:
    connection = FailurePool()

    result = await _record_project_binding_failure_on(
        connection,
        "binding-1",
        conductor_id="conductor-1",
        expected_config_version=3,
        error_code="project_config_apply_failed",
        sanitized_reason="Conductor rejected project configuration",
        updated_at="2026-07-14T12:00:00Z",
    )

    assert result is None
    statement, args = connection.calls[0]
    assert "state = 'failed'" in statement
    assert "active = TRUE" in statement
    assert "state = 'pending_ack'" in statement
    assert "config_version = $3" in statement
    assert args[:5] == (
        "binding-1",
        "conductor-1",
        3,
        "project_config_apply_failed",
        "Conductor rejected project configuration",
    )


class AtomicFailureStore:
    def __init__(self) -> None:
        self.failure: dict[str, Any] | None = None

    async def ack_runtime_command(
        self,
        runtime_id: str,
        command_id: int,
        fencing_token: int,
        *,
        status: str,
        result: dict[str, Any] | None,
        project_binding_failure: dict[str, Any] | None,
    ) -> dict[str, Any]:
        self.failure = project_binding_failure
        return {
            "id": command_id,
            "runtime_id": runtime_id,
            "status": status,
            "fencing_token": fencing_token,
            "command": {
                "type": "project.configure",
                "binding_id": "binding-1",
                "config_version": 3,
            },
            "result": result or {},
            "_project_binding_failure": {
                "id": "binding-1",
                "instance_id": "instance-1",
                "linear_project_id": "project-1",
            },
        }


class AtomicFailureState(PodiumRuntimeMixin, PodiumProjectBindingsMixin):
    def __init__(self) -> None:
        self.store = AtomicFailureStore()


@pytest.mark.anyio
async def test_failed_project_configure_ack_logs_the_atomic_durable_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = AtomicFailureState()

    with caplog.at_level("ERROR", logger="podium.podium_project_bindings"):
        command = await state.ack_runtime_command(
            "conductor-1",
            7,
            4,
            status="failed",
            result={
                "error_code": "project_config_apply_failed",
                "sanitized_reason": "Authorization: Bearer live-token",
            },
        )

    assert state.store.failure is not None
    assert state.store.failure["error_code"] == "project_config_apply_failed"
    assert state.store.failure["sanitized_reason"] == "Authorization: [REDACTED]"
    assert state.store.failure["updated_at"]
    assert "_project_binding_failure" not in command
    assert "event=project_binding_failed" in caplog.text
    assert "conductor_id=conductor-1" in caplog.text
    assert "binding_id=binding-1" in caplog.text
    assert "config_version=3" in caplog.text
    assert "error_code=project_config_apply_failed" in caplog.text
    assert "sanitized_reason=Authorization:_[REDACTED]" in caplog.text
    assert "next_action=retry_project_binding_report" in caplog.text
