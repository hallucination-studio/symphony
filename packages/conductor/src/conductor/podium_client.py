from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx
import websockets

from .conductor_service import ConductorService


LogChunkPoster = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class PodiumRuntimeClient:
    def __init__(self, service: ConductorService) -> None:
        self.service = service

    async def post_log_chunk(self, payload: dict[str, Any], *, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            response = await client.post(
                f"{podium_url}/api/v1/runtime/log-chunks",
                headers={"Authorization": f"Bearer {runtime_token}"},
                json=payload,
            )
        if response.status_code == 401:
            return {"status": "skipped", "reason": "runtime_unauthorized"}
        response.raise_for_status()
        body = response.json()
        return body if isinstance(body, dict) else {"status": "accepted"}

    async def handle_command(self, command: dict[str, Any], *, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
        async def poster(payload: dict[str, Any]) -> dict[str, Any]:
            return await self.post_log_chunk(payload, transport=transport)

        return await self.service.handle_podium_ws_command(command, post_log_chunk=poster)

    async def run_ws_once(self, *, connect: Callable[..., Any] | None = None) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        ws_url = settings.podium_ws_url.strip()
        runtime_token = settings.podium_runtime_token.strip()
        if not ws_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        connector = connect or websockets.connect
        handled = 0
        async with connector(ws_url, additional_headers={"Authorization": f"Bearer {runtime_token}"}) as websocket:
            await websocket.send('{"type":"hello"}')
            while True:
                raw = await websocket.recv()
                if raw is None:
                    break
                import json

                command = json.loads(raw if isinstance(raw, str) else raw.decode())
                if command.get("type") == "ping":
                    continue
                await self.handle_command(command)
                handled += 1
                if command.get("type") in {"log.fetch", "dispatch.available"}:
                    break
        return {"status": "ok", "handled": handled}
