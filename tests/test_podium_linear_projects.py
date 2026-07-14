from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from podium.podium_linear_projects import (
    LinearProjectSelectionError,
    PodiumLinearProjectsMixin,
)
from podium.podium_routes_core_onboarding import register_onboarding_routes
from podium.podium_routes_linear_projects import register_linear_project_routes
from podium.store._postgres_linear import PgLinearMixin
from podium.store._postgres_project_replacements import PgProjectReplacementsMixin
from podium.podium_project_binding_creation import build_project_binding


class FakeProjectStore:
    def __init__(self) -> None:
        self.selected: list[dict[str, Any]] = []
        self.bindings: list[dict[str, Any]] = []
        self.replacements: list[tuple[str, list[dict[str, Any]]]] = []

    async def list_selected_linear_projects(self, _user_id: str) -> list[dict[str, Any]]:
        return list(self.selected)

    async def list_project_bindings_for_user(self, _user_id: str) -> list[dict[str, Any]]:
        return list(self.bindings)

    async def replace_selected_linear_projects(
        self,
        user_id: str,
        projects: list[dict[str, Any]],
    ) -> list[str]:
        requested = {str(project["linear_project_id"]) for project in projects}
        blocked = sorted(
            str(binding["linear_project_id"])
            for binding in self.bindings
            if binding.get("active", True)
            and str(binding["linear_project_id"]) not in requested
        )
        if blocked:
            return blocked
        self.replacements.append((user_id, projects))
        self.selected = list(projects)
        return []


class ProjectState(PodiumLinearProjectsMixin):
    def __init__(self) -> None:
        self.store = FakeProjectStore()
        self.installation: dict[str, Any] | None = {
            "linear_organization_id": "organization-1",
            "projects": [
                {"id": "project-1", "name": "One", "slug_id": "one"},
                {"id": "project-2", "name": "Two", "slug_id": "two"},
            ],
        }
        self.marked_steps: list[tuple[str, str]] = []

    async def get_active_linear_installation(self, _user_id: str) -> dict[str, Any] | None:
        return self.installation

    async def _mark_onboarding(self, user_id: str, step: str) -> dict[str, Any]:
        self.marked_steps.append((user_id, step))
        return {}


class AsyncContext:
    def __init__(self, value: Any = None) -> None:
        self.value = value

    async def __aenter__(self) -> Any:
        return self.value

    async def __aexit__(self, *_args: object) -> None:
        return None


class SelectionConnection:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.events: list[str] = []

    def transaction(self) -> AsyncContext:
        return AsyncContext()

    async def fetch(self, statement: str, *_args: Any) -> list[dict[str, str]]:
        if "FROM linear_selected_projects" in statement:
            self.events.append("fetch:selected")
            return [
                {"linear_project_id": "project-1"},
                {"linear_project_id": "project-2"},
            ]
        if "FROM project_bindings" in statement:
            self.events.append("fetch:bindings")
            return [{"linear_project_id": "project-1"}]
        raise AssertionError(f"Unexpected query: {statement}")

    async def execute(self, statement: str, *args: Any) -> None:
        self.executed.append((statement, args))
        self.events.append(f"execute:{args[0] if args else ''}")


class SelectionPool:
    def __init__(self, connection: SelectionConnection) -> None:
        self.connection = connection

    def acquire(self) -> AsyncContext:
        return AsyncContext(self.connection)


class BindingConnection:
    def __init__(
        self,
        *,
        selected: bool = False,
        active_installation: bool = True,
    ) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.selected = selected
        self.active_installation = active_installation

    def transaction(self) -> AsyncContext:
        return AsyncContext()

    async def execute(self, statement: str, *args: Any) -> None:
        self.executed.append((statement, args))

    async def fetchrow(self, statement: str, *_args: Any) -> dict[str, Any] | None:
        if "FROM linear_selected_projects" in statement:
            return {"linear_project_id": "project-1"} if self.selected else None
        if "FROM linear_workspace_installations" in statement:
            return {"id": "installation-1"} if self.active_installation else None
        if statement.lstrip().startswith("INSERT INTO project_bindings"):
            raise AssertionError("unselected project reached binding insert")
        return None


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@pytest.mark.anyio
async def test_projects_public_projects_active_bindings_as_closed_bound_flag() -> None:
    state = ProjectState()
    state.store.selected = [{"linear_project_id": "project-1"}]
    state.store.bindings = [
        {"linear_project_id": "project-1", "active": True},
        {"linear_project_id": "project-2", "active": False},
    ]

    projects = await state.linear_projects_public("user-1")

    assert projects == [
        {
            "id": "project-1",
            "name": "One",
            "slug_id": "one",
            "selected": True,
            "access_state": "ready",
            "bound": True,
        },
        {
            "id": "project-2",
            "name": "Two",
            "slug_id": "two",
            "selected": False,
            "access_state": "ready",
            "bound": False,
        },
    ]


@pytest.mark.anyio
async def test_select_projects_rejects_removing_bound_project_without_mutation() -> None:
    state = ProjectState()
    state.store.selected = [
        {"linear_project_id": "project-1"},
        {"linear_project_id": "project-2"},
    ]
    state.store.bindings = [{"linear_project_id": "project-1", "active": True}]

    with pytest.raises(LinearProjectSelectionError) as raised:
        await state.select_linear_projects("user-1", ["project-2"])

    assert raised.value.code == "linear_project_bound"
    assert state.store.replacements == []
    assert state.marked_steps == []


@pytest.mark.anyio
async def test_select_projects_replaces_unbound_selection_and_marks_scope() -> None:
    state = ProjectState()

    projects = await state.select_linear_projects("user-1", ["project-2", "project-1"])

    assert [row["linear_project_id"] for row in state.store.replacements[0][1]] == [
        "project-1",
        "project-2",
    ]
    assert state.marked_steps == [("user-1", "scope_selection")]
    assert [project["id"] for project in projects if project["selected"]] == [
        "project-1",
        "project-2",
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("project_ids", "error_code"),
    [
        (["project-1", "project-1"], "duplicate_linear_project"),
        (["project-missing"], "linear_project_not_accessible"),
    ],
)
async def test_select_projects_rejects_duplicate_or_inaccessible_ids(
    project_ids: list[str],
    error_code: str,
) -> None:
    state = ProjectState()

    with pytest.raises(LinearProjectSelectionError) as raised:
        await state.select_linear_projects("user-1", project_ids)

    assert raised.value.code == error_code
    assert state.store.replacements == []
    assert state.marked_steps == []


@pytest.mark.anyio
async def test_project_selection_transaction_does_not_delete_bound_project() -> None:
    connection = SelectionConnection()
    store = PgLinearMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]

    blocked = await store.replace_selected_linear_projects(
        "user-1",
        [
            {
                "linear_organization_id": "organization-1",
                "linear_project_id": "project-2",
                "project_slug": "two",
                "project_name": "Two",
                "access_state": "ready",
            }
        ],
    )

    assert blocked == ["project-1"]
    assert connection.events[0] == "execute:linear-project-selection:user-1"
    assert not any("DELETE FROM linear_selected_projects" in sql for sql, _args in connection.executed)


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["save", "switch"])
async def test_reauthorization_transaction_rejects_bound_project_before_activation(
    operation: str,
) -> None:
    connection = SelectionConnection()
    store = PgLinearMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]
    selected_projects = [
        {
            "linear_organization_id": "organization-1",
            "linear_project_id": "project-2",
            "project_slug": "two",
            "project_name": "Two",
            "access_state": "ready",
        }
    ]

    if operation == "save":
        blocked = await store.save_workspace_installation(
            {"id": "installation-active", "user_id": "user-1"},
            reauthorized_projects=selected_projects,
        )
    else:
        blocked = await store.switch_workspace_installation(
            "user-1",
            "installation-candidate",
            "app-user-2",
            selected_projects,
        )

    assert blocked == ["project-1"]
    assert connection.events[0] == "execute:linear-project-selection:user-1"
    assert not any(
        "linear_workspace_installations" in sql or "DELETE FROM linear_selected_projects" in sql
        for sql, _args in connection.executed
    )


@pytest.mark.anyio
async def test_reauthorization_transaction_reloads_selection_after_lock() -> None:
    connection = SelectionConnection()
    store = PgLinearMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]
    accessible_projects = [
        {
            "linear_organization_id": "organization-1",
            "linear_project_id": project_id,
            "project_slug": project_id,
            "project_name": project_id,
            "access_state": "ready",
        }
        for project_id in ("project-1", "project-2")
    ]

    blocked = await store.switch_workspace_installation(
        "user-1",
        "installation-candidate",
        "app-user-2",
        accessible_projects,
    )

    assert blocked == []
    assert connection.events[:3] == [
        "execute:linear-project-selection:user-1",
        "fetch:selected",
        "fetch:bindings",
    ]
    inserted_project_ids = [
        str(args[2])
        for sql, args in connection.executed
        if "INSERT INTO linear_selected_projects" in sql
    ]
    assert inserted_project_ids == ["project-1", "project-2"]


@pytest.mark.anyio
async def test_disconnect_transaction_rechecks_active_bindings_before_deactivation() -> None:
    connection = SelectionConnection()
    store = PgLinearMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]

    disconnected, blocked = await store.disconnect_workspace_installation(
        "user-1",
        "installation-1",
    )

    assert disconnected is False
    assert blocked == ["project-1"]
    assert connection.events[0] == "execute:linear-project-selection:user-1"
    assert not any(
        "UPDATE linear_workspace_installations" in sql
        for sql, _args in connection.executed
    )


@pytest.mark.anyio
async def test_binding_transaction_rechecks_project_selection_after_lock() -> None:
    connection = BindingConnection()
    store = PgProjectReplacementsMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]
    binding = build_project_binding(
        "user-1",
        "conductor-1",
        project={
            "linear_project_id": "project-1",
            "project_name": "One",
            "project_slug": "one",
        },
        installation={"id": "installation-1", "app_user_id": "agent-1"},
        repository={"mode": "git_url", "value": "https://example.invalid/repo.git"},
        prior_bindings=[],
    )

    created, conflict = await store.create_project_binding(binding)

    assert created is None
    assert conflict == "linear_project_not_selected"
    assert any(
        args == ("linear-project-selection:user-1",)
        for _statement, args in connection.executed
    )


@pytest.mark.anyio
async def test_binding_transaction_rechecks_active_installation_after_lock() -> None:
    connection = BindingConnection(selected=True, active_installation=False)
    store = PgProjectReplacementsMixin()
    store.pool = SelectionPool(connection)  # type: ignore[attr-defined]
    binding = build_project_binding(
        "user-1",
        "conductor-1",
        project={
            "linear_project_id": "project-1",
            "project_name": "One",
            "project_slug": "one",
        },
        installation={"id": "installation-1", "app_user_id": "agent-1"},
        repository={"mode": "git_url", "value": "https://example.invalid/repo.git"},
        prior_bindings=[],
    )

    created, conflict = await store.create_project_binding(binding)

    assert created is None
    assert conflict == "linear_installation_required"


@pytest.mark.anyio
async def test_projects_route_requires_exact_non_empty_project_ids_body() -> None:
    state = ProjectState()
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    register_linear_project_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        extra = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["project-1"], "teams": []},
        )
        blank = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": [" "]},
        )

    assert extra.status_code == 400
    assert extra.json()["error"]["code"] == "invalid_linear_projects"
    assert blank.status_code == 400
    assert blank.json()["error"]["code"] == "invalid_linear_projects"


@pytest.mark.anyio
async def test_projects_route_reports_bound_removal_as_conflict() -> None:
    state = ProjectState()
    state.store.selected = [
        {"linear_project_id": "project-1"},
        {"linear_project_id": "project-2"},
    ]
    state.store.bindings = [{"linear_project_id": "project-1", "active": True}]
    app = FastAPI()

    async def require_user(_request: Request) -> dict[str, str]:
        return {"id": "user-1"}

    register_linear_project_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["project-2"]},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "linear_project_bound"


@pytest.mark.anyio
async def test_projects_routes_require_authentication() -> None:
    state = ProjectState()
    app = FastAPI()

    async def require_user(_request: Request) -> None:
        return None

    register_linear_project_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        listed = await client.get("/api/v1/linear/projects")
        selected = await client.put(
            "/api/v1/linear/projects",
            json={"project_ids": ["project-1"]},
        )

    assert listed.status_code == 401
    assert selected.status_code == 401


@pytest.mark.anyio
async def test_retired_onboarding_scope_route_is_absent() -> None:
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
            "/api/v1/onboarding/scope",
            json={"teams": [], "projects": ["project-1"]},
        )

    assert response.status_code == 404
