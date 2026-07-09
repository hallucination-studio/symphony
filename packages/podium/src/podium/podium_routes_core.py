from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_routes_core_auth import register_auth_routes
from .podium_routes_core_helpers import public_user
from .podium_routes_core_linear import LINEAR_AUTHORIZE_URL, LINEAR_DEFAULT_SCOPE, register_linear_routes
from .podium_routes_core_onboarding import register_onboarding_routes

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


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
    register_auth_routes(app, state=state, error_response=error_response)
    register_onboarding_routes(app, state=state, require_user=require_user, error_response=error_response)
    register_linear_routes(
        app,
        state=state,
        require_user=require_user,
        linear_token_exchange=linear_token_exchange,
        linear_scope_fetch=linear_scope_fetch,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )
