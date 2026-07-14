from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_onboarding_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    _register_onboarding_status_routes(app, state=state, require_user=require_user, error_response=error_response)
    _register_onboarding_repository_route(app, state=state, require_user=require_user, error_response=error_response)
    _register_onboarding_smoke_routes(app, state=state, require_user=require_user, error_response=error_response)


def _register_onboarding_status_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.get("/api/v1/onboarding/status")
    async def onboarding_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_active_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(await state.onboarding_progress(user_id))

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_active_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(
            {
                "session": {"workspace_id": user_id, "user_id": user_id, "email": str(user["email"])},
                "onboarding": await state.onboarding_progress(user_id),
                "linear": await state.linear_status(user_id),
            }
        )


def _register_onboarding_repository_route(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.post("/api/v1/onboarding/repository")
    async def onboarding_repository(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        mode = str(payload.get("mode") or "")
        value = str(payload.get("value") or "")
        if mode not in {"local_path", "git_url"}:
            return error_response(400, "invalid_mode", "mode must be local_path or git_url")
        validation_state = "valid"
        if mode == "git_url" and not value.startswith(("https://", "git@")):
            validation_state = "invalid"
        progress = await state.save_onboarding_repository(user_id, mode, value)
        return JSONResponse(
            {
                "onboarding": progress,
                "repository": {"mode": mode, "value": value, "validation_state": validation_state},
            }
        )


def _register_onboarding_smoke_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.post("/api/v1/onboarding/smoke-check")
    async def onboarding_smoke_check(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        result = await state.start_smoke_check(user_id)
        return JSONResponse(result, status_code=202 if result.get("status") == "running" else 200)

    @app.get("/api/v1/onboarding/smoke-check/result")
    async def onboarding_smoke_check_result(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        result = await state.get_smoke_result(user_id)
        if result is None:
            return error_response(404, "smoke_result_not_found", "No smoke result recorded")
        return JSONResponse(result)
