from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from threading import Event
from typing import Any, Literal, Protocol


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


@dataclass(frozen=True)
class ProviderTurnFailure:
    code: str
    sanitized_reason: str
    retryable: bool
    action_required: str


@dataclass(frozen=True)
class ProviderTurnNotAccepted:
    failure: ProviderTurnFailure
    kind: Literal["not_accepted"] = field(default="not_accepted", init=False)


@dataclass(frozen=True)
class ProviderTurnAcceptedValid:
    output: dict[str, Any]
    usage: dict[str, Any]
    kind: Literal["accepted_valid"] = field(default="accepted_valid", init=False)


@dataclass(frozen=True)
class ProviderTurnAcceptedInvalid:
    failure: ProviderTurnFailure
    usage: dict[str, Any] | None = None
    kind: Literal["accepted_invalid"] = field(default="accepted_invalid", init=False)


@dataclass(frozen=True)
class ProviderTurnAcceptanceUnknown:
    failure: ProviderTurnFailure
    kind: Literal["acceptance_unknown"] = field(default="acceptance_unknown", init=False)


@dataclass(frozen=True)
class ProviderTurnSessionLost:
    failure: ProviderTurnFailure
    kind: Literal["session_lost"] = field(default="session_lost", init=False)


@dataclass(frozen=True)
class ProviderTurnCanceled:
    append_outcome: Literal["accepted", "acceptance_unknown"]
    deadline_expired: bool
    sanitized_reason: str
    usage: dict[str, Any] | None = None
    kind: Literal["canceled"] = field(default="canceled", init=False)


ProviderTurnOutcome = (
    ProviderTurnNotAccepted
    | ProviderTurnAcceptedValid
    | ProviderTurnAcceptedInvalid
    | ProviderTurnAcceptanceUnknown
    | ProviderTurnSessionLost
    | ProviderTurnCanceled
)


class ProviderBackendInterface(Protocol):
    def open_role_session(self, role: str, settings: dict[str, Any]) -> ProviderSession: ...

    def execute_role_turn(
        self,
        session: ProviderSession,
        request: dict[str, Any],
        *,
        workspace_root: Path | None,
        cancel_event: Event,
    ) -> ProviderTurnOutcome: ...

    def interrupt_turn(self, session: ProviderSession) -> None: ...

    def close_role_session(self, session: ProviderSession) -> None: ...
