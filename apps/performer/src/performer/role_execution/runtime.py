from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any, Callable, Literal

from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderTurnCanceled,
    ProviderTurnDeadlineExpired,
)
from performer.session_runtime.manager import SessionError, SessionManager

StageRole = Literal["plan", "work", "verify"]


class RoleExecutionRuntime:
    """Runs one validated role turn and returns a closed fact envelope."""

    def __init__(
        self,
        sessions: SessionManager,
        *,
        now: Callable[[], datetime] | None = None,
        workspace_root: Path | None = None,
    ) -> None:
        self._sessions = sessions
        self._now = now or (lambda: datetime.now(UTC))
        self._workspace_root = workspace_root

    def execute_root_reconciler(self, request: dict[str, Any], cancel_event: Event | None = None) -> dict[str, Any]:
        return self._execute("root_reconciler", request, cancel_event=cancel_event)

    def execute_plan(self, request: dict[str, Any], cancel_event: Event | None = None) -> dict[str, Any]:
        return self._execute("plan", request, cancel_event=cancel_event)

    def execute_work(self, request: dict[str, Any], cancel_event: Event | None = None) -> dict[str, Any]:
        return self._execute("work", request, cancel_event=cancel_event)

    def execute_verify(self, request: dict[str, Any], cancel_event: Event | None = None) -> dict[str, Any]:
        return self._execute("verify", request, cancel_event=cancel_event)

    def _execute(self, role: str, request: dict[str, Any], *, cancel_event: Event | None) -> dict[str, Any]:
        cancel_event = cancel_event or Event()
        root_issue_id = _required_text(request, "root_issue_id")
        cycle_issue_id = _optional_text(request, "cycle_issue_id")
        session_key = "reconciler_session_id" if role == "root_reconciler" else "role_session_id"
        turn_key = "reconciler_turn_id" if role == "root_reconciler" else "role_turn_id"
        session_id = _required_text(request, session_key)
        turn_id = _required_text(request, turn_key)
        record = self._sessions.get(
            session_id,
            role=role,  # type: ignore[arg-type]
            root_issue_id=root_issue_id,
            cycle_issue_id=cycle_issue_id,
        )
        _validate_turn_scope(role, request)
        if cancel_event.is_set():
            return _terminal(request, role, {"kind": "canceled", "sanitized_reason": "The turn was canceled."}, self._now())
        deadline = _deadline(request)
        if deadline is not None and deadline <= self._now():
            return _terminal(request, role, {"kind": "canceled", "sanitized_reason": "The turn deadline expired."}, self._now())
        output: dict[str, Any] | None = None
        try:
            output = self._sessions.execute(
                record,
                request,
                workspace_root=self._workspace_root,
                cancel_event=cancel_event,
            )
            result = _provider_output(output, role)
        except ProviderTurnCanceled as error:
            result = {"kind": "canceled", "sanitized_reason": error.sanitized_reason}
        except ProviderTurnDeadlineExpired:
            result = {"kind": "canceled", "sanitized_reason": "The turn deadline expired."}
        except ProviderBackendError as error:
            result = {
                "kind": "execution_failed",
                "error_code": error.code,
                "sanitized_reason": error.sanitized_reason,
                "retryable": error.retryable,
            }
        except (KeyError, TypeError, ValueError, SessionError):
            result = {
                "kind": "execution_failed",
                "error_code": "performer_turn_invalid",
                "sanitized_reason": "The Performer could not validate the turn result.",
                "retryable": False,
            }
        except Exception:
            result = {
                "kind": "execution_failed",
                "error_code": "performer_turn_failed",
                "sanitized_reason": "The Performer could not complete the turn.",
                "retryable": False,
            }
        if cancel_event.is_set() and result.get("kind") not in {"canceled", "execution_failed"}:
            result = {"kind": "canceled", "sanitized_reason": "The turn was canceled."}
        return _terminal(request, role, result, self._now(), output if isinstance(output, dict) else None)


def _validate_turn_scope(role: str, request: dict[str, Any]) -> None:
    if role == "root_reconciler":
        _required_text(request, "root_issue_id")
        if request.get("kind") == "open_root_reconciler":
            bootstrap = request.get("bootstrap")
            if not isinstance(bootstrap, dict):
                raise ValueError("root_bootstrap_invalid")
            _required_text(bootstrap, "root_digest")
        elif request.get("kind") == "advance_root_reconciler":
            delta = request.get("delta")
            if not isinstance(delta, dict):
                raise ValueError("root_delta_invalid")
            _required_text(delta, "base_root_digest")
            _required_text(delta, "target_root_digest")
        else:
            raise ValueError("root_reconciler_command_invalid")
        if "cycle_issue_id" in request and request["cycle_issue_id"] is not None:
            raise ValueError("root_reconciler_cycle_scope_invalid")
        return
    _required_text(request, "cycle_issue_id")
    _required_text(request, "stage_execution_id")
    _required_text(request, "observed_tree_digest")
    _required_text(request, "target_issue_id")
    policy = request.get("execution_policy")
    repository_context = request.get("repository_context")
    if isinstance(policy, dict):
        expected = "workspace_write" if role == "work" else "read_only"
        expected_access = "read_write" if role == "work" else "read_only"
        if policy.get("sandbox_mode") != expected or not isinstance(repository_context, dict) or repository_context.get("workspace_access") != expected_access:
            raise ValueError("role_capability_invalid")
    if role == "work":
        context = request.get("context")
        if not isinstance(context, dict) or context.get("workspace_capability") != "workspace_write":
            raise ValueError("workspace_capability_invalid")


def _terminal(
    request: dict[str, Any],
    role: str,
    result: dict[str, Any],
    completed_at: datetime,
    provider_output: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if role == "root_reconciler":
        payload = {
            "protocol_version": "1",
            "request_id": request["request_id"],
            "reconciler_session_id": request["reconciler_session_id"],
            "reconciler_turn_id": request["reconciler_turn_id"],
            "root_issue_id": request["root_issue_id"],
        }
        if result.get("kind") in {"execution_failed", "canceled"}:
            payload["directive"] = result
        else:
            payload["directive"] = {
                "protocol_version": "1",
                "request_id": request["request_id"],
                "root_directive_id": f"{request['root_issue_id']}:{request['reconciler_turn_id']}",
                "reconciler_session_id": request["reconciler_session_id"],
                "reconciler_turn_id": request["reconciler_turn_id"],
                "based_on_target_root_digest": _root_target_digest(request),
                "rationale": result["rationale"],
                "evidence_refs": result["evidence_refs"],
                "consumed_input_ids": result["consumed_input_ids"],
                "comment_replies": result["comment_replies"],
                "human_action_resolutions": result["human_action_resolutions"],
                "action": result["action"],
            }
        payload["completed_at"] = _timestamp(completed_at)
        if provider_output and provider_output.get("usage") is not None:
            payload["usage"] = provider_output["usage"]
        return payload
    payload = {
        "protocol_version": "1",
        "request_id": request["request_id"],
        "role": role,
        "role_session_id": request["role_session_id"],
        "role_turn_id": request["role_turn_id"],
        "stage_execution_id": request["stage_execution_id"],
        "root_issue_id": request["root_issue_id"],
        "cycle_issue_id": request["cycle_issue_id"],
        "target_issue_id": request.get("target_issue_id"),
        "observed_tree_digest": request["observed_tree_digest"],
        "context_digest": request.get("context_digest"),
        "outcome": result,
        "completed_at": _timestamp(completed_at),
    }
    if provider_output and provider_output.get("usage") is not None:
        payload["usage"] = provider_output["usage"]
    return payload


def _provider_output(value: Any, role: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("provider_output_invalid")
    output = value.get("output")
    if not isinstance(output, dict):
        raise ValueError("provider_output_invalid")
    if role == "root_reconciler":
        if not isinstance(output.get("action"), dict):
            raise ValueError("provider_output_action_invalid")
        for field in ("rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "human_action_resolutions"):
            if field not in output:
                raise ValueError(f"provider_output_{field}_missing")
        return output
    if not isinstance(output.get("kind"), str):
        raise ValueError("provider_output_kind_invalid")
    return output


def _required_text(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"{key}_invalid")
    return result


def _root_target_digest(request: dict[str, Any]) -> str:
    if request.get("kind") == "open_root_reconciler":
        bootstrap = request.get("bootstrap")
        if not isinstance(bootstrap, dict):
            raise ValueError("root_bootstrap_invalid")
        return _required_text(bootstrap, "root_digest")
    delta = request.get("delta")
    if not isinstance(delta, dict):
        raise ValueError("root_delta_invalid")
    return _required_text(delta, "target_root_digest")


def _optional_text(value: dict[str, Any], key: str) -> str | None:
    result = value.get(key)
    if result is not None and (not isinstance(result, str) or not result):
        raise ValueError(f"{key}_invalid")
    return result


def _deadline(request: dict[str, Any]) -> datetime | None:
    limits = request.get("limits")
    if not isinstance(limits, dict) or limits.get("deadline_at") is None:
        return None
    value = limits["deadline_at"]
    if not isinstance(value, str):
        raise ValueError("deadline_invalid")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
