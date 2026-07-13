from __future__ import annotations

import asyncio
import base64
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from performer_api import PerformerControlEvent, PerformerControlResult


LIVE_OPERATIONS = frozenset(
    {
        "performer.status",
        "performer.login",
        "performer.session.delete",
        "performer.config.read",
        "performer.config.write",
        "performer.check",
    }
)
_SHORT_OPERATIONS = frozenset({"performer.status", "performer.config.read"})
_LOGIN_METHODS = frozenset({"device_code", "api_key"})
_SESSION_ACTIONS = frozenset({"cancel_login", "logout"})
_SECRET_MARKER = re.compile(
    r"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|"
    r"password|cookie|client[_-]?secret|credential|secret)"
)
_PATH_MARKER = re.compile(r"(?:^|[\s\"'=])/(?!/)[^\s\"']+")


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
    """In-memory, no-store relay for closed Performer control exchanges."""

    def __init__(self) -> None:
        self._requests: dict[str, _Request] = {}
        self._last_check: dict[str, float] = {}
        self._lock = asyncio.Lock()

    @property
    def pending_count(self) -> int:
        return len(self._requests)

    async def request(
        self, conductor_id: str, operation: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if operation not in LIVE_OPERATIONS:
            raise LiveRelayError("performer_live_operation_unsupported")
        normalized_payload = _normalize_request(operation, payload)
        timeout = 15.0 if operation in _SHORT_OPERATIONS else 75.0
        async with self._lock:
            self._purge()
            if any(
                item.conductor_id == conductor_id and item.operation == operation
                for item in self._requests.values()
            ):
                raise LiveRelayError("performer_live_operation_in_progress")
            now = time.monotonic()
            if operation == "performer.check" and now - self._last_check.get(
                conductor_id, 0.0
            ) < 60.0:
                raise LiveRelayError("performer_live_check_rate_limited")
            if operation == "performer.check":
                self._last_check[conductor_id] = now
            request_id = "live_" + secrets.token_urlsafe(18)
            future = asyncio.get_running_loop().create_future()
            self._requests[request_id] = _Request(
                request_id,
                conductor_id,
                operation,
                normalized_payload,
                now + timeout,
                None,
                future,
            )
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError as exc:
            code = (
                "performer_live_check_timeout"
                if operation == "performer.check"
                else "performer_live_operation_unavailable"
            )
            raise LiveRelayError(code) from exc
        finally:
            async with self._lock:
                self._requests.pop(request_id, None)

    async def lease(self, conductor_id: str) -> dict[str, Any] | None:
        async with self._lock:
            self._purge()
            request = next(
                (
                    item
                    for item in self._requests.values()
                    if item.conductor_id == conductor_id and item.lease_token is None
                ),
                None,
            )
            if request is None:
                return None
            request.lease_token = secrets.token_urlsafe(18)
            return {
                "request_id": request.request_id,
                "operation": request.operation,
                "payload": dict(request.payload),
                "lease_token": request.lease_token,
                "deadline_unix_ms": int(
                    (
                        time.time()
                        + max(request.deadline - time.monotonic(), 0.0)
                    )
                    * 1000
                ),
            }

    async def reply(
        self,
        conductor_id: str,
        request_id: str,
        lease_token: str,
        result: dict[str, Any],
        *,
        events: list[dict[str, Any]] | None = None,
    ) -> bool:
        async with self._lock:
            self._purge()
            request = self._requests.get(request_id)
            if (
                request is None
                or request.conductor_id != conductor_id
                or request.lease_token != lease_token
                or request.future.done()
            ):
                return False
            try:
                normalized = _normalize_result(request, result, events or [])
            except LiveRelayError as exc:
                if not request.future.done():
                    request.future.set_exception(exc)
                self._requests.pop(request_id, None)
                raise
            request.future.set_result(normalized)
            return True

    def _purge(self) -> None:
        now = time.monotonic()
        for request_id, request in list(self._requests.items()):
            if request.deadline <= now:
                if not request.future.done():
                    code = (
                        "performer_live_check_timeout"
                        if request.operation == "performer.check"
                        else "performer_live_operation_unavailable"
                    )
                    request.future.set_exception(LiveRelayError(code))
                self._requests.pop(request_id, None)


def _normalize_request(operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise LiveRelayError("performer_live_request_invalid")
    try:
        if operation in {"performer.status", "performer.config.read", "performer.check"}:
            _exact_keys(payload, set())
            return {}
        if operation == "performer.login":
            method = payload.get("method")
            if method not in _LOGIN_METHODS:
                raise ValueError
            expected = {"method", "api_key"} if method == "api_key" else {"method"}
            _exact_keys(payload, expected)
            normalized = {"method": method}
            if method == "api_key":
                api_key = payload.get("api_key")
                if not isinstance(api_key, str) or not 1 <= len(api_key.encode()) <= 64 * 1024:
                    raise ValueError
                normalized["api_key"] = api_key
            return normalized
        if operation == "performer.session.delete":
            _exact_keys(payload, {"action"})
            if payload.get("action") not in _SESSION_ACTIONS:
                raise ValueError
            return {"action": payload["action"]}
        if operation == "performer.config.write":
            _exact_keys(payload, {"setting", "value"})
            if payload.get("setting") != "api_base_url":
                raise ValueError
            value = payload.get("value")
            if not isinstance(value, str) or len(value.encode()) > 2_048:
                raise ValueError
            parsed = urlsplit(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
            ):
                raise ValueError
            return {"setting": "api_base_url", "value": value}
    except (TypeError, ValueError):
        raise LiveRelayError("performer_live_request_invalid") from None
    raise LiveRelayError("performer_live_operation_unsupported")


def _normalize_result(
    request: _Request,
    result: dict[str, Any],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    try:
        if not isinstance(result, dict) or not isinstance(events, list) or len(events) > 32:
            raise ValueError
        control_result = PerformerControlResult.from_dict(result)
        if (
            control_result.request_id != request.request_id
            or control_result.operation != request.operation
        ):
            raise ValueError
        normalized_events = []
        last_sequence = 0
        for raw_event in events:
            if not isinstance(raw_event, dict):
                raise ValueError
            event = PerformerControlEvent.from_dict(raw_event)
            if (
                event.request_id != request.request_id
                or event.operation != request.operation
                or event.sequence <= last_sequence
            ):
                raise ValueError
            last_sequence = event.sequence
            normalized_events.append(event.to_dict())
        normalized = {
            "control_result": control_result.to_dict(),
            "events": normalized_events,
        }
        if _contains_disallowed_output(normalized):
            raise ValueError
        return normalized
    except (TypeError, ValueError):
        raise LiveRelayError("performer_live_result_invalid") from None


def _exact_keys(payload: dict[str, Any], expected: set[str]) -> None:
    if set(payload) != expected:
        raise ValueError
    for key in payload:
        if _SECRET_MARKER.search(str(key)) and key != "api_key":
            raise ValueError


def _contains_disallowed_output(value: Any) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = str(key).lower().replace("-", "_")
            if _SECRET_MARKER.search(normalized) and normalized != "user_code":
                return True
            if normalized in {
                "path",
                "cwd",
                "sdk",
                "raw",
                "raw_sdk",
                "provider_payload",
            }:
                return True
            if _contains_disallowed_output(nested):
                return True
        return False
    if isinstance(value, list):
        return any(_contains_disallowed_output(item) for item in value)
    if not isinstance(value, str):
        return False
    if _PATH_MARKER.search(value):
        return True
    compact = value.strip()
    if len(compact) < 128 or len(compact) % 4:
        return False
    if re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", compact) is None:
        return False
    try:
        return bool(base64.b64decode(compact, validate=True))
    except ValueError:
        return False


__all__ = ["LIVE_OPERATIONS", "LiveConductorRelay", "LiveRelayError"]
