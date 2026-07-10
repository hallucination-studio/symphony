from __future__ import annotations

import secrets
import urllib.parse
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse

from .linear_constants import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE
from .linear_installation_acceptance import (
    LinearInstallationRejected,
    accepted_installation,
    exchange_authorization_code,
    fetch_installation_acceptance,
    invoke_hook,
    rejected_installation,
)
from .podium_linear_installations import LinearApplicationNotConfigured, LinearApplicationVersionConflict

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]

SUCCESS_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear connected</title></head>"
    "<body><h1>Linear connected</h1><p>Authorization succeeded. You can close this window.</p></body></html>"
)


def register_linear_oauth_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[..., Any] | None,
    linear_installation_fetch: Callable[..., Any] | None,
    linear_graphql_transport: Callable[[httpx.Request], httpx.Response] | None,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/linear/installations/oauth")
    async def start_linear_installation(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            config = await state.selected_linear_application(str(user["id"]))
        except (LinearApplicationNotConfigured, LinearApplicationVersionConflict) as exc:
            return error_response(400, str(exc), "Linear application is not configured")
        oauth_state = await state.create_linear_oauth_state(str(user["id"]), config)
        query = urllib.parse.urlencode(
            {
                "client_id": config["client_id"],
                "redirect_uri": config["callback_url"],
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
        callback_state = str(request.query_params.get("state") or "")
        code = str(request.query_params.get("code") or "")
        if not callback_state:
            return error_response(400, "missing_state", "Missing state parameter")
        if not code:
            return error_response(400, "missing_code", "Missing code parameter")
        state_record = await state.consume_linear_oauth_state(callback_state)
        if state_record is None:
            return error_response(400, "invalid_state", "Invalid or expired state parameter")
        config = await state.get_linear_application_config(str(state_record["application_config_id"]))
        if not _state_matches_config(state_record, config):
            return error_response(400, "stale_application_config", "OAuth application configuration changed")
        return await _complete_callback(
            state=state,
            user_id=str(state_record["workspace_id"]),
            code=code,
            config=config,
            linear_token_exchange=linear_token_exchange,
            linear_installation_fetch=linear_installation_fetch,
            linear_graphql_transport=linear_graphql_transport,
            error_response=error_response,
        )

    @app.get("/api/v1/linear/installations")
    async def linear_installations(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        user_id = str(user["id"])
        active = await state.get_active_linear_installation(user_id)
        candidate = await state.get_candidate_linear_installation(user_id)
        return JSONResponse(
            {
                "active": state.linear_installation_public(active),
                "candidate": state.linear_installation_public(candidate),
            }
        )


async def _complete_callback(
    *,
    state: Any,
    user_id: str,
    code: str,
    config: dict[str, Any],
    linear_token_exchange: Callable[..., Any] | None,
    linear_installation_fetch: Callable[..., Any] | None,
    linear_graphql_transport: Callable[[httpx.Request], httpx.Response] | None,
    error_response: ErrorResponse,
) -> Response:
    installation_id = f"linear_installation_{secrets.token_urlsafe(12)}"
    try:
        token = await _exchange(code, config, linear_token_exchange)
        acceptance = await _fetch(str(token.get("access_token") or ""), linear_installation_fetch, linear_graphql_transport)
        record = accepted_installation(
            user_id=user_id,
            application=config,
            token=token,
            acceptance=acceptance,
            installation_id=installation_id,
        )
        await state.validate_candidate_project_access(user_id, record)
    except LinearInstallationRejected as rejection:
        record = rejected_installation(
            user_id=user_id,
            application=config,
            installation_id=installation_id,
            rejection=rejection,
        )
        await state.save_linear_installation_record(record)
        return error_response(422, rejection.code, rejection.reason)
    active = await state.get_active_linear_installation(user_id)
    if active is not None:
        record.update({"state": "draining", "next_action": "drain_managed_runs", "action_required": "wait"})
    await state.save_linear_installation_record(record)
    if active is None:
        await state.activate_linear_installation(user_id, installation_id)
        await state.mark_linear_connected(user_id)
    return HTMLResponse(SUCCESS_HTML)


async def _exchange(
    code: str,
    config: dict[str, Any],
    hook: Callable[..., Any] | None,
) -> dict[str, Any]:
    result = await invoke_hook(hook, code, config) if hook is not None else await exchange_authorization_code(code, config)
    if not isinstance(result, dict):
        raise LinearInstallationRejected("linear_token_exchange_failed", "Linear token exchange returned invalid data")
    return result


async def _fetch(
    access_token: str,
    hook: Callable[..., Any] | None,
    transport: Callable[[httpx.Request], httpx.Response] | None,
) -> dict[str, Any]:
    result = await invoke_hook(hook, access_token) if hook is not None else await fetch_installation_acceptance(access_token, transport=transport)
    if not isinstance(result, dict):
        raise LinearInstallationRejected("linear_acceptance_query_failed", "Linear acceptance returned invalid data")
    return result


def _state_matches_config(record: dict[str, Any], config: dict[str, Any] | None) -> bool:
    return bool(
        config
        and str(config.get("user_id") or "") == str(record.get("workspace_id") or "")
        and int(config.get("version") or 0) == int(record.get("application_config_version") or 0)
    )
