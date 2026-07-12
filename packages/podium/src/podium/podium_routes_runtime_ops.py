from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from .podium_shared import dispatch_public, managed_run_view_matches_binding, optional_int, runtime_group_alias
from .podium_smoke_checks import SmokeCheckError

RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]

_MAX_MANAGED_RUN_REPORT_BYTES = 512 * 1024
_MAX_RUNTIME_REPORT_BYTES = 4 * 1024 * 1024
_MAX_RUNS = 64
_MAX_WORK_ITEMS = 10
_MAX_FILES = 3
_RUN_STATES = {"planning", "awaiting_approval", "executing", "blocked", "failed", "done"}
_WORK_ITEM_STATES = {"todo", "in_progress", "in_review", "blocked", "done"}
_SENSITIVE_REPORT_KEY = (
    r"(?:[A-Za-z0-9]+[-_])*?"
    r"(?:access[-_]?token|refresh[-_]?token|api[-_]?key|"
    r"client[-_]?secret|authorization|token|password|cookie|secret)"
    r"(?:[-_][A-Za-z0-9]+)*"
)
_QUOTED_REPORT_SECRET = re.compile(
    r"""(?i)(?P<quote>[\"'])(?P<key>"""
    + _SENSITIVE_REPORT_KEY
    + r""")(?P=quote)\s*[:=]\s*(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^\s,;}\]]+)"""
)
_AUTHORIZATION_REPORT_KEY = r"(?:[A-Za-z0-9]+[-_])*?authorization(?:[-_][A-Za-z0-9]+)*"
_AUTHORIZATION_REPORT_SECRET = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(" + _AUTHORIZATION_REPORT_KEY + r")(\s*[:=]\s*)(?!\[REDACTED\])[^\r\n,;}\]]+"
)
_UNQUOTED_REPORT_SECRET = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(" + _SENSITIVE_REPORT_KEY + r")\s*[:=]\s*(?!\[REDACTED\])[^\s,;}\]]+"
)
_REPORT_HEX_ESCAPE = re.compile(r"\\+(?:u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))")


class ManagedRunReportError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


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
            managed_run={
                key: payload.get(key)
                for key in (
                    "run_id",
                    "parent_issue_id",
                    "active_work_item_id",
                    "managed_run_state",
                    "plan_version",
                    "backend_session_id",
                )
            },
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
        try:
            payload = await _bounded_runtime_report_payload(request)
        except ManagedRunReportError as exc:
            return error_response(_managed_run_report_error_status(exc), exc.code, exc.reason)
        result = await state.apply_runtime_report(str(runtime["id"]), payload)
        if result.get("status") == "rejected":
            return error_response(
                409,
                str(result.get("error_code") or "runtime_report_rejected"),
                str(result.get("sanitized_reason") or "Runtime report was rejected"),
            )
        managed_runs = payload.get("managed_runs")
        if managed_runs is not None and not isinstance(managed_runs, dict):
            return error_response(400, "invalid_managed_run_report", "Managed-run report must be an object")
        if managed_runs:
            try:
                view = _normalize_managed_run_report(
                    managed_runs,
                    binding_id=str(result.get("binding_id") or ""),
                    binding_config_version=int(result.get("binding_config_version") or 0),
                )
            except ManagedRunReportError as exc:
                return error_response(_managed_run_report_error_status(exc), exc.code, exc.reason)
            await state.store.save_managed_run_view(str(runtime["id"]), view)
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
    view, online = await asyncio.gather(
        state.store.get_managed_run_view(conductor_id),
        state.is_runtime_online(conductor_id),
    )
    if not managed_run_view_matches_binding(view, binding):
        view = {}
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
        "runtime_group_id": runtime_group_alias(conductor_id),
        "policy_revision": 1,
        "profiles": {},
        "managed_runs": view or {},
    }


def _normalize_managed_run_report(
    value: dict[str, Any],
    *,
    binding_id: str,
    binding_config_version: int,
) -> dict[str, Any]:
    if not binding_id or binding_config_version <= 0:
        raise ManagedRunReportError("invalid_managed_run_binding", "Managed-run report has no active binding")
    reported_binding_id = value.get("binding_id")
    if not isinstance(reported_binding_id, str) or _report_int(value.get("binding_config_version")) != binding_config_version:
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run report binding is invalid")
    if reported_binding_id != binding_id:
        raise ManagedRunReportError("stale_managed_run_binding", "Managed-run report binding is stale")
    runs = value.get("runs")
    if not isinstance(runs, list):
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run report runs must be a list")
    if len(runs) > _MAX_RUNS:
        raise ManagedRunReportError("managed_run_report_too_large", "Managed-run report has too many runs")
    report = {
        "binding_id": binding_id,
        "binding_config_version": binding_config_version,
        "runs": [_normalize_managed_run(run) for run in runs if isinstance(run, dict)],
    }
    if len(report["runs"]) != len(runs) or len(json.dumps(report, separators=(",", ":"), ensure_ascii=False).encode()) > _MAX_MANAGED_RUN_REPORT_BYTES:
        raise ManagedRunReportError("managed_run_report_too_large", "Managed-run report is invalid or too large")
    observed_active_runs = sum(1 for run in report["runs"] if run["state"] not in {"done", "failed"})
    report["active_runs_total"] = max(_report_int(value.get("active_runs_total")), observed_active_runs)
    return report


async def _bounded_runtime_report_payload(request: Request) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            length = int(content_length)
        except ValueError:
            raise ManagedRunReportError("invalid_runtime_report", "Runtime report content length is invalid") from None
        if length > _MAX_RUNTIME_REPORT_BYTES:
            raise ManagedRunReportError("runtime_report_too_large", "Runtime report is too large")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_RUNTIME_REPORT_BYTES:
            raise ManagedRunReportError("runtime_report_too_large", "Runtime report is too large")
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        raise ManagedRunReportError("invalid_runtime_report", "Runtime report must be valid JSON") from None
    return payload if isinstance(payload, dict) else {}


def _managed_run_report_error_status(error: ManagedRunReportError) -> int:
    if error.code in {"managed_run_report_too_large", "runtime_report_too_large"}:
        return 413
    if error.code == "stale_managed_run_binding":
        return 409
    return 400


def _normalize_managed_run(value: dict[str, Any]) -> dict[str, Any]:
    work_items = value.get("work_items")
    if not isinstance(work_items, list):
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run work items must be a list")
    if len(work_items) > _MAX_WORK_ITEMS:
        raise ManagedRunReportError("managed_run_report_too_large", "Managed-run report has invalid work items")
    state = str(value.get("state") or "")
    if state not in _RUN_STATES:
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run state is invalid")
    run = {
        "run_id": _report_text(value.get("run_id"), 200),
        "parent_issue_id": _report_text(value.get("parent_issue_id"), 200),
        "issue_identifier": _report_text(value.get("issue_identifier"), 200),
        "state": state,
        "active_work_item_id": _report_text(value.get("active_work_item_id"), 200),
        "latest_reason": _report_text(value.get("latest_reason"), 500),
        "plan_version": _report_int(value.get("plan_version")),
        "backend_session_id": _report_text(value.get("backend_session_id"), 200),
        "work_items": [_normalize_work_item(item) for item in work_items if isinstance(item, dict)],
    }
    if not run["run_id"] or not run["parent_issue_id"] or not run["issue_identifier"]:
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run identity is invalid")
    if len(run["work_items"]) != len(work_items):
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run work item is invalid")
    return run


def _normalize_work_item(value: dict[str, Any]) -> dict[str, Any]:
    state = str(value.get("state") or "")
    payload = value.get("payload")
    if not isinstance(payload, dict) or state not in _WORK_ITEM_STATES:
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run work item is invalid")
    files = payload.get("files_likely_touched")
    if not isinstance(files, list) or any(not isinstance(path, str) for path in files):
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run work item is invalid")
    if len(files) > _MAX_FILES:
        raise ManagedRunReportError("managed_run_report_too_large", "Managed-run work item has too many files")
    work_item = {
        "work_item_id": _report_text(value.get("work_item_id"), 200),
        "state": state,
        "gate_status": _report_text(value.get("gate_status"), 120),
        "payload": {
            "title": _report_text(payload.get("title"), 300),
            "objective": _report_text(payload.get("objective"), 1000),
            "files_likely_touched": [_report_text(path, 240) for path in files],
        },
    }
    if not work_item["work_item_id"]:
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run work item identity is invalid")
    return work_item


def _report_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _report_text(value: Any, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ManagedRunReportError("invalid_managed_run_report", "Managed-run text field is invalid")
    text = _normalize_report_text(value)
    text = _QUOTED_REPORT_SECRET.sub(lambda match: f"{match.group('key')}=[REDACTED]", text)
    text = _AUTHORIZATION_REPORT_SECRET.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]",
        text,
    )
    text = _UNQUOTED_REPORT_SECRET.sub(
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    return re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)[:limit]


def _normalize_report_text(value: str) -> str:
    text = _REPORT_HEX_ESCAPE.sub(_decode_report_escape, value)
    return text.replace("\r", " ").replace("\n", " ").replace("\x00", " ").strip()


def _decode_report_escape(match: re.Match[str]) -> str:
    return chr(int(match.group(1) or match.group(2), 16))


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
