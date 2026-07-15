from __future__ import annotations

import re
from typing import Any

from .desktop_app import DesktopLifecycle
from .desktop_commands import CommandError, dispatch_command
from .desktop_protocol import PROTOCOL_VERSION, ProtocolError

REQUEST_KINDS = frozenset({"handshake", "health", "shutdown", "command"})
BASE_FIELDS = frozenset({"kind", "request_id", "protocol_version"})
COMMAND_FIELDS = BASE_FIELDS | {"command", "input"}
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def handle_request(
    payload: dict[str, Any], lifecycle: DesktopLifecycle | None = None
) -> tuple[dict[str, Any], bool]:
    kind = payload.get("kind")
    expected_fields = COMMAND_FIELDS if kind == "command" else BASE_FIELDS
    if set(payload) != expected_fields:
        raise ProtocolError("request_fields_invalid")
    request_id = payload["request_id"]
    if (
        kind not in REQUEST_KINDS
        or not isinstance(request_id, str)
        or REQUEST_ID.fullmatch(request_id) is None
    ):
        raise ProtocolError("request_invalid")
    if payload["protocol_version"] != PROTOCOL_VERSION:
        raise ProtocolError("protocol_version_unsupported")
    if kind == "command":
        return _handle_command(payload, lifecycle), False
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


def _handle_command(
    payload: dict[str, Any], lifecycle: DesktopLifecycle | None
) -> dict[str, Any]:
    raw_command = payload["command"]
    command = "lifecycle.snapshot" if raw_command == "lifecycle.snapshot" else "unknown"
    response: dict[str, Any] = {
        "kind": "command.result",
        "request_id": payload["request_id"],
        "protocol_version": PROTOCOL_VERSION,
        "command": command,
    }
    try:
        if not isinstance(raw_command, str) or not raw_command:
            raise CommandError("desktop_command_invalid", "command_invalid")
        if lifecycle is None:
            raise CommandError(
                "desktop_lifecycle_unavailable",
                "lifecycle_unavailable",
                action_required=True,
                next_action="restart_desktop",
            )
        response.update(
            {
                "ok": True,
                "output": dispatch_command(raw_command, payload["input"], lifecycle),
            }
        )
    except CommandError as error:
        response.update({"ok": False, "error": error.to_dict()})
    return response
