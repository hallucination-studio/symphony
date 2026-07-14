from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .linear_token_service import LinearTokenUnavailable


RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_disconnect_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.delete("/api/v1/linear/installations/current")
    async def disconnect_linear_installation(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            result = await state.disconnect_linear_installation(str(user["id"]))
        except LinearTokenUnavailable as exc:
            if exc.code == "linear_disconnect_in_use":
                return JSONResponse(
                    {
                        "error": {
                            "code": exc.code,
                            "message": exc.reason,
                            "next_action": exc.next_action,
                        }
                    },
                    status_code=409,
                )
            return error_response(502, exc.code, exc.reason)
        return JSONResponse(result)

    @app.post("/api/v1/linear/installations/{installation_id}/revoke")
    async def retry_linear_revocation(installation_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            result = await state.retry_linear_revocation(str(user["id"]), installation_id)
        except LinearTokenUnavailable as exc:
            return error_response(409, exc.code, exc.reason)
        return JSONResponse(result)
