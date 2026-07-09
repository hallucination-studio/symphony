from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_install import shlex_quote
from .podium_shared import hash_secret, runtime_public, utc_now_iso

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_runtime_identity_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    podium_base_url: str,
    error_response: ErrorResponse,
) -> None:
    _register_runtime_onboarding_routes(
        app, state=state, require_user=require_user, podium_base_url=podium_base_url, error_response=error_response
    )
    _register_runtime_listing_routes(app, state=state, require_user=require_user, error_response=error_response)
    _register_runtime_enrollment_routes(app, state=state, error_response=error_response)


def _register_runtime_onboarding_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    podium_base_url: str,
    error_response: ErrorResponse,
) -> None:
    @app.post("/api/v1/onboarding/runtime/enrollment-token")
    async def onboarding_enrollment_token(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        group_id = await group_for_workspace(state, workspace_id)
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await state.save_enrollment_token(token_hash, runtime_group_id=group_id, expires_at=expires_at)
        install_command = (
            f"PODIUM_ENROLLMENT_TOKEN={shlex_quote(token)} "
            f"curl -fsSL {podium_base_url}/install.sh | "
            f"PODIUM_ENROLLMENT_TOKEN={shlex_quote(token)} "
            f"bash -s -- --podium-url {podium_base_url}"
        )
        return JSONResponse(
            {
                "enrollment_token": token,
                "install_command": install_command,
                "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            }
        )

    @app.get("/api/v1/onboarding/runtime/status")
    async def onboarding_runtime_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        group_id = f"group_{workspace_id}"
        await state.list_conductors_for_user(workspace_id)
        runtimes = [r for r in await runtime_records_for_user(state, workspace_id) if r["runtime_group_id"] == group_id]
        presence = await state.runtime_presence_snapshot([str(r["id"]) for r in runtimes])
        online = [r for r in runtimes if r["id"] in presence]
        token_pending = await state.has_pending_enrollment(group_id)
        if online:
            await state.mark_runtime_enrolled(workspace_id)
        return JSONResponse(
            {
                "workspace_id": workspace_id,
                "token_pending": token_pending,
                "runtime_count": len(runtimes),
                "online_count": len(online),
                "enrolled": len(runtimes) > 0,
            }
        )


def _register_runtime_listing_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.get("/api/v1/runtimes")
    async def list_runtimes(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        conductors = await state.list_conductors_for_user(workspace_id)
        runtime_rows = await runtime_records_for_user(state, workspace_id)
        runtime_ids = [str(runtime["id"]) for runtime in runtime_rows]
        presence = await state.runtime_presence_snapshot(runtime_ids)
        return JSONResponse(
            {
                "conductors": conductors,
                "runtimes": [runtime_public(runtime, presence) for runtime in runtime_rows],
            }
        )

    @app.get("/api/v1/runtimes/{runtime_id}")
    async def runtime_detail(runtime_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        runtime = await state.store.get_runtime(runtime_id)
        if runtime is None or str(runtime.get("user_id") or "") != workspace_id:
            return error_response(404, "not_found", "Runtime not found")
        presence = await state.runtime_presence_snapshot([runtime_id])
        return JSONResponse(runtime_public(runtime, presence))


def _register_runtime_enrollment_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/runtime/enrollment-tokens")
    async def create_enrollment_token(request: Request) -> dict[str, str]:
        payload = await request.json()
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        runtime_group_id = await runtime_group_from_payload(state, payload)
        await state.save_enrollment_token(
            token_hash,
            runtime_group_id=runtime_group_id,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        return {"enrollment_token": token, "runtime_group_id": runtime_group_id}

    @app.post("/api/v1/runtime/enroll")
    async def enroll_runtime(request: Request) -> JSONResponse:
        payload = await request.json()
        enrollment_token = str(payload.get("enrollment_token") or "")
        token_row, token_error = await state.consume_enrollment_token(enrollment_token)
        if token_error == "invalid_enrollment_token":
            return error_response(400, "invalid_enrollment_token", "Enrollment token is invalid")
        if token_error == "enrollment_token_used":
            return error_response(400, "enrollment_token_used", "Enrollment token has already been used")
        if token_error == "enrollment_token_expired":
            return error_response(400, "enrollment_token_expired", "Enrollment token has expired")
        runtime_id = f"runtime_{secrets.token_urlsafe(12)}"
        runtime_token = secrets.token_urlsafe(32)
        proxy_token = secrets.token_urlsafe(32)
        runtime_group_id = str(token_row["runtime_group_id"])
        await save_runtime_record(state, runtime_id, runtime_group_id, hash_secret(runtime_token), hash_secret(proxy_token), payload)
        websocket_url = str(request.base_url).rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
        return JSONResponse(
            {
                "runtime_id": runtime_id,
                "runtime_token": runtime_token,
                "proxy_token": proxy_token,
                "runtime_group_id": runtime_group_id,
                "websocket_url": f"{websocket_url}/api/v1/runtime/ws",
            }
        )


async def group_for_workspace(state: Any, workspace_id: str) -> str:
    group_id = f"group_{workspace_id}"
    await state.ensure_workspace_runtime_group(workspace_id)
    return group_id


async def runtime_records_for_user(state: Any, workspace_id: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for conductor in await state.store.list_conductors_for_user(workspace_id):
        runtime = await state.store.get_runtime(str(conductor["id"]))
        if runtime is not None:
            records.append(runtime)
    return records


async def runtime_group_from_payload(state: Any, payload: dict[str, Any]) -> str:
    existing = await state.store.list_runtime_groups()
    runtime_group_id = str(payload.get("runtime_group_id") or f"group_{len(existing) + 1}")
    workspace_id = str(payload.get("linear_workspace_id") or "")
    if workspace_id:
        await ensure_workspace_user(state, workspace_id)
    await state.store.upsert_runtime_group(
        {
            "id": runtime_group_id,
            "linear_workspace_id": workspace_id,
            "project_slug": str(payload.get("project_slug") or ""),
            "linear_agent_app_user_id": str(payload.get("linear_agent_app_user_id") or payload.get("agent_app_user_id") or ""),
            "pipeline_profile": str(payload.get("pipeline_profile") or "default"),
            "project_binding_id": "",
        }
    )
    return runtime_group_id


async def ensure_workspace_user(state: Any, workspace_id: str) -> None:
    if not workspace_id or await state.store.get_user(workspace_id) is not None:
        return
    await state.store.create_user(
        workspace_id,
        email=f"{workspace_id}@runtime.local",
        password_hash="runtime-enrollment-placeholder",
        created_at=utc_now_iso(),
    )


async def save_runtime_record(
    state: Any,
    runtime_id: str,
    runtime_group_id: str,
    runtime_token_hash: str,
    proxy_token_hash: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = payload or {}
    group = await state.store.get_runtime_group(runtime_group_id) or {
        "id": runtime_group_id,
        "linear_workspace_id": "",
        "project_slug": "",
        "linear_agent_app_user_id": "",
        "pipeline_profile": "default",
        "project_binding_id": "",
    }
    conductor = {
        "id": runtime_id,
        "conductor_id": runtime_id,
        "user_id": str(group.get("linear_workspace_id") or ""),
        "runtime_group_id": runtime_group_id,
        "hostname": str(payload.get("hostname") or ""),
        "label": str(payload.get("label") or ""),
        "version": str(payload.get("version") or ""),
        "runtime_token_hash": runtime_token_hash,
        "proxy_token_hash": proxy_token_hash,
        "disabled": False,
        "revoked": False,
        "created_at": utc_now_iso(),
        "last_report_at": None,
    }
    await state.store.upsert_conductor(conductor)
    return conductor
