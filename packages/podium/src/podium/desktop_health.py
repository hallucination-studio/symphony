from __future__ import annotations

from typing import Any

from .desktop_app import DesktopLifecycle
from .desktop_protocol import PROTOCOL_VERSION, ProtocolError

REQUEST_KINDS = frozenset({"handshake", "health", "shutdown"})


def handle_request(
    payload: dict[str, Any], lifecycle: DesktopLifecycle | None = None
) -> tuple[dict[str, Any], bool]:
    if set(payload) != {"kind", "request_id", "protocol_version"}:
        raise ProtocolError("request_fields_invalid")
    kind = payload["kind"]
    request_id = payload["request_id"]
    if kind not in REQUEST_KINDS or not isinstance(request_id, str) or not request_id:
        raise ProtocolError("request_invalid")
    if payload["protocol_version"] != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version_unsupported")
    stopping = kind == "shutdown"
    status = "ready"
    if lifecycle is not None:
        if stopping:
            lifecycle.shutdown()
            status = "stopping"
        else:
            status = lifecycle.snapshot.status
    response = {
        "kind": f"{kind}.result",
        "request_id": request_id,
        "protocol_version": PROTOCOL_VERSION,
        "status": "stopping" if stopping else status,
    }
    if lifecycle is not None and status in {"failed", "degraded"}:
        response.update(
            {
                "error_code": lifecycle.snapshot.error_code,
                "sanitized_reason": lifecycle.snapshot.sanitized_reason,
                "action_required": lifecycle.snapshot.action_required,
                "retryable": lifecycle.snapshot.retryable,
                "next_action": lifecycle.snapshot.next_action,
            }
        )
    return response, stopping
