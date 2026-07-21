from __future__ import annotations

from pathlib import Path
from threading import Event
from typing import Any, Protocol


class ProviderStageDeadlineExpired(TimeoutError):
    pass


class ProviderStageCanceled(Exception):
    def __init__(self, sanitized_reason: str = "The Stage was canceled.") -> None:
        super().__init__(sanitized_reason)
        self.sanitized_reason = sanitized_reason


class ProviderBackendError(RuntimeError):
    def __init__(
        self,
        sanitized_reason: str,
        *,
        code: str = "provider_stage_failed",
        retryable: bool = True,
        action_required: str = "Retry the Stage.",
    ) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.sanitized_reason = sanitized_reason
        self.retryable = retryable
        self.action_required = action_required


class ProviderBackendInterface(Protocol):
    def execute_stage(
        self,
        envelope: dict[str, Any],
        workspace_root: Path,
        cancel_event: Event,
    ) -> dict[str, Any]: ...
