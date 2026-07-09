from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from .podium_routes_core_helpers import public_user
from .podium_shared import utc_now_iso

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_auth_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    _register_auth_credential_routes(app, state=state, error_response=error_response)
    _register_auth_session_routes(app, state=state, error_response=error_response)


def _register_auth_credential_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/auth/register")
    async def register(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        if "@" not in email or len(password) < 8:
            return error_response(400, "invalid_credentials", "A valid email and password are required")
        if await state.user_by_email(email) is not None:
            return error_response(400, "email_already_registered", "Email is already registered")
        user_id = await state.next_user_id()
        user = await state.create_user(
            user_id,
            email=email,
            password_hash=state.password_hasher.hash(password),
            created_at=utc_now_iso(),
        )
        session_token = await state.create_session(user_id)
        json_response = JSONResponse({"user": public_user(user)})
        state.set_session_cookie(json_response, session_token)
        return json_response

    @app.post("/api/v1/auth/login")
    async def login(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        user = await state.user_by_email(email)
        if user is None:
            return error_response(401, "invalid_login", "Invalid email or password")
        try:
            ok = state.password_hasher.verify(str(user["password_hash"]), password)
        except Exception:
            ok = False
        if not ok:
            return error_response(401, "invalid_login", "Invalid email or password")
        session_token = await state.create_session(str(user["id"]))
        json_response = JSONResponse({"user": public_user(user)})
        state.set_session_cookie(json_response, session_token)
        return json_response


def _register_auth_session_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/auth/logout")
    async def logout(request: Request, response: Response) -> dict[str, str]:
        podium_session = request.cookies.get(state.session_cookie_name)
        if podium_session:
            await state.revoke_session(podium_session)
        response.delete_cookie(state.session_cookie_name)
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    async def me(request: Request) -> JSONResponse:
        podium_session = request.cookies.get(state.session_cookie_name)
        user = await state.user_for_session(podium_session or "")
        if user is None:
            if state.debug_auth:
                user = await state.ensure_debug_user()
                session_token = await state.create_session(str(user["id"]))
                json_response = JSONResponse({"user": public_user(user)})
                state.set_session_cookie(json_response, session_token)
                return json_response
            return error_response(401, "unauthorized", "Unauthorized")
        return JSONResponse({"user": public_user(user)})
