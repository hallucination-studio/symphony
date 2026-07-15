from __future__ import annotations

import asyncio
import re
from typing import Any

from .desktop_commands import CommandError
from .linear_disconnect import LinearAuthorizationFailure, LinearAuthorizationLifecycle

LINEAR_COMMANDS = frozenset(
    {"linear.recover", "linear.reset_and_reconnect", "linear.disconnect"}
)
_INSTALLATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def dispatch_linear_command(
    command: str,
    input_value: dict[str, Any],
    lifecycle: LinearAuthorizationLifecycle,
) -> dict[str, str]:
    installation_id = _installation_id(input_value)
    try:
        if command == "linear.recover":
            _exact_fields(input_value, {"installation_id", "workspace_app_exists"})
            workspace_app_exists = _boolean(input_value, "workspace_app_exists")
            return asyncio.run(
                lifecycle.recover(
                    installation_id, workspace_app_exists=workspace_app_exists
                )
            )
        if command == "linear.reset_and_reconnect":
            _exact_fields(
                input_value,
                {"installation_id", "admin_confirmed"},
            )
            return asyncio.run(
                lifecycle.reset_and_reconnect(
                    installation_id,
                    admin_confirmed=_boolean(input_value, "admin_confirmed"),
                )
            )
        if command == "linear.disconnect":
            _exact_fields(input_value, {"installation_id"})
            return asyncio.run(lifecycle.disconnect(installation_id))
    except LinearAuthorizationFailure as error:
        raise CommandError(
            error.code,
            error.code,
            action_required=True,
            retryable=error.retryable,
            next_action=error.next_action,
        ) from None
    raise CommandError("desktop_command_unsupported", "command_unsupported")


def _installation_id(input_value: dict[str, Any]) -> str:
    if not isinstance(input_value, dict):
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    value = input_value.get("installation_id")
    if not isinstance(value, str) or _INSTALLATION_ID.fullmatch(value) is None:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    return value


def _exact_fields(input_value: dict[str, Any], fields: set[str]) -> None:
    if set(input_value) != fields:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")


def _boolean(input_value: dict[str, Any], field: str) -> bool:
    value = input_value[field]
    if not isinstance(value, bool):
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    return value
