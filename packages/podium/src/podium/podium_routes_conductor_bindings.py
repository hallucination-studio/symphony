from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_conductors import ConductorIdentityError
from .podium_project_bindings import ProjectBindingError
from .podium_project_replacements import ProjectReplacementError, replacement_public
from .podium_state import SecretDecryptionError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_conductor_binding_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    _register_conductor_rename_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    _register_conductor_bind_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    _register_conductor_unbind_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    _register_conductor_replacement_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )


def _register_conductor_rename_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.patch("/api/v1/conductors/{conductor_id}")
    async def rename_conductor(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        if not isinstance(payload, dict) or set(payload) != {"name"}:
            return error_response(400, "invalid_conductor_update", "Only name may be updated")
        try:
            conductor = await state.rename_conductor(
                str(user["id"]),
                conductor_id,
                str(payload.get("name") or ""),
            )
        except ConductorIdentityError as exc:
            statuses = {
                "conductor_not_found": 404,
                "conductor_name_taken": 409,
                "linear_project_label_rename_failed": 502,
            }
            return error_response(statuses.get(exc.code, 400), exc.code, exc.reason)
        return JSONResponse({"conductor": await state.conductor_public(conductor)})


def _register_conductor_bind_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.put("/api/v1/conductors/{conductor_id}/binding")
    async def bind_conductor(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        try:
            binding = await state.bind_conductor_project(
                str(user["id"]),
                conductor_id,
                linear_project_id=str(payload.get("linear_project_id") or ""),
                repository=payload.get("repository") if isinstance(payload.get("repository"), dict) else {},
            )
        except ProjectBindingError as exc:
            status = 404 if exc.code == "conductor_not_found" else 409
            if exc.code in {"invalid_repository", "linear_project_not_selected"}:
                status = 400
            return error_response(status, exc.code, exc.reason)
        except SecretDecryptionError:
            return error_response(500, "linear_installation_secret_unreadable", "Linear installation could not be decrypted")
        return JSONResponse({"binding": state.binding_public(binding)}, status_code=202)


def _register_conductor_unbind_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.delete("/api/v1/conductors/{conductor_id}/binding")
    async def unbind_conductor(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            binding, active = await state.begin_project_unbind(str(user["id"]), conductor_id)
        except ProjectBindingError as exc:
            statuses = {
                "conductor_not_found": 404,
                "project_binding_not_found": 404,
                "managed_runs_active": 409,
            }
            return error_response(statuses.get(exc.code, 409), exc.code, exc.reason)
        status_code = 202 if active else 200
        return JSONResponse({"binding": state.binding_public(binding)}, status_code=status_code)


def _register_conductor_replacement_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/conductors/{conductor_id}/binding-replacement")
    async def replace_conductor_binding(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        if not isinstance(payload, dict):
            return error_response(400, "invalid_binding_replacement", "Replacement body is required")
        try:
            replacement = await state.start_project_replacement(
                str(user["id"]),
                conductor_id,
                old_conductor_id=str(payload.get("replace_conductor_id") or ""),
                linear_project_id=str(payload.get("linear_project_id") or ""),
                repository=payload.get("repository") if isinstance(payload.get("repository"), dict) else {},
            )
        except (ProjectReplacementError, ProjectBindingError) as exc:
            statuses = {
                "conductor_not_found": 404,
                "replacement_binding_not_found": 404,
                "managed_runs_active": 409,
            }
            return error_response(statuses.get(exc.code, 409), exc.code, exc.reason)
        return JSONResponse({"replacement": replacement_public(replacement)}, status_code=202)

    @app.get("/api/v1/conductors/{conductor_id}/binding-replacement")
    async def get_conductor_replacement(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if await state.conductor_for_user(conductor_id, str(user["id"])) is None:
            return error_response(404, "conductor_not_found", "Conductor not found")
        replacement = await state.project_replacement_for_conductor(str(user["id"]), conductor_id)
        if replacement is None:
            return error_response(404, "binding_replacement_not_found", "Binding replacement not found")
        return JSONResponse({"replacement": replacement})
