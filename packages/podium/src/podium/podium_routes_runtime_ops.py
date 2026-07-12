from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from .podium_routes_runtime_helpers import managed_run_ack_payload
from .podium_shared import dispatch_public, optional_int
from .podium_smoke_protocol import SmokeCheckError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_runtime_ops_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    _register_runtime_dispatch_routes(app, state=state, error_response=error_response)
    _register_runtime_command_routes(app, state=state, error_response=error_response)
    _register_runtime_report_endpoint(app, state=state, error_response=error_response)
    _register_managed_run_view_endpoint(app, state=state, require_user=require_user, error_response=error_response)
    _register_runtime_log_routes(app, state=state, require_user=require_user, error_response=error_response)


def _register_runtime_dispatch_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/runtime/dispatches/lease")
    async def lease_dispatch(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        dispatch = await state.lease_dispatch(str(runtime["id"]))
        if dispatch is None:
            return JSONResponse({"dispatch": None})
        return JSONResponse({"dispatch": dispatch_public(dispatch)})


    @app.post("/api/v1/runtime/dispatches/ack")
    async def ack_dispatch(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        fencing_token, token_error = _fencing_token_from_payload(payload)
        if token_error:
            return error_response(400, "invalid_fencing_token", "fencing_token must be an integer")
        dispatch = await state.ack_dispatch(
            str(runtime["id"]),
            str(payload.get("dispatch_id") or ""),
            str(payload.get("status") or "accepted"),
            fencing_token=fencing_token,
            reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None,
            managed_run=managed_run_ack_payload(payload),
        )
        if dispatch is None:
            return error_response(404, "dispatch_not_found", "Dispatch not found")
        if dispatch.get("_ack_error") == "stale_dispatch_lease":
            return error_response(409, "stale_dispatch_lease", "Dispatch lease fencing token is stale")
        return JSONResponse({"dispatch": dispatch_public(dispatch)})


def _register_runtime_command_routes(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/runtime/commands/lease")
    async def lease_runtime_command(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        command = await state.lease_runtime_command(str(runtime["id"]))
        return JSONResponse({"command": command})

    @app.post("/api/v1/runtime/commands/ack")
    async def ack_runtime_command(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        if not isinstance(payload, dict):
            return error_response(400, "invalid_command_ack", "Command acknowledgement must be a JSON object")
        command_id, command_error = _required_int(payload.get("command_id"))
        fencing_token, fencing_error = _required_int(payload.get("fencing_token"))
        if command_error or fencing_error:
            return error_response(400, "invalid_command_ack", "command_id and fencing_token must be integers")
        status = str(payload.get("status") or "")
        if status not in {"completed", "failed"}:
            return error_response(400, "invalid_command_status", "status must be completed or failed")
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        if result.get("command_type") == "smoke.check":
            try:
                smoke_result = await state.submit_smoke_check_result(
                    runtime,
                    result.get("result") if isinstance(result.get("result"), dict) else {},
                )
                result = {**result, "podium_smoke": smoke_result}
            except SmokeCheckError as exc:
                status = "failed"
                result = {
                    **result,
                    "error_code": exc.code,
                    "sanitized_reason": exc.reason,
                    "action_required": "rerun_smoke_check",
                    "retryable": False,
                }
        command = await state.ack_runtime_command(
            str(runtime["id"]),
            command_id,
            fencing_token,
            status=status,
            result=result,
        )
        if command is None:
            return error_response(404, "runtime_command_not_found", "Runtime command not found")
        if command.get("_ack_error") == "stale_runtime_command_lease":
            return error_response(409, "stale_runtime_command_lease", "Runtime command lease fencing token is stale")
        return JSONResponse({"command": command})


def _register_runtime_report_endpoint(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/runtime/report")
    async def runtime_report(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        result = await state.apply_runtime_report(str(runtime["id"]), payload if isinstance(payload, dict) else {})
        if result.get("status") == "rejected":
            return error_response(
                409,
                str(result.get("error_code") or "runtime_report_rejected"),
                str(result.get("sanitized_reason") or "Runtime report was rejected"),
            )
        managed_runs = payload.get("managed_runs") if isinstance(payload, dict) else None
        group_id = str(runtime.get("runtime_group_id") or "")
        if isinstance(managed_runs, dict):
            await state.store.save_managed_run_view(group_id, managed_runs)
        if isinstance(result, dict):
            result = {**result, "config": {"version": 1, "profiles": {}}}
        return JSONResponse(result)


def _register_managed_run_view_endpoint(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.get("/api/v1/managed-runs")
    async def managed_runs_view(request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        reports = await _managed_run_reports_for_user(state, str(user["id"]))
        return JSONResponse({"conductors": reports})


async def _managed_run_reports_for_user(state: Any, workspace_id: str) -> list[dict[str, Any]]:
    conductors = await state.store.list_conductors_for_user(workspace_id)
    enrolled = {
        str(conductor.get("id") or ""): conductor
        for conductor in conductors
        if conductor.get("enrollment_state") == "enrolled"
    }
    bindings = await state.store.list_project_bindings_for_user(workspace_id)
    reports = await asyncio.gather(
        *(
            _managed_run_report(state, enrolled[str(binding.get("conductor_id") or "")], binding)
            for binding in bindings
            if str(binding.get("conductor_id") or "") in enrolled
        )
    )
    return sorted(
        reports,
        key=lambda row: (str(row["project"].get("slug") or ""), str(row["conductor"].get("id") or "")),
    )


async def _managed_run_report(
    state: Any,
    conductor: dict[str, Any],
    binding: dict[str, Any],
) -> dict[str, Any]:
    conductor_id = str(conductor.get("id") or "")
    group_id = str(conductor.get("runtime_group_id") or "")
    view, online = await asyncio.gather(
        state.store.get_managed_run_view(group_id),
        state.is_runtime_online(conductor_id),
    )
    return {
        "conductor": {
            "id": conductor_id,
            "name": str(conductor.get("name") or ""),
            "public_id": str(conductor.get("public_id") or ""),
            "online": online,
        },
        "project": {
            "id": str(binding.get("linear_project_id") or ""),
            "slug": str(binding.get("project_slug") or ""),
            "name": str(binding.get("project_name") or ""),
        },
        "binding": {
            "id": str(binding.get("id") or ""),
            "instance_id": str(binding.get("instance_id") or ""),
            "state": str(binding.get("state") or ""),
            "error_code": str(binding.get("error_code") or ""),
            "sanitized_reason": str(binding.get("sanitized_reason") or ""),
        },
        "runtime_group_id": group_id,
        "policy_revision": 1,
        "profiles": {},
        "managed_runs": view or {},
    }


def _register_runtime_log_routes(
    app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse
) -> None:
    @app.get("/api/v1/runtimes/{conductor_id}/instances/{instance_id}/logs")
    async def runtime_instance_logs(conductor_id: str, instance_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not await state.conductor_belongs_to_user(conductor_id, str(user["id"])):
            return error_response(404, "not_found", "Conductor not found")
        tail = optional_int(request.query_params.get("tail"), 200)
        order = request.query_params.get("order") or "desc"
        return await _runtime_instance_logs_response(state, conductor_id, instance_id, tail, order)


async def _runtime_instance_logs_response(
    state: Any, conductor_id: str, instance_id: str, tail: int | None, order: str
) -> JSONResponse:
    tail_row = await state.store.get_instance_log_tail(conductor_id, instance_id)
    if tail_row is None:
        return JSONResponse({"logs": None}, status_code=404)
    lines = list(tail_row.get("lines") or [])
    if tail is not None:
        lines = lines[:tail]
    return JSONResponse(
        {
            "logs": {
                "conductor_id": conductor_id,
                "instance_id": instance_id,
                "generation": tail_row.get("generation"),
                "order": order,
                "lines": lines,
                "cursor": tail_row.get("offset_end", 0),
                "offset_end": tail_row.get("offset_end", 0),
            }
        }
    )


def _fencing_token_from_payload(payload: dict[str, Any]) -> tuple[int | None, str | None]:
    try:
        raw_fencing_token = payload.get("fencing_token")
        return int(raw_fencing_token) if raw_fencing_token not in {None, ""} else None, None
    except (TypeError, ValueError):
        return None, "invalid_fencing_token"


def _required_int(value: Any) -> tuple[int | None, str | None]:
    try:
        return int(value), None
    except (TypeError, ValueError):
        return None, "invalid_integer"
