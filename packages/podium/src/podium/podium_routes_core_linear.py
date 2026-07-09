from __future__ import annotations

import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse

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


def register_linear_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None,
    linear_scope_fetch: Callable[[str, str], dict[str, Any]] | None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
    _register_linear_app_routes(app, state=state, require_user=require_user, error_response=error_response)
    _register_linear_oauth_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=linear_token_exchange,
        error_response=error_response,
    )
    _register_linear_scope_route(
        app,
        state=state,
        require_user=require_user,
        linear_scope_fetch=linear_scope_fetch,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )


async def resolve_linear_creds(
    state: Any, workspace_id: str, error_response: ErrorResponse
) -> tuple[str, str, str] | JSONResponse:
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


def _register_linear_app_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
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


def _register_linear_oauth_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/onboarding/linear/start")
    async def linear_start(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        creds = await resolve_linear_creds(state, workspace_id, error_response)
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
        return await _linear_callback_response(request, state, linear_token_exchange, error_response)


async def _linear_callback_response(
    request: Request,
    state: Any,
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None,
    error_response: ErrorResponse,
) -> Response:
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
    token = await _linear_oauth_token(state, workspace_id, code, callback_state, linear_token_exchange, error_response)
    if isinstance(token, JSONResponse):
        return token
    await _save_linear_oauth_token(state, workspace_id, token)
    return HTMLResponse(LINEAR_SUCCESS_HTML)


async def _linear_oauth_token(
    state: Any,
    workspace_id: str,
    code: str,
    callback_state: str,
    linear_token_exchange: Callable[[str, str], dict[str, Any]] | None,
    error_response: ErrorResponse,
) -> dict[str, Any] | JSONResponse:
    if linear_token_exchange is not None:
        return linear_token_exchange(code, callback_state)
    creds = await resolve_linear_creds(state, workspace_id, error_response)
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
    return resp.json()


async def _save_linear_oauth_token(state: Any, workspace_id: str, token: dict[str, Any]) -> None:
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


def _register_linear_scope_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_scope_fetch: Callable[[str, str], dict[str, Any]] | None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
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
        result = await _linear_scope_result(workspace_id, access_token, linear_scope_fetch, linear_graphql_transport)
        return JSONResponse({"teams": result.get("teams") or [], "projects": result.get("projects") or []})


async def _linear_scope_result(
    workspace_id: str,
    access_token: str,
    linear_scope_fetch: Callable[[str, str], dict[str, Any]] | None,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
) -> dict[str, Any]:
    if linear_scope_fetch is not None:
        return linear_scope_fetch(workspace_id, access_token)
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
    return {
        "teams": ((data.get("teams") or {}).get("nodes") if isinstance(data.get("teams"), dict) else []) or [],
        "projects": ((data.get("projects") or {}).get("nodes") if isinstance(data.get("projects"), dict) else []) or [],
    }
