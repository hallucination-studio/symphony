from __future__ import annotations

from typing import Any, Protocol


class ProviderTurnDeadlineExpired(TimeoutError):
    pass


class ProviderBackendError(RuntimeError):
    def __init__(
        self,
        sanitized_reason: str,
        *,
        code: str = "provider_turn_failed",
        retryable: bool = True,
        action_required: str = "Retry the Turn.",
    ) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.sanitized_reason = sanitized_reason
        self.retryable = retryable
        self.action_required = action_required


class ProviderBackendInterface(Protocol):
    def run_turn(self, command: dict[str, Any]) -> dict[str, Any]: ...
