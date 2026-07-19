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


class ProviderConversationUnavailable(ProviderBackendError):
    def __init__(self, code: str) -> None:
        if code not in {"conversation_not_found", "conversation_unrecoverable"}:
            raise ValueError("provider_conversation_error_invalid")
        super().__init__(
            "The Provider conversation is unavailable.",
            code=code,
            retryable=False,
            action_required="Retry the Root with a new conversation.",
        )


class ProviderBackendInterface(Protocol):
    def open_conversation(self, command: dict[str, Any]) -> dict[str, Any]: ...

    def run_root_turn(self, command: dict[str, Any]) -> dict[str, Any]: ...

    def run_turn(self, command: dict[str, Any]) -> dict[str, Any]: ...
