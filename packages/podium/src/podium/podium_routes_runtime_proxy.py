from __future__ import annotations

import json
import os
from typing import Any, Callable

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .podium_routes_runtime_helpers import linear_installation_actor_is_app, linear_payload_is_mutation
from .podium_shared import utc_now_iso
from .podium_state import SecretDecryptionError

ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_linear_proxy_route(
    app: FastAPI,
    *,
    state: Any,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/linear/graphql")
    async def linear_graphql(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        return await linear_graphql_response(
            state, request, authorization or "", linear_graphql_transport, error_response
        )


async def linear_graphql_response(
    state: Any,
    request: Request,
    authorization: str,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
    error_response: ErrorResponse,
) -> JSONResponse:
    runtime = await state.runtime_for_proxy_bearer(authorization)
    if runtime is None:
        await state.record_proxy_audit({"allowed": False, "reason": "unauthorized", "timestamp": utc_now_iso()})
        return error_response(401, "unauthorized", "Unauthorized")
    if runtime.get("disabled") or runtime.get("revoked"):
        await _audit_runtime_proxy_denial(state, runtime, "runtime_disabled")
        return error_response(401, "runtime_disabled", "Runtime is disabled")
    payload = await request.json()
    group_id = str(runtime.get("runtime_group_id") or "")
    group = await state.store.get_runtime_group(group_id) or {}
    workspace_id = str(group.get("linear_workspace_id") or "")
    installation = await _linear_installation_or_error(state, runtime, workspace_id, error_response)
    if isinstance(installation, JSONResponse):
        return installation
    token = _proxy_token_from_installation(installation)
    token_error = await _validate_proxy_token(state, runtime, workspace_id, payload, installation, token, error_response)
    if token_error is not None:
        return token_error
    upstream_token, token_source = _proxy_upstream_token(token)
    if not upstream_token:
        await _record_proxy_token_missing(state, runtime, payload, workspace_id)
        return error_response(400, "linear_app_token_required", "Linear proxy requests require an app actor installation token.")
    await _record_proxy_allowed(state, runtime, payload, workspace_id, token_source)
    return await _forward_linear_graphql(payload, upstream_token, linear_graphql_transport)


async def _audit_runtime_proxy_denial(state: Any, runtime: dict[str, Any], reason: str) -> None:
    await state.record_proxy_audit(
        {"runtime_id": runtime["id"], "allowed": False, "reason": reason, "timestamp": utc_now_iso()}
    )


async def _linear_installation_or_error(
    state: Any, runtime: dict[str, Any], workspace_id: str, error_response: ErrorResponse
) -> dict[str, Any] | None | JSONResponse:
    try:
        return await state.get_linear_installation(workspace_id)
    except SecretDecryptionError:
        await state.record_proxy_audit(
            {
                "runtime_id": runtime["id"],
                "allowed": False,
                "reason": "secret_decryption_failed",
                "timestamp": utc_now_iso(),
            }
        )
        return error_response(400, "secret_decryption_failed", "Stored Linear installation token could not be decrypted")


def _proxy_token_from_installation(installation: dict[str, Any] | None) -> tuple[str, str]:
    upstream_token = str((installation or {}).get("access_token") or "").strip()
    return upstream_token, "installation" if upstream_token else ""


async def _validate_proxy_token(
    state: Any,
    runtime: dict[str, Any],
    workspace_id: str,
    payload: dict[str, Any],
    installation: dict[str, Any] | None,
    token: tuple[str, str],
    error_response: ErrorResponse,
) -> JSONResponse | None:
    upstream_token, _token_source = token
    if not linear_payload_is_mutation(payload) or not upstream_token:
        return None
    if linear_installation_actor_is_app(installation):
        return None
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "allowed": False,
            "reason": "agent_actor_token_required",
            "operation_name": payload.get("operationName"),
            "workspace_id": workspace_id,
            "timestamp": utc_now_iso(),
        }
    )
    return error_response(
        400,
        "agent_actor_token_required",
        "Linear mutations authored by Symphony require an app actor installation token.",
    )


def _proxy_upstream_token(token: tuple[str, str]) -> tuple[str, str]:
    upstream_token, token_source = token
    if upstream_token:
        return upstream_token, token_source
    upstream_token = os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "").strip()
    return upstream_token, "app_environment" if upstream_token else ""


async def _record_proxy_token_missing(
    state: Any, runtime: dict[str, Any], payload: dict[str, Any], workspace_id: str
) -> None:
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "allowed": False,
            "reason": "linear_app_token_required",
            "operation_name": payload.get("operationName"),
            "workspace_id": workspace_id,
            "timestamp": utc_now_iso(),
        }
    )


async def _record_proxy_allowed(
    state: Any, runtime: dict[str, Any], payload: dict[str, Any], workspace_id: str, token_source: str
) -> None:
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "allowed": True,
            "operation_name": payload.get("operationName"),
            "workspace_id": workspace_id,
            "token_source": token_source,
            "timestamp": utc_now_iso(),
        }
    )


async def _forward_linear_graphql(
    payload: dict[str, Any],
    upstream_token: str,
    linear_graphql_transport: Callable[[httpx.Request], Any] | None,
) -> JSONResponse:
    upstream_endpoint = os.environ.get("PODIUM_LINEAR_ENDPOINT", "https://api.linear.app/graphql").strip()
    transport = httpx.MockTransport(linear_graphql_transport) if linear_graphql_transport else None
    async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
        upstream = await client.post(
            upstream_endpoint,
            json=payload,
            headers={"Authorization": upstream_token, "Content-Type": "application/json"},
        )
    try:
        upstream_payload = upstream.json()
    except json.JSONDecodeError:
        upstream_payload = {"errors": [{"message": upstream.text}]}
    return JSONResponse(upstream_payload, status_code=upstream.status_code)
