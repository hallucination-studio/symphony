from __future__ import annotations

import asyncio
from typing import Any, Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .podium_routes_runtime_helpers import managed_run_ack_payload
from .podium_shared import dispatch_public


def register_runtime_ws_route(app: FastAPI, *, state: Any) -> None:
    @app.websocket("/api/v1/runtime/ws")
    async def runtime_ws(websocket: WebSocket) -> None:
        runtime = await state.runtime_for_bearer(websocket.headers.get("authorization") or "")
        if runtime is None:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        runtime_id = str(runtime["id"])
        after_command_id = await state.attach_runtime_ws(runtime_id)
        forward_task = asyncio.create_task(_forward_runtime_commands(state, websocket, runtime_id, after_command_id))
        try:
            while True:
                message = await websocket.receive_json()
                await _handle_runtime_ws_message(state, websocket, runtime_id, message)
        except WebSocketDisconnect:
            pass
        finally:
            await _cleanup_runtime_ws(state, runtime_id, forward_task)


async def _handle_runtime_ws_message(
    state: Any, websocket: WebSocket, runtime_id: str, message: dict[str, Any]
) -> None:
    kind = str(message.get("type") or "")
    if kind in {"hello", "heartbeat"}:
        await state.set_presence(runtime_id)
        await websocket.send_json({"type": "ping"})
    elif kind == "dispatch.ack":
        await _handle_runtime_ws_dispatch_ack(state, websocket, runtime_id, message)
    else:
        await websocket.send_json({"type": "error", "code": "unsupported_message"})


async def _handle_runtime_ws_dispatch_ack(
    state: Any, websocket: WebSocket, runtime_id: str, message: dict[str, Any]
) -> None:
    try:
        raw_fencing_token = message.get("fencing_token")
        fencing_token = int(raw_fencing_token) if raw_fencing_token not in {None, ""} else None
    except (TypeError, ValueError):
        await websocket.send_json(
            {
                "type": "error",
                "code": "invalid_fencing_token",
                "message": "fencing_token must be an integer",
            }
        )
        return
    dispatch = await state.ack_dispatch(
        runtime_id,
        str(message.get("dispatch_id") or ""),
        str(message.get("status") or "accepted"),
        fencing_token=fencing_token,
        reason=message.get("reason") if isinstance(message.get("reason"), str) else None,
        managed_run=managed_run_ack_payload(message),
    )
    await websocket.send_json({"type": "dispatch.ack.ok", "dispatch": dispatch_public(dispatch) if dispatch else None})


async def _cleanup_runtime_ws(state: Any, runtime_id: str, forward_task: asyncio.Task[Any]) -> None:
    forward_task.cancel()
    try:
        await forward_task
    except asyncio.CancelledError:
        pass
    await state.detach_runtime_ws(runtime_id)


async def _forward_runtime_commands(state: Any, websocket: WebSocket, runtime_id: str, after_id: int) -> None:
    while True:
        row = await state.store.next_runtime_command(runtime_id, after_id=after_id)
        if row is None:
            await asyncio.sleep(0.05)
            continue
        after_id = int(row.get("id") or after_id)
        command = row.get("command") if isinstance(row.get("command"), dict) else None
        if command is not None:
            await websocket.send_json(command)
