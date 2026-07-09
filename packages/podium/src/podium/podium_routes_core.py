from __future__ import annotations

import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse

from .podium_shared import utc_now_iso
from .podium_state import SecretDecryptionError


RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]

LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_DEFAULT_SCOPE = "read,write,app:assignable,app:mentionable"
LINEAR_SCOPE_QUERY = "query { teams { nodes { id name key } } projects { nodes { id name } } }"

LINEAR_SUCCESS_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>Linear connected</title></head>"
    "<body style=\"font-family: system-ui, sans-serif; text-align: center; padding: 3rem;\">"
    "<h1>Linear connected</h1>"
    "<p>Authorization succeeded. You can close this window.</p>"
    "<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 500);</script>"
    "</body></html>"
)


def register_core_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None,
    linear_scope_fetch: Callable[[str, str], dict[str, Any]] | None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
    async def resolve_linear_creds(workspace_id: str) -> tuple[str, str, str] | JSONResponse:
        user = await state.user_by_id(workspace_id)
        custom = user.get("linear_app") if isinstance(user, dict) else None
        if custom:
            try:
                client_secret = state.decrypt_secret(str(custom.get("client_secret_encrypted") or ""))
            except SecretDecryptionError:
                return error_response(400, "secret_decryption_failed", "Stored Linear app secret could not be decrypted")
            return (
                str(custom.get("client_id") or ""),
                client_secret,
                str(custom.get("redirect_uri") or "") or state.linear_redirect_uri,
            )
        return (state.linear_client_id, state.linear_client_secret, state.linear_redirect_uri)

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

    @app.get("/api/v1/onboarding/status")
    async def onboarding_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(await state.onboarding_progress(user_id))

    @app.post("/api/v1/onboarding/scope")
    async def onboarding_scope(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        user_id = str(user["id"])
        progress = await state.save_onboarding_scope(user_id, payload.get("teams"), payload.get("projects"))
        return JSONResponse({"onboarding": progress})

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

    @app.post("/api/v1/onboarding/smoke-check")
    async def onboarding_smoke_check(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        result = {
            "status": "passed",
            "checks": [{"name": "runtime_online", "passed": True}],
            "recommendations": [],
            "timestamp": utc_now_iso(),
        }
        user_id = str(user["id"])
        await state.set_smoke_result(user_id, result)
        return JSONResponse(result)

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

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        if await state.get_linear_installation(user_id) is not None:
            await state.mark_linear_connected(user_id)
        return JSONResponse(
            {
                "session": {"workspace_id": user_id, "user_id": user_id, "email": str(user["email"])},
                "onboarding": await state.onboarding_progress(user_id),
                "linear": await state.linear_status(user_id),
            }
        )

    @app.put("/api/v1/account/linear-app")
    async def put_linear_app(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not state.secret_key:
            return error_response(500, "encryption_unavailable", "Secret key is not configured")
        payload = await request.json()
        client_id = str(payload.get("client_id") or "").strip()
        client_secret = str(payload.get("client_secret") or "").strip()
        redirect_uri = str(payload.get("redirect_uri") or "").strip()
        if not client_id or not client_secret:
            return error_response(400, "invalid_linear_app", "client_id and client_secret are required")
        linear_app = {
            "client_id": client_id,
            "client_secret_encrypted": state.encrypt_secret(client_secret),
            "redirect_uri": redirect_uri,
        }
        await state.set_user_linear_app(str(user["id"]), linear_app)
        return JSONResponse({"linear_app": {"client_id": client_id, "redirect_uri": redirect_uri, "configured": True}})

    @app.delete("/api/v1/account/linear-app")
    async def delete_linear_app(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        await state.set_user_linear_app(str(user["id"]), None)
        return JSONResponse({"ok": True, "linear_app": None})

    @app.post("/api/v1/onboarding/linear/start")
    async def linear_start(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        creds = await resolve_linear_creds(workspace_id)
        if isinstance(creds, JSONResponse):
            return creds
        client_id, _client_secret, redirect_uri = creds
        if not client_id:
            return error_response(400, "linear_app_not_configured", "No Linear app is configured")
        oauth_state = await state.create_oauth_state(workspace_id)
        query = urllib.parse.urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": LINEAR_DEFAULT_SCOPE,
                "actor": "app",
                "state": oauth_state,
                "prompt": "consent",
            }
        )
        return JSONResponse({"authorization_url": f"{LINEAR_AUTHORIZE_URL}?{query}"})

    @app.get("/api/v1/linear/oauth/callback")
    async def linear_callback(request: Request) -> Response:
        callback_state = request.query_params.get("state") or ""
        code = request.query_params.get("code") or ""
        if not callback_state:
            return error_response(400, "missing_state", "Missing state parameter")
        if not code:
            return error_response(400, "missing_code", "Missing code parameter")
        workspace_id = await state.consume_oauth_state(callback_state)
        if not workspace_id:
            return error_response(400, "invalid_state", "Invalid or expired state parameter")
        if not state.secret_key:
            return error_response(500, "encryption_unavailable", "Encryption is not configured")
        if linear_token_exchange is not None:
            token = linear_token_exchange(code, callback_state)
        else:
            creds = await resolve_linear_creds(workspace_id)
            if isinstance(creds, JSONResponse):
                return creds
            client_id, client_secret, redirect_uri = creds
            async with httpx.AsyncClient(timeout=30, trust_env=False) as http_client:
                resp = await http_client.post(
                    LINEAR_TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "redirect_uri": redirect_uri,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            token = resp.json()
        access_token = str(token.get("access_token") or "")
        expires_in = token.get("expires_in")
        expires_at: str | None = None
        if isinstance(expires_in, (int, float)):
            expires_at = (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat().replace("+00:00", "Z")
        await state.save_linear_installation(
            workspace_id,
            {
                "workspace_id": workspace_id,
                "access_token": access_token,
                "scope": token.get("scope"),
                "actor": token.get("actor") or "app",
                "expires_at": expires_at,
            },
        )
        await state.mark_linear_connected(workspace_id)
        return HTMLResponse(LINEAR_SUCCESS_HTML)

    @app.get("/api/v1/onboarding/linear/scope")
    async def linear_scope(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        try:
            installation = await state.get_linear_installation(workspace_id)
        except SecretDecryptionError:
            return error_response(400, "secret_decryption_failed", "Stored Linear installation token could not be decrypted")
        if not installation:
            return error_response(400, "linear_installation_not_found", "No Linear installation for workspace")
        access_token = str(installation.get("access_token") or "")
        if linear_scope_fetch is not None:
            result = linear_scope_fetch(workspace_id, access_token)
        else:
            transport = httpx.MockTransport(linear_graphql_transport) if linear_graphql_transport else None
            async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as http_client:
                resp = await http_client.post(
                    LINEAR_GRAPHQL_URL,
                    json={"query": LINEAR_SCOPE_QUERY},
                    headers={"Authorization": access_token, "Content-Type": "application/json"},
                )
            body = resp.json()
            data = body.get("data") if isinstance(body, dict) else {}
            data = data or {}
            result = {
                "teams": ((data.get("teams") or {}).get("nodes") if isinstance(data.get("teams"), dict) else []) or [],
                "projects": ((data.get("projects") or {}).get("nodes") if isinstance(data.get("projects"), dict) else []) or [],
            }
        return JSONResponse({"teams": result.get("teams") or [], "projects": result.get("projects") or []})


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    linear_app = user.get("linear_app") if isinstance(user, dict) else None
    if linear_app:
        public_app: dict[str, Any] | None = {
            "client_id": str(linear_app.get("client_id") or ""),
            "redirect_uri": str(linear_app.get("redirect_uri") or ""),
            "configured": True,
        }
    else:
        public_app = None
    user_id = str(user["id"])
    return {"id": user_id, "email": str(user["email"]), "linear_app": public_app}
