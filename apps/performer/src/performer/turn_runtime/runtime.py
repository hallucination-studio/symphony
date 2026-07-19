from __future__ import annotations

import signal
from datetime import UTC, datetime
from typing import Any

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderBackendInterface,
    ProviderTurnDeadlineExpired,
)
from performer.turn_protocol.contract_adapter import validate


class TurnRuntime:
    def __init__(self, backend: ProviderBackendInterface) -> None:
        self._backend = backend

    def run(self, command: dict[str, Any]) -> dict[str, Any]:
        command = validate("PerformerTurnCommand", command)
        deadline = datetime.fromisoformat(command["hard_deadline_at"])
        if deadline <= datetime.now(UTC):
            return self._closed_result(
                command,
                "turn_canceled",
                {"sanitized_reason": "The Turn deadline expired before execution."},
            )
        try:
            with _deadline(deadline):
                outcome = self._backend.run_turn(command)
            result_kind = _success_kind(command["turn_kind"], outcome["body"])
            return self._closed_result(
                command,
                result_kind,
                outcome["body"],
                performer_id=outcome["performer_id"],
                usage=outcome.get("usage"),
            )
        except ProviderTurnDeadlineExpired:
            return self._closed_result(
                command,
                "turn_canceled",
                {"sanitized_reason": "The Turn deadline expired during execution."},
            )
        except ProviderBackendError as error:
            return self._closed_result(
                command,
                "turn_failed",
                {
                    "error_code": error.code,
                    "sanitized_reason": error.sanitized_reason,
                    "retryable": error.retryable,
                    "action_required": error.action_required,
                },
                performer_id=command.get("performer_id"),
            )
        except Exception:
            return self._closed_result(
                command,
                "turn_failed",
                {
                    "error_code": "provider_backend_failed",
                    "sanitized_reason": "The Provider could not complete the Turn.",
                    "retryable": False,
                    "action_required": "Review the Performer profile and retry the Turn.",
                },
                performer_id=command.get("performer_id"),
            )

    def _closed_result(
        self,
        command: dict[str, Any],
        result_kind: str,
        body: dict[str, Any],
        *,
        performer_id: str | None = None,
        usage: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        result = {
            "protocol_version": command["protocol_version"],
            "turn_id": command["turn_id"],
            "turn_kind": command["turn_kind"],
            "result_kind": result_kind,
            "root_issue_id": command["root_issue_id"],
            "performer_profile_id": command["performer_profile_id"],
            "turn_input_hash": command["turn_input_hash"],
            "completed_at": datetime.now(UTC).isoformat(),
            "body": body,
        }
        if "work_issue_id" in command:
            result["work_issue_id"] = command["work_issue_id"]
        if performer_id is not None:
            result["performer_id"] = performer_id
        if usage is not None:
            result["usage"] = usage
        return validate("PerformerTurnResult", result)


class _deadline:
    def __init__(self, at: datetime) -> None:
        self.seconds = max(0.001, (at - datetime.now(UTC)).total_seconds())
        self.previous = None

    def __enter__(self):
        if not hasattr(signal, "SIGALRM"):
            return self
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


def _success_kind(turn_kind: str, body: dict[str, Any]) -> str:
    if turn_kind == "plan":
        return "plan_ready"
    if turn_kind == "work":
        return "human_input_required" if "sanitized_prompt" in body else "work_completed"
    return "root_gate_failed" if "findings" in body else "root_gate_passed"
