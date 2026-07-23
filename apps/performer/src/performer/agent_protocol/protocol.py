from __future__ import annotations

from collections.abc import Mapping
from typing import Any

PROTOCOL_VERSION = 1
REQUEST_KINDS = frozenset(
    {
        "open_root_reconciler",
        "advance_root_reconciler",
        "execute_plan_turn",
        "execute_work_turn",
        "execute_verify_turn",
        "close_cycle_stage_sessions",
        "close_root_reconciler",
    }
)


class ProtocolError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.sanitized_reason = reason


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError("request_invalid", "The Performer request must be an object.")
    request = dict(value)
    _closed_keys(request, {"protocol_version", "request_id", "kind", "payload"})
    if request.get("protocol_version") != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version_unsupported", "The Performer protocol version is unsupported.")
    _text(request, "request_id")
    kind = _text(request, "kind")
    if kind not in REQUEST_KINDS:
        raise ProtocolError("request_kind_unsupported", "The Performer request kind is unsupported.")
    payload = request.get("payload")
    if not isinstance(payload, Mapping):
        raise ProtocolError("request_payload_invalid", "The Performer request payload must be an object.")
    request["payload"] = dict(payload)
    return request


def response(request_id: str, kind: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id,
        "kind": kind,
        "payload": dict(payload),
    }


def error_response(request_id: str, error: ProtocolError) -> dict[str, Any]:
    return response(
        request_id,
        "error",
        {
            "code": error.code,
            "sanitized_reason": error.sanitized_reason,
            "retryable": False,
        },
    )


def _closed_keys(value: Mapping[str, Any], expected: set[str]) -> None:
    if set(value) != expected:
        raise ProtocolError("request_shape_invalid", "The Performer request shape is invalid.")


def _text(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result or len(result) > 256:
        raise ProtocolError("request_field_invalid", "The Performer request contains an invalid field.")
    return result
