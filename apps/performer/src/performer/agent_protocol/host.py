from __future__ import annotations

import json
from pathlib import Path
from threading import Event
from typing import Any, Iterable

from performer.agent_protocol.protocol import (
    ProtocolError,
    error_response,
    response,
    validate_request,
)
from performer.backends.provider_backend_interface import ProviderBackendInterface
from performer.role_execution.runtime import RoleExecutionRuntime
from performer.root_reconciler.runtime import RootReconcilerRuntime
from performer.session_runtime.manager import SessionError, SessionManager

MAX_FRAME_BYTES = 16 * 1024 * 1024


class AgentProtocolHost:
    """Long-lived request/response host; all workflow authority remains outside Performer."""

    def __init__(self, backend: ProviderBackendInterface, *, workspace_root: Path | None = None) -> None:
        sessions = SessionManager(backend)
        roles = RoleExecutionRuntime(sessions, workspace_root=workspace_root)
        self._sessions = sessions
        self._root = RootReconcilerRuntime(sessions, roles)
        self._roles = roles

    def handle(self, value: Any) -> dict[str, Any]:
        request_id = value.get("request_id", "unknown") if isinstance(value, dict) else "unknown"
        try:
            request = validate_request(value)
            payload = {**request["payload"], "request_id": request["request_id"]}
            kind = request["kind"]
            if kind == "open_root_reconciler":
                return response(request["request_id"], "root_reconciler_opened", self._root.open(payload))
            if kind == "advance_root_reconciler":
                return response(request["request_id"], "root_directive", self._root.advance(payload))
            if kind == "execute_plan_turn":
                self._ensure_stage_session(payload, "plan")
                return response(request["request_id"], "stage_result", self._roles.execute_plan(payload))
            if kind == "execute_work_turn":
                self._ensure_stage_session(payload, "work")
                return response(request["request_id"], "stage_result", self._roles.execute_work(payload))
            if kind == "execute_verify_turn":
                self._ensure_stage_session(payload, "verify")
                return response(request["request_id"], "stage_result", self._roles.execute_verify(payload))
            if kind == "close_cycle_stage_sessions":
                return response(request["request_id"], "cycle_stage_sessions_closed", self._close_cycle(payload))
            if kind == "close_root_reconciler":
                return response(request["request_id"], "root_reconciler_closed", self._root.close(payload))
            raise ProtocolError("request_kind_unsupported", "The Performer request kind is unsupported.")
        except ProtocolError as error:
            return error_response(str(request_id), error)
        except (SessionError, KeyError, TypeError, ValueError) as error:
            return error_response(
                str(request_id),
                ProtocolError(
                    getattr(error, "code", "performer_request_failed"),
                    getattr(error, "sanitized_reason", "The Performer could not process the request."),
                ),
            )

    def iter_lines(self, stream: Iterable[bytes]) -> Iterable[dict[str, Any]]:
        for frame in stream:
            if len(frame) > MAX_FRAME_BYTES:
                yield error_response("unknown", ProtocolError("request_limit_exceeded", "The Performer request is too large."))
                continue
            try:
                value = json.loads(frame)
            except (UnicodeDecodeError, json.JSONDecodeError):
                yield error_response("unknown", ProtocolError("request_invalid", "The Performer request is not valid JSON."))
                continue
            yield self.handle(value)

    def cancel(self) -> None:
        self._sessions.cancel_all()

    def _close_cycle(self, payload: dict[str, Any]) -> dict[str, Any]:
        root_issue_id = _text(payload, "root_issue_id")
        cycle_issue_id = _text(payload, "cycle_issue_id")
        closed = self._sessions.close_cycle(root_issue_id=root_issue_id, cycle_issue_id=cycle_issue_id)
        return {"root_issue_id": root_issue_id, "cycle_issue_id": cycle_issue_id, "closed_session_ids": closed}

    def _ensure_stage_session(self, payload: dict[str, Any], role: str) -> None:
        session_id = _text(payload, "role_session_id")
        root_issue_id = _text(payload, "root_issue_id")
        cycle_issue_id = _text(payload, "cycle_issue_id")
        if session_id in self._sessions._sessions:
            return
        settings = payload.get("model_settings", {})
        if not isinstance(settings, dict):
            raise ValueError("model_settings_invalid")
        self._sessions.open(
            session_id=session_id,
            role=role,  # type: ignore[arg-type]
            root_issue_id=root_issue_id,
            cycle_issue_id=cycle_issue_id,
            settings=settings,
        )


def _text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key}_invalid")
    return value
