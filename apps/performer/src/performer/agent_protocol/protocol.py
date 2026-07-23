from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from performer.contracts import validate

PROTOCOL_VERSION = "1"
REQUEST_KINDS = frozenset(
    {
        "open_root_reconciler",
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
    if set(request) < {"protocol_version", "request_id"}:
        raise ProtocolError("request_shape_invalid", "The Performer request shape is invalid.")
    if "payload" in request:
        raise ProtocolError("request_shape_invalid", "The Performer request shape is invalid.")
    if request.get("protocol_version") != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version_unsupported", "The Performer protocol version is unsupported.")
    request_id = _text(request, "request_id")
    kind = request.get("kind")
    if kind is None:
        if "reconciler_session_id" in request:
            _validate_contract("RootReconcilerObservation", request, request_id)
            return request
        role = request.get("role")
        stage_contract = {"plan": "PlanTurnRequest", "work": "WorkTurnRequest", "verify": "VerifyTurnRequest"}.get(role)
        if stage_contract is None:
            raise ProtocolError("request_shape_invalid", "The Performer request shape is invalid.")
        _validate_contract(stage_contract, request, request_id)
        return request
    if not isinstance(kind, str) or kind not in REQUEST_KINDS:
        raise ProtocolError("request_kind_unsupported", "The Performer request kind is unsupported.")
    required_fields = {
        "open_root_reconciler": {"root_issue_id", "performer_profile_id", "model_settings", "execution_policy", "limits"},
        "close_cycle_stage_sessions": {"root_issue_id", "cycle_issue_id", "reason"},
        "close_root_reconciler": {"root_issue_id", "reason"},
    }[kind]
    if not required_fields.issubset(request):
        raise ProtocolError("request_shape_invalid", "The Performer request shape is invalid.")
    contract_name = {
        "open_root_reconciler": "OpenRootReconcilerRequest",
        "close_cycle_stage_sessions": "CloseCycleStageSessionsCommand",
        "close_root_reconciler": "CloseRootReconcilerCommand",
    }[kind]
    _validate_contract(contract_name, request, request_id)
    return request


def _validate_contract(name: str, request: dict[str, Any], request_id: str) -> None:
    try:
        validate(name, request)
    except ValueError as error:
        raise ProtocolError("request_shape_invalid", "The Performer request does not match its closed contract.") from error


def response(request_id: str, kind: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id,
        "kind": kind,
        **dict(payload),
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


def _text(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result or len(result) > 256:
        raise ProtocolError("request_field_invalid", "The Performer request contains an invalid field.")
    return result
