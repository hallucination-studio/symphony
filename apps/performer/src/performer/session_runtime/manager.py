from __future__ import annotations

import hashlib
import json
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
        self.continuity: dict[str, str] | None = None


@dataclass
class SessionRecord:
    session_id: str
    role: Role
    root_issue_id: str
    cycle_issue_id: str | None
    provider_session: ProviderSession
    provider_visible_context_digest: str | None = None
    provider_visible_context_manifest: dict[tuple[str, str], dict[str, str]] | None = None


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
        try:
            base_digest, target_digest, target_manifest = _context_state(record, request)
        except SessionError as error:
            self.close(record.session_id)
            error.continuity = {"kind": "closed", "append_outcome": "session_lost"}
            raise
        with self._lock:
            if record.session_id not in self._sessions:
                raise SessionError("session_not_found", "The Performer session is not open.")
            self._active_turns[record.session_id] = cancel_event
        try:
            result = self._backend.execute_role_turn(
                record.provider_session,
                request,
                workspace_root=workspace_root,
                cancel_event=cancel_event,
            )
            record.provider_visible_context_digest = target_digest
            record.provider_visible_context_manifest = target_manifest
            return result
        except Exception as error:
            append_outcome = getattr(error, "append_outcome", "acceptance_unknown")
            if append_outcome == "not_accepted":
                continuity = {
                    "kind": "retained",
                    "append_outcome": "not_accepted",
                    "provider_visible_context_digest": base_digest,
                }
            elif append_outcome == "accepted":
                record.provider_visible_context_digest = target_digest
                record.provider_visible_context_manifest = target_manifest
                continuity = {
                    "kind": "retained",
                    "append_outcome": "accepted",
                    "provider_visible_context_digest": target_digest,
                }
            else:
                continuity = {"kind": "closed", "append_outcome": "acceptance_unknown"}
                with self._lock:
                    self._sessions.pop(record.session_id, None)
                try:
                    self._backend.close_role_session(record.provider_session)
                except Exception:
                    pass
            try:
                setattr(error, "continuity", continuity)
            except Exception:
                pass
            raise
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


def _context_state(
    record: SessionRecord,
    request: dict[str, Any],
) -> tuple[str, str, dict[tuple[str, str], dict[str, str]] | None]:
    if record.role == "root_reconciler":
        if request.get("kind") == "open_root_reconciler":
            bootstrap = request.get("bootstrap")
            if not isinstance(bootstrap, dict) or record.provider_visible_context_digest is not None:
                raise SessionError("root_initial_context_invalid", "The Root initial context is invalid.")
            target = _required_digest(bootstrap, "root_digest")
            return target, target, None
        delta = request.get("delta")
        if not isinstance(delta, dict):
            raise SessionError("root_delta_invalid", "The Root delta is invalid.")
        base = _required_digest(delta, "base_root_digest")
        target = _required_digest(delta, "target_root_digest")
    else:
        update = request.get("role_context_update")
        if not isinstance(update, dict):
            raise SessionError("stage_context_update_invalid", "The Stage context update is invalid.")
        target = _required_digest(update, "target_context_digest")
        if update.get("kind") == "initial":
            if record.provider_visible_context_digest is not None:
                raise SessionError("stage_initial_context_repeated", "A live Stage session cannot receive another initial context.")
            manifest = _stage_initial_manifest(update)
            if _stage_manifest_digest(manifest) != target:
                raise SessionError("stage_context_digest_invalid", "The Stage initial context digest is invalid.")
            return target, target, manifest
        if update.get("kind") != "delta":
            raise SessionError("stage_context_update_invalid", "The Stage context update is invalid.")
        base = _required_digest(update, "base_context_digest")
    if record.provider_visible_context_digest != base:
        raise SessionError("provider_context_discontinuous", "The Provider-visible context baseline is discontinuous.")
    if record.role == "root_reconciler":
        return base, target, None
    manifest = _stage_delta_manifest(record, update)
    if _stage_manifest_digest(manifest) != target:
        raise SessionError("stage_context_digest_invalid", "The Stage delta target digest is invalid.")
    return base, target, manifest


def _required_digest(value: dict[str, Any], key: str) -> str:
    digest = value.get(key)
    if not isinstance(digest, str) or not digest:
        raise SessionError("provider_context_digest_invalid", "The Provider-visible context digest is invalid.")
    return digest


def _required_text(value: dict[str, Any], key: str) -> str:
    text = value.get(key)
    if not isinstance(text, str) or not text:
        raise SessionError("stage_context_source_invalid", "The Stage context source identity is invalid.")
    return text


def _stage_initial_manifest(update: dict[str, Any]) -> dict[tuple[str, str], dict[str, str]]:
    sources = update.get("sources")
    if not isinstance(sources, list):
        raise SessionError("stage_context_sources_invalid", "The Stage initial context sources are invalid.")
    identities = [_stage_identity(source) for source in sources]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise SessionError("stage_context_sources_invalid", "The Stage initial context sources are not canonical.")
    manifest: dict[tuple[str, str], dict[str, str]] = {}
    for source, identity in zip(sources, identities, strict=True):
        if not isinstance(source, dict) or source.get("kind") != "current_value":
            raise SessionError("stage_context_sources_invalid", "The Stage initial context source operation is invalid.")
        _validate_stage_value(source)
        manifest[identity] = _stage_manifest_entry(source)
    return manifest


def _stage_delta_manifest(
    record: SessionRecord,
    update: dict[str, Any],
) -> dict[tuple[str, str], dict[str, str]]:
    if record.provider_visible_context_manifest is None:
        raise SessionError("stage_context_manifest_missing", "The Stage context manifest is unavailable.")
    changes = update.get("changes")
    if not isinstance(changes, list):
        raise SessionError("stage_context_changes_invalid", "The Stage context changes are invalid.")
    identities = [_stage_identity(change) for change in changes]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise SessionError("stage_context_changes_invalid", "The Stage context changes are not canonical.")
    manifest = {identity: dict(entry) for identity, entry in record.provider_visible_context_manifest.items()}
    for change, identity in zip(changes, identities, strict=True):
        if not isinstance(change, dict):
            raise SessionError("stage_context_changes_invalid", "The Stage context change is invalid.")
        current = manifest.get(identity)
        operation = change.get("kind")
        if operation == "current_value":
            if current is not None:
                raise SessionError("stage_context_precondition_invalid", "The Stage current-value precondition failed.")
            _validate_stage_value(change)
            manifest[identity] = _stage_manifest_entry(change)
        elif operation == "replacement":
            if current is None or change.get("replaces_source_version_or_digest") != current["source_version_or_digest"]:
                raise SessionError("stage_context_precondition_invalid", "The Stage replacement precondition failed.")
            _validate_stage_value(change)
            manifest[identity] = _stage_manifest_entry(change)
        elif operation == "tombstone":
            if current is None or change.get("removes_source_version_or_digest") != current["source_version_or_digest"]:
                raise SessionError("stage_context_precondition_invalid", "The Stage tombstone precondition failed.")
            manifest.pop(identity)
        else:
            raise SessionError("stage_context_changes_invalid", "The Stage context operation is invalid.")
    return manifest


def _stage_identity(value: Any) -> tuple[str, str]:
    if not isinstance(value, dict):
        raise SessionError("stage_context_source_invalid", "The Stage context source is invalid.")
    return (_required_text(value, "source_kind"), _required_text(value, "source_id"))


def _stage_manifest_entry(value: dict[str, Any]) -> dict[str, str]:
    return {
        "source_kind": _required_text(value, "source_kind"),
        "source_id": _required_text(value, "source_id"),
        "source_version_or_digest": _required_text(value, "source_version_or_digest"),
        "actor_kind": _required_text(value, "actor_kind"),
    }


def _validate_stage_value(source: dict[str, Any]) -> None:
    value = source.get("value")
    if not isinstance(value, dict):
        raise SessionError("stage_context_value_invalid", "The Stage context value is invalid.")
    allowed = {
        "linear_issue": {"root_contract", "cycle", "issue"},
        "linear_comment": {"comment"},
        "linear_relation": {"relation"},
        "git": {"git"},
        "repository_instruction": {"repository_instruction"},
    }
    if value.get("kind") not in allowed.get(source.get("source_kind"), set()):
        raise SessionError("stage_context_value_invalid", "The Stage context value does not match its source kind.")


def _stage_manifest_digest(manifest: dict[tuple[str, str], dict[str, str]]) -> str:
    fragments = [
        [entry["source_kind"], entry["source_id"], entry["source_version_or_digest"], entry["actor_kind"]]
        for _, entry in sorted(manifest.items())
    ]
    encoded = json.dumps(fragments, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
