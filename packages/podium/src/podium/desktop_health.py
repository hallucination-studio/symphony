from __future__ import annotations

from typing import Any

from .desktop_protocol import PROTOCOL_VERSION, ProtocolError

REQUEST_KINDS = frozenset({"handshake", "health", "shutdown"})


def handle_request(payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if set(payload) != {"kind", "request_id", "protocol_version"}:
        raise ProtocolError("request_fields_invalid")
    kind = payload["kind"]
    request_id = payload["request_id"]
    if kind not in REQUEST_KINDS or not isinstance(request_id, str) or not request_id:
        raise ProtocolError("request_invalid")
    if payload["protocol_version"] != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version_unsupported")
    stopping = kind == "shutdown"
    return (
        {
            "kind": f"{kind}.result",
            "request_id": request_id,
            "protocol_version": PROTOCOL_VERSION,
            "status": "stopping" if stopping else "ready",
        },
        stopping,
    )
