from __future__ import annotations

from typing import Any, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .podium_smoke_protocol import SmokeCheckError


ErrorResponse = Callable[[int, str, str], JSONResponse]


def register_runtime_smoke_route(app: FastAPI, *, state: Any, error_response: ErrorResponse) -> None:
    @app.post("/api/v1/runtime/smoke-check/result")
    async def runtime_smoke_result(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        runtime = await state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        try:
            payload = await request.json()
        except Exception:
            payload = None
        if not isinstance(payload, dict):
            return error_response(400, "invalid_smoke_result", "Runtime smoke result must be an object")
        try:
            result = await state.submit_smoke_check_result(runtime, payload)
        except SmokeCheckError as exc:
            return error_response(exc.status_code, exc.code, exc.reason)
        return JSONResponse(result, status_code=202 if result.get("status") == "running" else 200)
