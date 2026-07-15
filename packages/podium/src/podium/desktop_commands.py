from __future__ import annotations

from dataclasses import asdict
from typing import Any

from .desktop_app import DesktopLifecycle


class CommandError(ValueError):
    def __init__(
        self,
        code: str,
        sanitized_reason: str,
        *,
        action_required: bool = False,
        retryable: bool = False,
        next_action: str = "none",
    ) -> None:
        super().__init__(code)
        self.code = code
        self.sanitized_reason = sanitized_reason
        self.action_required = action_required
        self.retryable = retryable
        self.next_action = next_action

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "sanitized_reason": self.sanitized_reason,
            "action_required": self.action_required,
            "retryable": self.retryable,
            "next_action": self.next_action,
        }


def dispatch_command(
    command: str, input_value: dict[str, Any], lifecycle: DesktopLifecycle
) -> dict[str, Any]:
    if command == "lifecycle.snapshot":
        if not isinstance(input_value, dict) or input_value:
            raise CommandError("desktop_command_input_invalid", "command_input_invalid")
        return asdict(lifecycle.snapshot)
    from .desktop_commands_conductors import (
        CONDUCTOR_COMMANDS,
        dispatch_conductor_command,
    )
    from .desktop_commands_linear import LINEAR_COMMANDS, dispatch_linear_command

    if command in CONDUCTOR_COMMANDS:
        if lifecycle.store is None:
            raise CommandError(
                "desktop_lifecycle_unavailable",
                "lifecycle_unavailable",
                action_required=True,
                next_action="restart_desktop",
            )
        from .store.bindings import BindingRepository

        return dispatch_conductor_command(
            command,
            input_value,
            BindingRepository(lifecycle.store.connection),
        )
    if command not in LINEAR_COMMANDS:
        raise CommandError("desktop_command_unsupported", "command_unsupported")
    if lifecycle.linear_authorization is None:
        raise CommandError(
            "linear_authorization_unavailable",
            "linear_authorization_unavailable",
            action_required=True,
            next_action="restart_desktop",
        )
    return dispatch_linear_command(
        command, input_value, lifecycle.linear_authorization
    )
