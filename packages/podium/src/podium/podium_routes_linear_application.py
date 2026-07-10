from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_linear_installations import (
    LinearApplicationNotConfigured,
    LinearApplicationVersionConflict,
)
from .podium_state import SecretDecryptionError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_application_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.get("/api/v1/linear/application")
    async def get_linear_application(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            config = await state.selected_linear_application(str(user["id"]))
        except (LinearApplicationNotConfigured, LinearApplicationVersionConflict) as exc:
            return error_response(400, str(exc), "Linear application is not configured")
        except SecretDecryptionError:
            return error_response(
                500,
                "linear_application_secret_unreadable",
                "Stored Linear application credentials could not be decrypted",
            )
        return JSONResponse({"application": state.linear_application_public(config)})

    @app.put("/api/v1/linear/application")
    async def put_linear_application(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not state.secret_key:
            return error_response(500, "encryption_unavailable", "Encryption is not configured")
        payload = await request.json()
        unexpected = set(payload) - {"client_id", "client_secret"}
        if unexpected:
            return error_response(400, "invalid_linear_application", "Only client_id and client_secret are accepted")
        client_id = str(payload.get("client_id") or "").strip()
        client_secret = str(payload.get("client_secret") or "").strip()
        if not client_id or not client_secret:
            return error_response(
                400,
                "invalid_linear_application",
                "client_id and client_secret are required",
            )
        config = await state.stage_custom_linear_application(
            str(user["id"]),
            client_id=client_id,
            client_secret=client_secret,
        )
        return JSONResponse({"application": state.linear_application_public(config)})

    @app.post("/api/v1/linear/application/default")
    async def select_default_linear_application(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            config = await state.select_default_linear_application(str(user["id"]))
        except (LinearApplicationNotConfigured, LinearApplicationVersionConflict) as exc:
            return error_response(400, str(exc), "Default Linear application is not configured")
        return JSONResponse({"application": state.linear_application_public(config)})
