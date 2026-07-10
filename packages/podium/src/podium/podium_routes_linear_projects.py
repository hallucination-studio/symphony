from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_linear_projects import LinearProjectSelectionError
from .podium_state import SecretDecryptionError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_project_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.get("/api/v1/linear/projects")
    async def list_linear_projects(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            projects = await state.linear_projects_public(str(user["id"]))
        except LinearProjectSelectionError as exc:
            return error_response(400, exc.code, exc.reason)
        except SecretDecryptionError:
            return error_response(500, "linear_installation_secret_unreadable", "Linear installation could not be decrypted")
        return JSONResponse({"projects": projects})

    @app.put("/api/v1/linear/projects")
    async def select_linear_projects(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        raw_ids = payload.get("project_ids") if isinstance(payload, dict) else None
        if not isinstance(raw_ids, list) or any(not isinstance(value, str) for value in raw_ids):
            return error_response(400, "invalid_linear_projects", "project_ids must be a list of strings")
        try:
            projects = await state.select_linear_projects(
                str(user["id"]),
                [value.strip() for value in raw_ids if value.strip()],
            )
        except LinearProjectSelectionError as exc:
            return error_response(400, exc.code, exc.reason)
        except SecretDecryptionError:
            return error_response(500, "linear_installation_secret_unreadable", "Linear installation could not be decrypted")
        return JSONResponse({"projects": projects})
