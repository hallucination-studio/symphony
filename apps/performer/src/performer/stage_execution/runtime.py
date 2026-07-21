from __future__ import annotations

import json
import signal
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any, Callable

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderBackendInterface,
    ProviderStageCanceled,
    ProviderStageDeadlineExpired,
)
from performer.contracts import validate


class StageExecutionRuntime:
    def __init__(
        self,
        backend: ProviderBackendInterface,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._backend = backend
        self._now = now or (lambda: datetime.now(UTC))

    def run(
        self,
        envelope: dict[str, Any],
        workspace_root: Path,
        *,
        cancel_event: Event | None = None,
        emit_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        envelope = validate("StageContextEnvelope", envelope)
        cancel_event = cancel_event or Event()
        emit = emit_event or _discard_event
        stage = envelope["stage_execution"]["stage"]
        correlation = _correlation(envelope)
        _emit_safely(emit, _event(correlation, 0, {"kind": "started"}))

        if _context_bytes(envelope) > envelope["limits"]["max_context_bytes"]:
            return self._result(
                envelope,
                {"kind": "execution_failed", "error_code": "stage_context_limit_exceeded",
                 "sanitized_reason": "The Stage context exceeds the configured limit.",
                 "retryable": False},
            )
        capability_error = _capability_error(envelope)
        if capability_error is not None:
            return self._result(envelope, capability_error)
        if cancel_event.is_set():
            return self._result(envelope, _canceled())

        try:
            outcome = self._run_backend(envelope, workspace_root, cancel_event)
            result = self._result(
                envelope,
                outcome.get("outcome"),
                usage=outcome.get("usage"),
            )
        except ProviderStageCanceled as error:
            result = self._result(envelope, {
                "kind": "canceled", "sanitized_reason": error.sanitized_reason,
            })
        except ProviderStageDeadlineExpired:
            result = self._result(envelope, {
                "kind": "canceled", "sanitized_reason": "The Stage deadline expired.",
            })
        except ProviderBackendError as error:
            result = self._result(envelope, {
                "kind": "execution_failed", "error_code": error.code,
                "sanitized_reason": error.sanitized_reason,
                "retryable": error.retryable,
            })
        except (TypeError, ValueError, KeyError):
            result = self._result(envelope, {
                "kind": "execution_failed", "error_code": "stage_provider_output_invalid",
                "sanitized_reason": "The Provider returned an invalid Stage result.",
                "retryable": False,
            })
        except Exception:
            result = self._result(envelope, {
                "kind": "execution_failed", "error_code": "stage_runtime_failed",
                "sanitized_reason": "The Performer could not complete the Stage.",
                "retryable": False,
            })

        if _serialized_bytes(result) > envelope["limits"]["max_result_bytes"]:
            result = self._result(envelope, {
                "kind": "execution_failed", "error_code": "stage_result_limit_exceeded",
                "sanitized_reason": "The Stage result exceeds the configured limit.",
                "retryable": False,
            })
        _emit_safely(emit, _event(correlation, 1, {"kind": "heartbeat"}))
        return result

    def _run_backend(
        self,
        envelope: dict[str, Any],
        workspace_root: Path,
        cancel_event: Event,
    ) -> dict[str, Any]:
        deadline = _deadline_seconds(envelope, self._now())
        with _wall_timeout(deadline):
            return self._backend.execute_stage(envelope, workspace_root, cancel_event)

    def _result(
        self,
        envelope: dict[str, Any],
        outcome: Any,
        *,
        usage: Any = None,
    ) -> dict[str, Any]:
        if not isinstance(outcome, dict):
            outcome = {
                "kind": "execution_failed", "error_code": "stage_provider_output_invalid",
                "sanitized_reason": "The Provider returned an invalid Stage result.",
                "retryable": False,
            }
        result = {
            **_correlation(envelope),
            "completed_at": _timestamp(self._now()),
            "outcome": outcome,
        }
        if isinstance(usage, dict):
            result["usage"] = usage
        validated = validate("StageResult", result)
        if validated["stage"] != envelope["stage_execution"]["stage"]:
            raise ValueError("stage_result_correlation_invalid")
        if not _outcome_matches_stage(validated["stage"], validated["outcome"]["kind"]):
            return validate("StageResult", {
                **_correlation(envelope),
                "completed_at": _timestamp(self._now()),
                "outcome": {
                    "kind": "execution_failed", "error_code": "stage_outcome_mismatch",
                    "sanitized_reason": "The Provider returned the wrong Stage outcome.",
                    "retryable": False,
                },
            })
        return validated


def _capability_error(envelope: dict[str, Any]) -> dict[str, Any] | None:
    stage = envelope["stage_execution"]["stage"]
    access = envelope["repository_context"]["workspace_access"]
    sandbox = envelope["execution_policy"]["sandbox_mode"]
    expected_access = "read_only" if stage in {"plan", "verify"} else "read_write"
    expected_sandbox = "read_only" if stage in {"plan", "verify"} else "workspace_write"
    if access != expected_access or sandbox != expected_sandbox:
        return {
            "kind": "execution_failed", "error_code": "stage_capability_invalid",
            "sanitized_reason": "The Stage capability does not match its stage.",
            "retryable": False,
        }
    return None


def _outcome_matches_stage(stage: str, kind: str) -> bool:
    return kind in {"suspended", "execution_failed", "canceled"} or kind == f"{stage}_completed"


def _correlation(envelope: dict[str, Any]) -> dict[str, Any]:
    return {
        "protocol_version": envelope["protocol_version"],
        "stage_execution_id": envelope["stage_execution"]["stage_execution_id"],
        "stage": envelope["stage_execution"]["stage"],
        "root_issue_id": envelope["target"]["root_issue_id"],
        "cycle_issue_id": envelope["target"]["cycle_issue_id"],
        "node_issue_id": envelope["target"]["node_issue_id"],
        "context_digest": envelope["context_digest"],
    }


def _event(correlation: dict[str, Any], sequence: int, body: dict[str, Any]) -> dict[str, Any]:
    return validate("StageEvent", {
        **correlation,
        "sequence": sequence,
        "occurred_at": _timestamp(datetime.now(UTC)),
        "body": body,
    })


def _canceled() -> dict[str, Any]:
    return {"kind": "canceled", "sanitized_reason": "The Stage was canceled."}


def _context_bytes(envelope: dict[str, Any]) -> int:
    return _serialized_bytes(envelope)


def _serialized_bytes(value: dict[str, Any]) -> int:
    return len(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def _deadline_seconds(envelope: dict[str, Any], now: datetime) -> float:
    deadline = datetime.fromisoformat(envelope["stage_execution"]["deadline_at"].replace("Z", "+00:00"))
    remaining = (deadline - now).total_seconds()
    configured = envelope["limits"]["max_wall_time_ms"] / 1000
    if remaining <= 0:
        raise ProviderStageDeadlineExpired
    return min(configured, remaining)


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _discard_event(_: dict[str, Any]) -> None:
    return None


def _emit_safely(emit: Callable[[dict[str, Any]], None], event: dict[str, Any]) -> None:
    try:
        emit(event)
    except Exception:
        pass


class _wall_timeout:
    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self.previous = None

    def __enter__(self) -> _wall_timeout:
        if hasattr(signal, "SIGALRM"):
            self.previous = signal.signal(signal.SIGALRM, self._expire)
            signal.setitimer(signal.ITIMER_REAL, self.seconds)
        return self

    def __exit__(self, *_: object) -> None:
        if hasattr(signal, "SIGALRM"):
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.previous)

    @staticmethod
    def _expire(*_: object) -> None:
        raise ProviderStageDeadlineExpired
