from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .live_conductor_relay import LiveRelayError


RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]
_MAX_OWNER_BODY_BYTES = 72 * 1024
_MAX_REPLY_BODY_BYTES = 256 * 1024


def register_performer_control_routes(
    app: FastAPI,
    *,
    state: Any,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> None:
    @app.get("/api/v1/conductors/{conductor_id}/performer")
    async def status(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        return await _wait(state, conductor_id, "performer.status", {}, error_response)

    @app.post("/api/v1/conductors/{conductor_id}/performer/login")
    async def login(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        payload = await _request_payload(request, error_response)
        if isinstance(payload, JSONResponse):
            return payload
        return await _wait(state, conductor_id, "performer.login", payload, error_response)

    @app.delete("/api/v1/conductors/{conductor_id}/performer/session")
    async def delete_session(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        payload = await _request_payload(request, error_response)
        if isinstance(payload, JSONResponse):
            return payload
        return await _wait(
            state,
            conductor_id,
            "performer.session.delete",
            payload,
            error_response,
        )

    @app.get("/api/v1/conductors/{conductor_id}/performer/config")
    async def read_config(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        return await _wait(state, conductor_id, "performer.config.read", {}, error_response)

    @app.patch("/api/v1/conductors/{conductor_id}/performer/config")
    async def write_config(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        payload = await _request_payload(request, error_response)
        if isinstance(payload, JSONResponse):
            return payload
        return await _wait(
            state,
            conductor_id,
            "performer.config.write",
            payload,
            error_response,
        )

    @app.post("/api/v1/conductors/{conductor_id}/performer/check")
    async def check(conductor_id: str, request: Request) -> JSONResponse:
        denied = await _authorize(state, conductor_id, request, require_user, error_response)
        if denied is not None:
            return denied
        payload = await _request_payload(request, error_response)
        if isinstance(payload, JSONResponse):
            return payload
        return await _wait(state, conductor_id, "performer.check", payload, error_response)

    @app.post("/api/v1/runtime/live/lease")
    async def lease(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return _error_no_store(error_response, 401, "unauthorized", "Unauthorized")
        return _json_no_store(
            {"request": await state.live_relay.lease(str(runtime["id"]))}
        )

    @app.post("/api/v1/runtime/live/reply")
    async def reply(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return _error_no_store(error_response, 401, "unauthorized", "Unauthorized")
        raw = await request.body()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if (
            not isinstance(payload, dict)
            or len(raw) > _MAX_REPLY_BODY_BYTES
            or set(payload) - {"request_id", "lease_token", "result", "events"}
            or {"request_id", "lease_token", "result"} - set(payload)
            or not isinstance(payload.get("result"), dict)
            or not isinstance(payload.get("events", []), list)
        ):
            return _error_no_store(
                error_response, 400, "invalid_live_reply", "Live reply is invalid"
            )
        try:
            accepted = await state.live_relay.reply(
                str(runtime["id"]),
                str(payload.get("request_id") or ""),
                str(payload.get("lease_token") or ""),
                payload["result"],
                events=payload.get("events", []),
            )
        except LiveRelayError as exc:
            return _error_no_store(
                error_response, 400, exc.code, "Live Performer result is invalid"
            )
        if not accepted:
            return _error_no_store(
                error_response, 409, "stale_live_reply", "Live reply is stale"
            )
        return _json_no_store({"status": "accepted"})


async def _authorize(
    state: Any,
    conductor_id: str,
    request: Request,
    require_user: RequireUser,
    error_response: ErrorResponse,
) -> JSONResponse | None:
    user = await require_user(request)
    if user is None:
        return _error_no_store(error_response, 401, "unauthorized", "Unauthorized")
    if not await state.conductor_belongs_to_user(conductor_id, str(user["id"])):
        return _error_no_store(
            error_response, 404, "conductor_not_found", "Conductor not found"
        )
    if not await state.is_runtime_online(conductor_id):
        return _error_no_store(
            error_response, 503, "conductor_offline", "Conductor is offline"
        )
    return None


async def _request_payload(
    request: Request, error_response: ErrorResponse
) -> dict[str, Any] | JSONResponse:
    raw = await request.body()
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    if not isinstance(payload, dict) or len(raw) > _MAX_OWNER_BODY_BYTES:
        return _error_no_store(
            error_response,
            400,
            "performer_control_request_invalid",
            "Performer control request is invalid",
        )
    return payload


async def _wait(
    state: Any,
    conductor_id: str,
    operation: str,
    payload: dict[str, Any],
    error_response: ErrorResponse,
) -> JSONResponse:
    try:
        result = await state.live_relay.request(conductor_id, operation, payload)
    except LiveRelayError as exc:
        if exc.code.endswith("in_progress"):
            status = 409
        elif exc.code.endswith("rate_limited"):
            status = 429
        elif exc.code.endswith("timeout"):
            status = 504
        elif exc.code.endswith("invalid") or exc.code.endswith("unsupported"):
            status = 400
        else:
            status = 503
        public_code = (
            "performer_control_request_invalid"
            if exc.code == "performer_live_request_invalid"
            else exc.code
        )
        return _error_no_store(
            error_response, status, public_code, "Live Performer operation failed"
        )
    return _json_no_store(result)


def _json_no_store(payload: dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def _error_no_store(
    error_response: ErrorResponse, status: int, code: str, message: str
) -> JSONResponse:
    response = error_response(status, code, message)
    response.headers["Cache-Control"] = "no-store"
    return response


__all__ = ["register_performer_control_routes"]
