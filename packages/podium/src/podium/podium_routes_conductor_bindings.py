from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_project_bindings import ProjectBindingError
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
