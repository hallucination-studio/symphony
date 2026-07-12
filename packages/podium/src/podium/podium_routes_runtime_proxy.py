from __future__ import annotations

import json
import os
from typing import Any, Callable

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .linear_token_service import LinearTokenUnavailable
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
    binding = await _ready_proxy_binding_or_error(state, runtime, error_response)
    if isinstance(binding, JSONResponse):
        return binding
    workspace_id = str(binding.get("user_id") or "")
    installation = await _linear_installation_or_error(state, runtime, workspace_id, error_response)
    if isinstance(installation, JSONResponse):
        return installation
    if str(installation.get("id") or "") != str(binding.get("installation_id") or ""):
        await _audit_proxy_context_denial(state, runtime, binding, "runtime_installation_mismatch")
        return error_response(409, "runtime_installation_mismatch", "Runtime binding installation is not active")
    try:
        upstream_token = await state.linear_access_token(installation)
    except LinearTokenUnavailable as exc:
        return await _linear_token_error(state, runtime, workspace_id, exc, error_response)
    token_error = await _validate_proxy_token(
        state, runtime, workspace_id, payload, installation, upstream_token, error_response
    )
    if token_error is not None:
        return token_error
    await _record_proxy_allowed(state, runtime, binding, payload, workspace_id, "installation")
    response = await _forward_linear_graphql(payload, upstream_token, linear_graphql_transport)
    if response.status_code != 401:
        return response
    try:
        refreshed = await state.linear_access_token(
            installation,
            force_refresh=True,
            rejected_access_token=upstream_token,
        )
    except LinearTokenUnavailable as exc:
        return await _linear_token_error(state, runtime, workspace_id, exc, error_response)
    response = await _forward_linear_graphql(payload, refreshed, linear_graphql_transport)
    if response.status_code != 401:
        return response
    current = await state.get_active_linear_installation(workspace_id)
    if current is not None:
        await state.mark_linear_reauthorization_required(current, "linear_token_rejected_after_refresh")
    failure = LinearTokenUnavailable("linear_reauthorization_required", "Linear authorization must be renewed")
    return await _linear_token_error(state, runtime, workspace_id, failure, error_response)


async def _ready_proxy_binding_or_error(
    state: Any,
    runtime: dict[str, Any],
    error_response: ErrorResponse,
) -> dict[str, Any] | JSONResponse:
    runtime_id = str(runtime.get("id") or "")
    bindings = [
        row
        for row in await state.store.list_project_bindings_for_conductor(runtime_id)
        if row.get("active", True)
    ]
    if not bindings:
        await _audit_runtime_proxy_denial(state, runtime, "linear_project_binding_required")
        return error_response(409, "linear_project_binding_required", "A ready project binding is required")
    if len(bindings) != 1 or str(bindings[0].get("state") or "") != "ready":
        binding = bindings[0]
        await _audit_proxy_context_denial(state, runtime, binding, "linear_project_binding_not_ready")
        return error_response(409, "linear_project_binding_not_ready", "Project binding is not ready")
    binding = bindings[0]
    if (
        runtime_id != str(binding.get("conductor_id") or "")
        or str(runtime.get("user_id") or "") != str(binding.get("user_id") or "")
    ):
        await _audit_proxy_context_denial(state, runtime, binding, "runtime_project_binding_mismatch")
        return error_response(409, "runtime_project_binding_mismatch", "Runtime project binding does not match")
    selected = await state.store.list_selected_linear_projects(str(binding.get("user_id") or ""))
    if str(binding.get("linear_project_id") or "") not in {
        str(row.get("linear_project_id") or "") for row in selected
    }:
        await _audit_proxy_context_denial(state, runtime, binding, "linear_project_scope_mismatch")
        return error_response(409, "linear_project_scope_mismatch", "Runtime project is outside selected scope")
    return binding


async def _audit_runtime_proxy_denial(state: Any, runtime: dict[str, Any], reason: str) -> None:
    await state.record_proxy_audit(
        {"runtime_id": runtime["id"], "allowed": False, "reason": reason, "timestamp": utc_now_iso()}
    )


async def _audit_proxy_context_denial(
    state: Any,
    runtime: dict[str, Any],
    binding: dict[str, Any],
    reason: str,
) -> None:
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "project_binding_id": binding.get("id"),
            "linear_project_id": binding.get("linear_project_id"),
            "allowed": False,
            "reason": reason,
            "timestamp": utc_now_iso(),
        }
    )


async def _linear_installation_or_error(
    state: Any, runtime: dict[str, Any], workspace_id: str, error_response: ErrorResponse
) -> dict[str, Any] | None | JSONResponse:
    try:
        installation = await state.get_active_linear_installation(workspace_id)
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
    if installation is not None:
        return installation
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "workspace_id": workspace_id,
            "allowed": False,
            "reason": "linear_installation_required",
            "timestamp": utc_now_iso(),
        }
    )
    return error_response(400, "linear_installation_required", "An active Linear installation is required")


async def _validate_proxy_token(
    state: Any,
    runtime: dict[str, Any],
    workspace_id: str,
    payload: dict[str, Any],
    installation: dict[str, Any] | None,
    upstream_token: str,
    error_response: ErrorResponse,
) -> JSONResponse | None:
    query = str(payload.get("query") or "").lstrip().lower()
    if not (query.startswith("mutation") or "\nmutation" in query) or not upstream_token:
        return None
    actor = str((installation or {}).get("actor") or (installation or {}).get("token_actor") or "").strip().lower()
    if actor in {"app", "application"}:
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


async def _linear_token_error(
    state: Any,
    runtime: dict[str, Any],
    workspace_id: str,
    error: LinearTokenUnavailable,
    error_response: ErrorResponse,
) -> JSONResponse:
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "allowed": False,
            "reason": error.code,
            "workspace_id": workspace_id,
            "timestamp": utc_now_iso(),
        }
    )
    return error_response(401, error.code, error.reason)


async def _record_proxy_allowed(
    state: Any,
    runtime: dict[str, Any],
    binding: dict[str, Any],
    payload: dict[str, Any],
    workspace_id: str,
    token_source: str,
) -> None:
    await state.record_proxy_audit(
        {
            "runtime_id": runtime["id"],
            "allowed": True,
            "operation_name": payload.get("operationName"),
            "workspace_id": workspace_id,
            "project_binding_id": binding.get("id"),
            "linear_project_id": binding.get("linear_project_id"),
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
            headers={"Authorization": f"Bearer {upstream_token}", "Content-Type": "application/json"},
        )
    try:
        upstream_payload = upstream.json()
    except json.JSONDecodeError:
        upstream_payload = {"errors": [{"message": upstream.text}]}
    return JSONResponse(upstream_payload, status_code=upstream.status_code)
