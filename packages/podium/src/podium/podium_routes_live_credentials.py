from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .live_conductor_relay import LiveRelayError


RequireUser = Callable[[Request], Awaitable[dict[str, Any] | None]]
ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_live_credential_routes(app: FastAPI, *, state: Any, require_user: RequireUser, error_response: ErrorResponse) -> None:
    @app.get("/api/v1/conductors/{conductor_id}/performer-credentials/live")
    async def inventory(conductor_id: str, request: Request, limit: int = 25, cursor: str = "") -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not await state.conductor_belongs_to_user(conductor_id, str(user["id"])):
            return error_response(404, "conductor_not_found", "Conductor not found")
        if limit < 1 or limit > 25 or len(cursor.encode()) > 256:
            return error_response(400, "invalid_live_query", "Live query parameters are invalid")
        return await _wait(state, conductor_id, "performer_credentials.inspect", {"limit": limit, "cursor": cursor}, error_response)

    @app.post("/api/v1/conductors/{conductor_id}/performer-credentials/checks")
    async def check(conductor_id: str, request: Request) -> JSONResponse:
        user = await require_user(request)
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        if not await state.conductor_belongs_to_user(conductor_id, str(user["id"])):
            return error_response(404, "conductor_not_found", "Conductor not found")
        payload = await request.json()
        slot_id = str(payload.get("slot_id") or "") if isinstance(payload, dict) else ""
        if not slot_id or len(slot_id) > 64:
            return error_response(400, "managed_codex_slot_id_invalid", "Slot id is invalid")
        return await _wait(state, conductor_id, "performer_credentials.check", {"slot_id": slot_id}, error_response)

    @app.post("/api/v1/runtime/live/lease")
    async def lease(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        return JSONResponse({"request": await state.live_relay.lease(str(runtime["id"]))}, headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/runtime/live/reply")
    async def reply(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        if not isinstance(payload, dict) or len(await request.body()) > 16 * 1024:
            return error_response(400, "invalid_live_reply", "Live reply is invalid")
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        accepted = await state.live_relay.reply(str(runtime["id"]), str(payload.get("request_id") or ""), str(payload.get("lease_token") or ""), result)
        if not accepted:
            return error_response(409, "stale_live_reply", "Live reply is stale")
        return JSONResponse({"status": "accepted"}, headers={"Cache-Control": "no-store"})


async def _wait(state: Any, conductor_id: str, operation: str, payload: dict[str, Any], error_response: ErrorResponse) -> JSONResponse:
    try:
        result = await state.live_relay.request(conductor_id, operation, payload)
    except LiveRelayError as exc:
        status = 409 if exc.code.endswith("in_progress") else 429 if exc.code.endswith("rate_limited") else 504 if exc.code.endswith("timeout") else 503
        return error_response(status, exc.code, "Live Conductor query failed")
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


__all__ = ["register_live_credential_routes"]
