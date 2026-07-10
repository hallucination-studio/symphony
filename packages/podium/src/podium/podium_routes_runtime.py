from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_routes_runtime_enrollment import register_runtime_identity_routes
from .podium_routes_conductor_bindings import register_conductor_binding_routes
from .podium_routes_runtime_ops import register_runtime_ops_routes
from .podium_routes_runtime_proxy import register_linear_proxy_route
from .podium_routes_runtime_smoke import register_runtime_smoke_route
from .podium_routes_runtime_ws import register_runtime_ws_route

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_runtime_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    podium_base_url: str,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
    register_runtime_identity_routes(
        app,
        state=state,
        require_user=require_user,
        podium_base_url=podium_base_url,
        error_response=error_response,
    )
    register_conductor_binding_routes(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )
    register_runtime_ops_routes(app, state=state, require_user=require_user, error_response=error_response)
    register_runtime_smoke_route(app, state=state, error_response=error_response)
    register_runtime_ws_route(app, state=state)
    register_linear_proxy_route(
        app,
        state=state,
        linear_graphql_transport=linear_graphql_transport,
        error_response=error_response,
    )
