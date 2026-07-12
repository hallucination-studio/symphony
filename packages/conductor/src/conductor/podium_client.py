from __future__ import annotations

from typing import Any

import httpx

from .conductor_service import ConductorService
from .conductor_smoke_protocol import sanitize_reason


class PodiumRuntimeClient:
    def __init__(self, service: ConductorService) -> None:
        self.service = service

    async def poll_command_once(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return {"status": "skipped", "reason": "runtime_not_configured"}
        headers = {"Authorization": f"Bearer {runtime_token}"}
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/commands/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            command = lease_response.json().get("command")
            if not command:
                return {"status": "idle"}
            try:
                payload = command.get("command") if isinstance(command.get("command"), dict) else None
                if payload is None:
                    raise ValueError("runtime_command_payload_invalid")
                result = await self.service.handle_podium_command(payload, post_smoke_result=None)
                result = {**result, "command_type": str(payload.get("type") or "")}
                ack_status = "failed" if result.get("status") in {"failed", "rejected", "error"} else "completed"
            except Exception as exc:
                result = {
                    "status": "failed",
                    "error_code": "runtime_command_failed",
                    "sanitized_reason": sanitize_reason(exc),
                }
                ack_status = "failed"
            ack_response = await client.post(
                f"{podium_url}/api/v1/runtime/commands/ack",
                headers=headers,
                json={
                    "command_id": command.get("id"),
                    "fencing_token": command.get("fencing_token"),
                    "status": ack_status,
                    "result": result,
                },
            )
            if ack_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            if ack_response.status_code == 409:
                return {"status": "stale", "reason": "stale_runtime_command_lease"}
            ack_response.raise_for_status()
        return {"status": "handled", "command": command, "result": result}
