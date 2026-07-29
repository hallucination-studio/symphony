from __future__ import annotations

import json
import select
from copy import deepcopy
from pathlib import Path
from threading import Event
from typing import Any, Iterable
from uuid import uuid4

from performer.agent_protocol.protocol import (
    ProtocolError,
    error_response,
    response,
    validate_request,
)
from performer.contracts import validate
from performer.backends.provider_backend_interface import ProviderBackendInterface
from performer.role_execution.runtime import RoleExecutionRuntime
from performer.root_reconciler.runtime import RootReconcilerRuntime
from performer.session_runtime.manager import SessionError, SessionManager

MAX_FRAME_BYTES = 16 * 1024 * 1024


class AgentProtocolHost:
    """Long-lived request/response host; all workflow authority remains outside Performer."""

    def __init__(
        self,
        backend: ProviderBackendInterface,
        *,
        workspace_root: Path | None = None,
        process_generation: str | None = None,
    ) -> None:
        sessions = SessionManager(backend, process_generation=process_generation or str(uuid4()))
        roles = RoleExecutionRuntime(sessions, workspace_root=workspace_root)
        self._sessions = sessions
        self._root = RootReconcilerRuntime(sessions, roles)
        self._roles = roles
        self._close_commands: dict[str, tuple[str, dict[str, Any]]] = {}

    def handle(self, value: Any) -> dict[str, Any]:
        request_id = (
            value.get("request_id", value.get("command_id", "unknown"))
            if isinstance(value, dict)
            else "unknown"
        )
        try:
            request = validate_request(value)
            payload = request
            kind = request.get("kind")
            if kind == "open_root_reconciler":
                opened = response(request["request_id"], "root_reconciler_opened", self._root.open(payload))
                return validate("RootReconcilerOpenedResult", opened)
            if kind == "advance_root_reconciler":
                return validate("RootReconcilerTurnResult", self._root.advance(payload))
            if kind is None and request.get("role") == "plan":
                self._ensure_stage_session(payload, "plan")
                return validate("PlanTurnResponse", self._roles.execute_plan(payload))
            if kind is None and request.get("role") == "work":
                self._ensure_stage_session(payload, "work")
                return validate("WorkTurnResponse", self._roles.execute_work(payload))
            if kind is None and request.get("role") == "verify":
                self._ensure_stage_session(payload, "verify")
                return validate("VerifyTurnResponse", self._roles.execute_verify(payload))
            if kind == "close_cycle_stage_sessions":
                return self._close_cycle(payload)
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

    def iter_lines(self, stream: Iterable[bytes], cancel_event: Event | None = None) -> Iterable[dict[str, Any]]:
        cancel_event = cancel_event or Event()
        file_number = _file_number(stream)
        if file_number is None:
            for frame in stream:
                if cancel_event.is_set():
                    return
                yield _decode_frame(self, frame)
            return
        reader = getattr(stream, "readline")
        while not cancel_event.is_set():
            try:
                readable, _, _ = select.select([file_number], [], [], 0.1)
            except InterruptedError:
                continue
            if not readable:
                continue
            frame = reader()
            if not frame:
                return
            yield _decode_frame(self, frame)

    def cancel(self) -> None:
        self._sessions.cancel_all()

    def _close_cycle(self, payload: dict[str, Any]) -> dict[str, Any]:
        command_id = _text(payload, "command_id")
        canonical_command = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        prior = self._close_commands.get(command_id)
        if prior is not None:
            if prior[0] != canonical_command:
                raise ProtocolError(
                    "command_id_reused",
                    "The close command ID was already used for a different command.",
                )
            return deepcopy(prior[1])
        root_issue_id = _text(payload, "root_issue_id")
        cycle_issue_id = _text(payload, "cycle_issue_id")
        close_result = self._sessions.close_cycle(
            root_issue_id=root_issue_id,
            cycle_issue_id=cycle_issue_id,
            expected_process_generation=_text(payload, "expected_process_generation"),
            expected_sessions=payload["expected_sessions"],
        )
        result = validate("CloseCycleStageSessionsResult", {
            "protocol_version": "1",
            "command_id": command_id,
            "root_issue_id": root_issue_id,
            "cycle_issue_id": cycle_issue_id,
            **close_result,
        })
        self._close_commands[command_id] = (canonical_command, deepcopy(result))
        return result

    def _ensure_stage_session(self, payload: dict[str, Any], role: str) -> None:
        session_id = _text(payload, "role_session_id")
        root_issue_id = _text(payload, "root_issue_id")
        cycle_issue_id = _text(payload, "cycle_issue_id")
        session_generation = _text(payload, "session_generation")
        existing = self._sessions._sessions.get(session_id)
        if existing is not None:
            if existing.session_generation != session_generation:
                raise SessionError(
                    "session_generation_mismatch",
                    "The Stage role session generation does not match.",
                )
            return
        settings = payload.get("model_settings", {})
        if not isinstance(settings, dict):
            raise ValueError("model_settings_invalid")
        self._sessions.open(
            session_id=session_id,
            session_generation=session_generation,
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


def _file_number(stream: Iterable[bytes]) -> int | None:
    try:
        value = getattr(stream, "fileno")()
    except (AttributeError, OSError, ValueError):
        return None
    return value if isinstance(value, int) else None


def _decode_frame(host: AgentProtocolHost, frame: bytes) -> dict[str, Any]:
    if len(frame) > MAX_FRAME_BYTES:
        return error_response("unknown", ProtocolError("request_limit_exceeded", "The Performer request is too large."))
    try:
        value = json.loads(frame)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error_response("unknown", ProtocolError("request_invalid", "The Performer request is not valid JSON."))
    return host.handle(value)
