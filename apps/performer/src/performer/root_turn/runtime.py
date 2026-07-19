from __future__ import annotations

import signal
import time
from datetime import UTC, datetime
from typing import Any, Callable, Protocol

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderConversationUnavailable,
    ProviderTurnDeadlineExpired,
)
from performer.contracts import validate


class RootTurnBackend(Protocol):
    def run_root_turn(self, command: dict[str, Any]) -> dict[str, Any]: ...


class RootTurnRuntime:
    def __init__(
        self,
        backend: RootTurnBackend,
        *,
        command_usage: Callable[[], dict[str, Any]] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._backend = backend
        self._command_usage = command_usage or _zero_command_usage
        self._monotonic = monotonic

    def run(self, command: dict[str, Any]) -> dict[str, Any]:
        command = validate("RootTurnCommand", command)
        started = self._monotonic()
        context_bytes = sum(
            len(command["root_context"][field].encode("utf-8"))
            for field in ("json", "markdown")
        )
        outcome: dict[str, Any] | None = None
        fields: dict[str, Any]
        if context_bytes > command["turn_limits"]["max_context_bytes"]:
            fields = {
                "result_kind": "root_turn_failed",
                "error_code": "root_context_limit_exceeded",
                "sanitized_reason": "The Root context exceeds the Turn limit.",
                "retryable": False,
                "action_required": "Reduce the bounded Root context.",
            }
        else:
            try:
                with _wall_timeout(command["turn_limits"]["max_wall_time_ms"]):
                    outcome = self._backend.run_root_turn(command)
                fields = {
                    "result_kind": "root_turn_completed",
                    **{
                        key: outcome[key]
                        for key in ("bounded_summary", "yield_reason")
                        if key in outcome
                    },
                }
            except ProviderConversationUnavailable as error:
                fields = {
                    "result_kind": "root_conversation_unavailable",
                    "error_code": error.code,
                    "sanitized_reason": error.sanitized_reason,
                }
            except ProviderTurnDeadlineExpired:
                fields = {
                    "result_kind": "root_turn_canceled",
                    "sanitized_reason": "The Root Turn wall-time limit expired.",
                }
            except ProviderBackendError as error:
                fields = {
                    "result_kind": "root_turn_failed",
                    "error_code": error.code,
                    "sanitized_reason": error.sanitized_reason,
                    "retryable": error.retryable,
                    "action_required": error.action_required,
                }
            except Exception:
                fields = {
                    "result_kind": "root_turn_failed",
                    "error_code": "provider_backend_failed",
                    "sanitized_reason": "The Provider could not complete the Root Turn.",
                    "retryable": False,
                    "action_required": "Review the Performer Profile and retry the Root.",
                }

        command_usage = self._command_usage()
        if fields["result_kind"] == "root_turn_completed" and command_usage.get(
            "limit_reached", False
        ):
            fields["yield_reason"] = "command_limit_reached"
        usage = outcome.get("usage") if outcome is not None else None
        result = {
            "protocol_version": command["protocol_version"],
            "turn_id": command["turn_id"],
            "root_issue_id": command["root_issue_id"],
            "performer_profile_id": command["performer_profile_id"],
            "performer_id": command["performer_id"],
            "context_digest": command["context_digest"],
            "completed_at": datetime.now(UTC).isoformat(),
            "turn_usage": {
                "wall_time_ms": max(0, round((self._monotonic() - started) * 1000)),
                "context_bytes": context_bytes,
                "provider_tokens": usage["total_tokens"] if usage is not None else 0,
                "broker_calls": int(command_usage.get("broker_calls", 0)),
                "mutations": int(command_usage.get("mutations", 0)),
            },
            **fields,
        }
        if usage is not None:
            result["usage"] = usage
        return validate("RootTurnResult", result)


class _wall_timeout:
    def __init__(self, milliseconds: int) -> None:
        self.seconds = milliseconds / 1000
        self.previous = None

    def __enter__(self):
        if hasattr(signal, "SIGALRM"):
            self.previous = signal.signal(signal.SIGALRM, self._expire)
            signal.setitimer(signal.ITIMER_REAL, self.seconds)
        return self

    def __exit__(self, *_):
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.previous)

    @staticmethod
    def _expire(*_) -> None:
        raise ProviderTurnDeadlineExpired


def _zero_command_usage() -> dict[str, int]:
    return {"broker_calls": 0, "mutations": 0}
