from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .linear_constants import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE
from .podium_routes_linear_application import register_linear_application_routes
from .podium_routes_linear_cutover import register_linear_cutover_route
from .podium_routes_linear_oauth import register_linear_oauth_routes
from .podium_routes_linear_projects import register_linear_project_routes

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    linear_token_exchange: Callable[..., Any] | None,
    linear_installation_fetch: Callable[..., Any] | None,
    linear_graphql_transport: Callable[[httpx.Request], httpx.Response] | None,
    error_response: ErrorResponse,
) -> None:
    register_linear_application_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    register_linear_oauth_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=linear_token_exchange,
        linear_installation_fetch=linear_installation_fetch,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )
    register_linear_project_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    register_linear_cutover_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )


__all__ = ["LINEAR_AUTHORIZE_URL", "LINEAR_DEFAULT_SCOPE", "register_linear_routes"]
