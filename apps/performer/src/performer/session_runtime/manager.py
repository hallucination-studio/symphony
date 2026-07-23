from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Event, Lock
from typing import Any, Literal

from performer.backends.provider_backend_interface import (
    ProviderBackendInterface,
    ProviderSession,
)

Role = Literal["root_reconciler", "plan", "work", "verify"]
STAGE_ROLES = frozenset({"plan", "work", "verify"})


class SessionError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.sanitized_reason = reason


@dataclass(frozen=True)
class SessionRecord:
    session_id: str
    role: Role
    root_issue_id: str
    cycle_issue_id: str | None
    provider_session: ProviderSession


class SessionManager:
    """Owns live Provider continuity without creating durable workflow state."""

    def __init__(self, backend: ProviderBackendInterface) -> None:
        self._backend = backend
        self._sessions: dict[str, SessionRecord] = {}
        self._active_turns: dict[str, Event] = {}
        self._lock = Lock()

    def open(
        self,
        *,
        session_id: str,
        role: Role,
        root_issue_id: str,
        cycle_issue_id: str | None,
        settings: dict[str, Any],
    ) -> SessionRecord:
        if role == "root_reconciler" and cycle_issue_id is not None:
            raise SessionError("session_scope_invalid", "A Root Reconciler session cannot belong to a Cycle.")
        if role in STAGE_ROLES and not cycle_issue_id:
            raise SessionError("session_scope_invalid", "A Stage role session requires a Cycle.")
        with self._lock:
            if session_id in self._sessions:
                raise SessionError("session_already_open", "The Performer session is already open.")
            if any(
                record.role == role
                and record.root_issue_id == root_issue_id
                and record.cycle_issue_id == cycle_issue_id
                for record in self._sessions.values()
            ):
                raise SessionError("role_session_already_open", "The role already has an open session in this scope.")
        try:
            provider_session = self._backend.open_role_session(role, settings)
        except Exception as error:
            if isinstance(error, SessionError):
                raise
            raise SessionError("provider_session_open_failed", "The Provider session could not be opened.") from error
        record = SessionRecord(session_id, role, root_issue_id, cycle_issue_id, provider_session)
        with self._lock:
            self._sessions[session_id] = record
        return record

    def get(self, session_id: str, *, role: Role, root_issue_id: str, cycle_issue_id: str | None) -> SessionRecord:
        with self._lock:
            record = self._sessions.get(session_id)
        if record is None:
            raise SessionError("session_not_found", "The Performer session is not open.")
        if (record.role, record.root_issue_id, record.cycle_issue_id) != (role, root_issue_id, cycle_issue_id):
            raise SessionError("session_correlation_invalid", "The Performer session scope does not match.")
        return record

    def execute(
        self,
        record: SessionRecord,
        request: dict[str, Any],
        *,
        workspace_root: Path | None,
        cancel_event: Event,
    ) -> dict[str, Any]:
        with self._lock:
            if record.session_id not in self._sessions:
                raise SessionError("session_not_found", "The Performer session is not open.")
            self._active_turns[record.session_id] = cancel_event
        try:
            return self._backend.execute_role_turn(
                record.provider_session,
                request,
                workspace_root=workspace_root,
                cancel_event=cancel_event,
            )
        finally:
            with self._lock:
                self._active_turns.pop(record.session_id, None)

    def close(self, session_id: str) -> None:
        with self._lock:
            record = self._sessions.pop(session_id, None)
            cancel_event = self._active_turns.get(session_id)
        if record is None:
            return
        if cancel_event is not None:
            cancel_event.set()
            self._backend.interrupt_turn(record.provider_session)
        self._backend.close_role_session(record.provider_session)

    def close_cycle(self, *, root_issue_id: str, cycle_issue_id: str) -> list[str]:
        with self._lock:
            session_ids = [
                record.session_id
                for record in self._sessions.values()
                if record.root_issue_id == root_issue_id
                and record.cycle_issue_id == cycle_issue_id
                and record.role in STAGE_ROLES
            ]
        for session_id in session_ids:
            self.close(session_id)
        return session_ids

    def close_root(self, *, root_issue_id: str) -> list[str]:
        with self._lock:
            session_ids = [
                record.session_id
                for record in self._sessions.values()
                if record.root_issue_id == root_issue_id and record.role == "root_reconciler"
            ]
        for session_id in session_ids:
            self.close(session_id)
        return session_ids

    def cancel_all(self) -> None:
        with self._lock:
            events = list(self._active_turns.values())
        for event in events:
            event.set()
