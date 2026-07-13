"""Private interface implemented by Performer-owned execution backends."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from performer_api import (
    PerformerCapabilities,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerControlEvent,
    PerformerTurnRequest,
    PerformerTurnResult,
)


ControlEventSink = Callable[[PerformerControlEvent], Awaitable[None] | None]


class PerformerBackend(Protocol):
    @property
    def kind(self) -> str: ...

    def capabilities(self) -> PerformerCapabilities: ...

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
        *,
        emit_event: ControlEventSink | None = None,
    ) -> PerformerControlResult: ...

    async def run_turn(self, request: PerformerTurnRequest) -> PerformerTurnResult: ...


class PerformerBackendError(RuntimeError):
    """Sanitized backend failure safe for Performer-owned operator surfaces."""

    def __init__(
        self,
        code: str,
        sanitized_reason: str,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.retryable = retryable


__all__ = ["ControlEventSink", "PerformerBackend", "PerformerBackendError"]
