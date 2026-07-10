from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_linear_cutover import LinearCutoverError
from .podium_state import SecretDecryptionError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_cutover_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/linear/installations/cutover")
    async def advance_cutover(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            result = await state.advance_linear_installation_cutover(str(user["id"]))
        except LinearCutoverError as exc:
            return error_response(409, exc.code, exc.reason)
        except SecretDecryptionError:
            return error_response(500, "linear_installation_secret_unreadable", "Linear installation could not be decrypted")
        return JSONResponse(
            {
                "cutover_state": result["cutover_state"],
                "active": state.linear_installation_public(result.get("active")),
                "candidate": state.linear_installation_public(result.get("candidate")),
            }
        )
