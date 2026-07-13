from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from typing import Any


class LiveRelayError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class _Request:
    request_id: str
    conductor_id: str
    operation: str
    payload: dict[str, Any]
    deadline: float
    lease_token: str | None
    future: asyncio.Future[dict[str, Any]]


class LiveConductorRelay:
    def __init__(self) -> None:
        self._requests: dict[str, _Request] = {}
        self._last_check: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def request(self, conductor_id: str, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        timeout = 15.0 if operation == "performer_credentials.inspect" else 75.0
        async with self._lock:
            self._purge()
            if any(item.conductor_id == conductor_id and item.operation == operation for item in self._requests.values()):
                raise LiveRelayError("conductor_live_query_in_progress")
            now = time.monotonic()
            if operation == "performer_credentials.check" and now - self._last_check.get(conductor_id, 0.0) < 60.0:
                raise LiveRelayError("conductor_live_check_rate_limited")
            if operation == "performer_credentials.check":
                self._last_check[conductor_id] = now
            request_id = secrets.token_urlsafe(18)
            future = asyncio.get_running_loop().create_future()
            self._requests[request_id] = _Request(request_id, conductor_id, operation, dict(payload), now + timeout, None, future)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError as exc:
            raise LiveRelayError("managed_codex_check_timeout" if operation.endswith("check") else "conductor_live_query_unavailable") from exc
        finally:
            async with self._lock:
                self._requests.pop(request_id, None)

    async def lease(self, conductor_id: str) -> dict[str, Any] | None:
        async with self._lock:
            self._purge()
            request = next((item for item in self._requests.values() if item.conductor_id == conductor_id and item.lease_token is None), None)
            if request is None:
                return None
            request.lease_token = secrets.token_urlsafe(18)
            return {
                "request_id": request.request_id,
                "operation": request.operation,
                "payload": dict(request.payload),
                "lease_token": request.lease_token,
                "deadline_unix_ms": int((time.time() + max(request.deadline - time.monotonic(), 0.0)) * 1000),
            }

    async def reply(self, conductor_id: str, request_id: str, lease_token: str, result: dict[str, Any]) -> bool:
        async with self._lock:
            self._purge()
            request = self._requests.get(request_id)
            if request is None or request.conductor_id != conductor_id or request.lease_token != lease_token or request.future.done():
                return False
            request.future.set_result(_normalize_result(request, result))
            return True

    def _purge(self) -> None:
        now = time.monotonic()
        for request_id, request in list(self._requests.items()):
            if request.deadline <= now:
                if not request.future.done():
                    request.future.cancel()
                self._requests.pop(request_id, None)


def _normalize_result(request: _Request, result: dict[str, Any]) -> dict[str, Any]:
    if request.operation == "performer_credentials.inspect":
        slots = result.get("slots") if isinstance(result.get("slots"), list) else []
        normalized_slots = []
        for slot in slots[:25]:
            if not isinstance(slot, dict):
                continue
            normalized_slots.append(
                {
                    "slot_id": str(slot.get("slot_id") or "")[:64],
                    "display_name": str(slot.get("display_name") or "")[:80],
                    "performer_kind": "codex",
                    "state": str(slot.get("state") or "blocked") if slot.get("state") in {"active", "needs_login", "blocked"} else "blocked",
                    "selected": bool(slot.get("selected")),
                    "precheck": None,
                }
            )
        selection = result.get("selection") if isinstance(result.get("selection"), dict) else None
        return {
            "version": 1,
            "conductor_id": request.conductor_id,
            "observed_at": str(result.get("observed_at") or "")[:40],
            "selection": {"slot_id": str(selection.get("slot_id") or "")[:64]} if selection else None,
            "next_cursor": str(result.get("next_cursor"))[:256] if result.get("next_cursor") else None,
            "slots": normalized_slots,
        }
    check = result.get("check") if isinstance(result.get("check"), dict) else {}
    status = "passed" if check.get("status") == "passed" else "failed"
    error_code = None if status == "passed" else str(check.get("error_code") or "managed_codex_check_failed")[:80]
    return {
        "version": 1,
        "conductor_id": request.conductor_id,
        "slot_id": str(result.get("slot_id") or request.payload.get("slot_id") or "")[:64],
        "checked_at": str(result.get("checked_at") or "")[:40],
        "check": {"status": status, "error_code": error_code, "sanitized_reason": None if status == "passed" else str(check.get("sanitized_reason") or error_code)[:160]},
    }


__all__ = ["LiveConductorRelay", "LiveRelayError"]
