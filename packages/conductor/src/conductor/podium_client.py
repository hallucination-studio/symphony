from __future__ import annotations

from typing import Any

import httpx

from .conductor_service import ConductorService
from .conductor_smoke_protocol import safe_code, sanitize_reason


class PodiumRuntimeClient:
    def __init__(self, service: ConductorService) -> None:
        self.service = service

    async def post_smoke_result(
        self,
        payload: dict[str, Any],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        settings = self.service.store.get_settings()
        podium_url = settings.podium_url.strip().rstrip("/")
        runtime_token = settings.podium_runtime_token.strip()
        if not podium_url or not runtime_token:
            return _smoke_post_error(0, "runtime_not_configured", "Podium runtime credentials are not configured")
        try:
            async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
                response = await client.post(
                    f"{podium_url}/api/v1/runtime/smoke-check/result",
                    headers={"Authorization": f"Bearer {runtime_token}"},
                    json=payload,
                )
        except Exception as exc:
            return _smoke_post_error(503, "podium_unavailable", sanitize_reason(exc))
        if response.status_code in {200, 202}:
            return {"status": "accepted", "status_code": response.status_code}
        try:
            body = response.json()
        except ValueError:
            body = {}
        error = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
        return _smoke_post_error(
            response.status_code,
            safe_code(error.get("code"), "smoke_result_rejected"),
            sanitize_reason(error.get("message") or f"Podium returned HTTP {response.status_code}"),
        )

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
        async def smoke_poster(payload: dict[str, Any]) -> dict[str, Any]:
            return await self.post_smoke_result(payload, transport=transport)
        async with httpx.AsyncClient(timeout=10, trust_env=False, transport=transport) as client:
            lease_response = await client.post(f"{podium_url}/api/v1/runtime/commands/lease", headers=headers)
            if lease_response.status_code == 401:
                return {"status": "skipped", "reason": "runtime_unauthorized"}
            lease_response.raise_for_status()
            command = lease_response.json().get("command")
            if not command:
                return {"status": "idle"}
            try:
                result = await self.service.handle_podium_command(command, post_smoke_result=smoke_poster)
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

    async def flush_pending_smoke_results(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, int]:
        retry = getattr(self.service, "retry_pending_smoke_results", None)
        if not callable(retry):
            return {"delivered": 0, "failed": 0, "pending": 0}

        async def poster(payload: dict[str, Any]) -> dict[str, Any]:
            return await self.post_smoke_result(payload, transport=transport)

        return await retry(poster)

def _smoke_post_error(status_code: int, code: str, reason: str) -> dict[str, Any]:
    retryable = status_code == 0 or status_code == 429 or status_code >= 500
    return {
        "status": "retryable_error" if retryable else "rejected",
        "status_code": status_code,
        "error_code": code,
        "sanitized_reason": sanitize_reason(reason),
        "retryable": retryable,
        "action_required": "retry_smoke_result" if retryable else "inspect_smoke_result",
        "next_action": "retry_smoke_result" if retryable else "rerun_smoke_check",
    }
