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
    if command != "lifecycle.snapshot":
        raise CommandError("desktop_command_unsupported", "command_unsupported")
    if not isinstance(input_value, dict) or input_value:
        raise CommandError("desktop_command_input_invalid", "command_input_invalid")
    return asdict(lifecycle.snapshot)
