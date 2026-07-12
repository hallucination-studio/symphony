from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .podium_conductors import ConductorIdentityError
from .podium_install import shlex_quote
from .podium_shared import hash_secret, runtime_group_alias, runtime_public

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
    _register_onboarding_enrollment_route(
        app,
        state=state,
        require_user=require_user,
        podium_base_url=podium_base_url,
        error_response=error_response,
    )
    _register_onboarding_runtime_status_route(
        app,
        state=state,
        require_user=require_user,
        error_response=error_response,
    )


def _register_onboarding_enrollment_route(
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
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if isinstance(payload, dict) and "managed_run_profile" in payload:
            return error_response(
                400,
                "legacy_runtime_profile_field",
                "managed_run_profile is not accepted during Conductor enrollment",
            )
        try:
            conductor = await state.reserve_conductor(
                workspace_id,
                str(payload.get("name") or "") if isinstance(payload, dict) else "",
            )
        except ConductorIdentityError as exc:
            return error_response(409 if exc.code == "conductor_name_taken" else 400, exc.code, exc.reason)
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        await state.save_enrollment_token(
            token_hash,
            conductor_id=str(conductor["id"]),
            expires_at=expires_at,
        )
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
                "conductor": await state.conductor_public(conductor),
            }
        )


def _register_onboarding_runtime_status_route(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.get("/api/v1/onboarding/runtime/status")
    async def onboarding_runtime_status(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        workspace_id = str(user["id"])
        conductors = await state.store.list_conductors_for_user(workspace_id)
        enrolled = [row for row in conductors if row.get("enrollment_state") == "enrolled"]
        presence = await state.runtime_presence_snapshot([str(row["id"]) for row in enrolled])
        online = [row for row in enrolled if row["id"] in presence]
        token_pending = False
        for row in conductors:
            if await state.has_pending_enrollment(str(row.get("id") or "")):
                token_pending = True
                break
        if online:
            await state.mark_runtime_enrolled(workspace_id)
        return JSONResponse(
            {
                "workspace_id": workspace_id,
                "token_pending": token_pending,
                "runtime_count": len(enrolled),
                "online_count": len(online),
                "enrolled": len(enrolled) > 0,
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
        runtime_id = str(token_row.get("conductor_id") or "")
        conductor = await state.store.get_runtime(runtime_id)
        if not runtime_id or conductor is None:
            return error_response(400, "invalid_enrollment_identity", "Enrollment identity is invalid")
        runtime_token = secrets.token_urlsafe(32)
        proxy_token = secrets.token_urlsafe(32)
        runtime_group_id = runtime_group_alias(runtime_id)
        saved = await save_runtime_record(
            state,
            runtime_id,
            hash_secret(runtime_token),
            hash_secret(proxy_token),
            payload,
        )
        return JSONResponse(
            {
                "runtime_id": runtime_id,
                "runtime_token": runtime_token,
                "proxy_token": proxy_token,
                "runtime_group_id": runtime_group_id,
                "conductor": await state.conductor_public(saved),
            }
        )

async def runtime_records_for_user(state: Any, workspace_id: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for conductor in await state.store.list_conductors_for_user(workspace_id):
        runtime = await state.store.get_runtime(str(conductor["id"]))
        if runtime is not None:
            records.append(runtime)
    return records


async def save_runtime_record(
    state: Any,
    runtime_id: str,
    runtime_token_hash: str,
    proxy_token_hash: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = payload or {}
    existing = await state.store.get_runtime(runtime_id)
    if existing is None:
        raise RuntimeError("reserved_conductor_required")
    conductor = {
        **existing,
        "hostname": str(payload.get("hostname") or ""),
        "label": str(existing.get("name") or payload.get("label") or ""),
        "version": str(payload.get("version") or ""),
        "service_identity": str(payload.get("service_identity") or existing.get("service_identity") or ""),
        "data_root": str(payload.get("data_root") or existing.get("data_root") or ""),
        "runtime_token_hash": runtime_token_hash,
        "proxy_token_hash": proxy_token_hash,
        "enrollment_state": "enrolled",
        "disabled": False,
        "revoked": False,
        "last_report_at": None,
    }
    await state.store.upsert_conductor(conductor)
    return conductor
