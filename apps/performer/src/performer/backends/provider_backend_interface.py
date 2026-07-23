from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Any, Protocol


class ProviderTurnDeadlineExpired(TimeoutError):
    pass


class ProviderTurnCanceled(Exception):
    def __init__(self, sanitized_reason: str = "The Provider turn was canceled.") -> None:
        super().__init__(sanitized_reason)
        self.sanitized_reason = sanitized_reason


class ProviderBackendError(RuntimeError):
    def __init__(
        self,
        sanitized_reason: str,
        *,
        code: str = "provider_turn_failed",
        retryable: bool = True,
        action_required: str = "Retry the turn with a fresh Provider context.",
    ) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.sanitized_reason = sanitized_reason
        self.retryable = retryable
        self.action_required = action_required


@dataclass(frozen=True)
class ProviderSession:
    role: str
    provider_handle: Any
    settings: dict[str, Any] | None = None


class ProviderBackendInterface(Protocol):
    def open_role_session(self, role: str, settings: dict[str, Any]) -> ProviderSession: ...

    def execute_role_turn(
        self,
        session: ProviderSession,
        request: dict[str, Any],
        *,
        workspace_root: Path | None,
        cancel_event: Event,
    ) -> dict[str, Any]: ...

    def interrupt_turn(self, session: ProviderSession) -> None: ...

    def close_role_session(self, session: ProviderSession) -> None: ...
