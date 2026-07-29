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
    ProviderTurnAcceptanceUnknown,
    ProviderTurnAcceptedInvalid,
    ProviderTurnAcceptedValid,
    ProviderTurnCanceled,
    ProviderTurnNotAccepted,
    ProviderTurnSessionLost,
)

Role = Literal["root_reconciler", "plan", "work", "verify"]
StageRole = Literal["plan", "work", "verify"]
SessionLifecycleState = Literal["open", "executing", "closing", "closed"]
STAGE_ROLE_ORDER: tuple[StageRole, ...] = ("plan", "work", "verify")
STAGE_ROLES = frozenset(STAGE_ROLE_ORDER)


class SessionError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.sanitized_reason = reason
        self.continuity: dict[str, str] | None = None


class SessionTurnFailure(SessionError):
    def __init__(
        self,
        code: str,
        reason: str,
        *,
        retryable: bool,
        failure_category: Literal["schema_invalid", "transport_failed", "canceled", "timed_out"],
        continuity: dict[str, str],
        provider_usage: dict[str, Any] | None = None,
        provider_was_accepted: bool = False,
    ) -> None:
        super().__init__(code, reason)
        self.retryable = retryable
        self.failure_category = failure_category
        self.continuity = continuity
        self.provider_usage = provider_usage
        self.provider_was_accepted = provider_was_accepted


@dataclass
class SessionRecord:
    session_id: str
    session_generation: str
    role: Role
    root_issue_id: str
    cycle_issue_id: str | None
    provider_session: ProviderSession
    provider_visible_context_digest: str | None = None
    provider_visible_context_manifest: dict[tuple[str, str], dict[str, str]] | None = None
    lifecycle_state: SessionLifecycleState = "open"


class SessionManager:
    """Owns live Provider continuity without creating durable workflow state."""

    def __init__(self, backend: ProviderBackendInterface, *, process_generation: str) -> None:
        self._backend = backend
        self.process_generation = process_generation
        self._sessions: dict[str, SessionRecord] = {}
        self._active_turns: dict[str, Event] = {}
        self._closed_stage_sessions: set[tuple[str, str, StageRole, str, str]] = set()
        self._frozen_cycles: set[tuple[str, str]] = set()
        self._lock = Lock()

    def open(
        self,
        *,
        session_id: str,
        session_generation: str,
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
            if role in STAGE_ROLES and (root_issue_id, cycle_issue_id) in self._frozen_cycles:
                raise SessionError("cycle_stage_admission_frozen", "The Cycle no longer accepts Stage sessions.")
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
        record = SessionRecord(session_id, session_generation, role, root_issue_id, cycle_issue_id, provider_session)
        admission_error: SessionError | None = None
        with self._lock:
            if role in STAGE_ROLES and (root_issue_id, cycle_issue_id) in self._frozen_cycles:
                admission_error = SessionError(
                    "cycle_stage_admission_frozen",
                    "The Cycle no longer accepts Stage sessions.",
                )
            elif session_id in self._sessions:
                admission_error = SessionError("session_already_open", "The Performer session is already open.")
            elif any(
                existing.role == role
                and existing.root_issue_id == root_issue_id
                and existing.cycle_issue_id == cycle_issue_id
                for existing in self._sessions.values()
            ):
                admission_error = SessionError(
                    "role_session_already_open",
                    "The role already has an open session in this scope.",
                )
            else:
                self._sessions[session_id] = record
        if admission_error is not None:
            try:
                self._backend.close_role_session(provider_session)
            except Exception as error:
                raise SessionError(
                    "provider_session_open_rollback_failed",
                    "The rejected Provider session could not be closed.",
                ) from error
            record.lifecycle_state = "closed"
            raise admission_error
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
            registered = self._sessions.get(record.session_id)
            if registered is not record or record.lifecycle_state in {"closing", "closed"}:
                raise SessionError("session_not_found", "The Performer session is not open.")
            if record.lifecycle_state == "executing" or record.session_id in self._active_turns:
                raise SessionError(
                    "session_turn_already_active",
                    "The Performer session already has an active turn.",
                )
            record.lifecycle_state = "executing"
            self._active_turns[record.session_id] = cancel_event
        try:
            try:
                base_digest, target_digest, target_manifest = _context_state(record, request)
            except SessionError as error:
                self.close(record.session_id)
                error.continuity = {"kind": "closed", "append_outcome": "session_lost"}
                raise
            outcome = self._backend.execute_role_turn(
                record.provider_session,
                request,
                workspace_root=workspace_root,
                cancel_event=cancel_event,
            )
            with self._lock:
                if self._sessions.get(record.session_id) is not record or record.lifecycle_state != "executing":
                    error = SessionError(
                        "session_generation_closed",
                        "The Performer session generation closed before the turn completed.",
                    )
                    error.continuity = {"kind": "closed", "append_outcome": "session_lost"}
                    raise error
                if isinstance(outcome, (ProviderTurnAcceptedValid, ProviderTurnAcceptedInvalid)) or (
                    isinstance(outcome, ProviderTurnCanceled) and outcome.append_outcome == "accepted"
                ):
                    record.provider_visible_context_digest = target_digest
                    record.provider_visible_context_manifest = target_manifest
            if isinstance(outcome, ProviderTurnAcceptedValid):
                return {"output": outcome.output, "usage": outcome.usage}
            if isinstance(outcome, ProviderTurnNotAccepted):
                raise SessionTurnFailure(
                    outcome.failure.code if outcome.failure.code == "provider_schema_unsupported" else "provider_append_not_accepted",
                    outcome.failure.sanitized_reason,
                    retryable=outcome.failure.retryable,
                    failure_category=_provider_failure_category(outcome.failure.code),
                    continuity={
                        "kind": "retained",
                        "append_outcome": "not_accepted",
                        "provider_visible_context_digest": base_digest,
                    },
                )
            if isinstance(outcome, ProviderTurnAcceptedInvalid):
                raise SessionTurnFailure(
                    "provider_output_schema_invalid",
                    outcome.failure.sanitized_reason,
                    retryable=outcome.failure.retryable,
                    failure_category="schema_invalid",
                    continuity={
                        "kind": "retained",
                        "append_outcome": "accepted",
                        "provider_visible_context_digest": target_digest,
                    },
                    provider_usage=outcome.usage,
                    provider_was_accepted=True,
                )
            if isinstance(outcome, ProviderTurnCanceled):
                if outcome.append_outcome == "accepted":
                    continuity = {
                        "kind": "retained",
                        "append_outcome": "accepted",
                        "provider_visible_context_digest": target_digest,
                    }
                else:
                    continuity = {"kind": "closed", "append_outcome": "acceptance_unknown"}
                    self.close(record.session_id)
                raise SessionTurnFailure(
                    "provider_turn_deadline_expired" if outcome.deadline_expired else "provider_turn_canceled",
                    outcome.sanitized_reason,
                    retryable=not outcome.deadline_expired,
                    failure_category="timed_out" if outcome.deadline_expired else "canceled",
                    continuity=continuity,
                    provider_usage=outcome.usage,
                    provider_was_accepted=outcome.append_outcome == "accepted",
                )
            if isinstance(outcome, ProviderTurnSessionLost):
                self.close(record.session_id)
                raise SessionTurnFailure(
                    "provider_session_lost",
                    outcome.failure.sanitized_reason,
                    retryable=outcome.failure.retryable,
                    failure_category="transport_failed",
                    continuity={"kind": "closed", "append_outcome": "session_lost"},
                )
            if isinstance(outcome, ProviderTurnAcceptanceUnknown):
                self.close(record.session_id)
                raise SessionTurnFailure(
                    "provider_append_acceptance_unknown",
                    outcome.failure.sanitized_reason,
                    retryable=outcome.failure.retryable,
                    failure_category="transport_failed",
                    continuity={"kind": "closed", "append_outcome": "acceptance_unknown"},
                )
            self.close(record.session_id)
            raise SessionTurnFailure(
                "provider_turn_outcome_invalid",
                "The Provider backend returned an invalid turn outcome.",
                retryable=False,
                failure_category="transport_failed",
                continuity={"kind": "closed", "append_outcome": "acceptance_unknown"},
            )
        except Exception as error:
            if isinstance(error, SessionError) and error.continuity is not None:
                raise
            with self._lock:
                if self._sessions.get(record.session_id) is record:
                    self._sessions.pop(record.session_id)
                record.lifecycle_state = "closing"
            try:
                self._backend.close_role_session(record.provider_session)
            except Exception:
                pass
            finally:
                with self._lock:
                    record.lifecycle_state = "closed"
            failure = SessionTurnFailure(
                "provider_append_acceptance_unknown",
                "The Provider backend failed without a closed turn outcome.",
                retryable=False,
                failure_category="transport_failed",
                continuity={"kind": "closed", "append_outcome": "acceptance_unknown"},
            )
            raise failure from error
        finally:
            with self._lock:
                if self._active_turns.get(record.session_id) is cancel_event:
                    self._active_turns.pop(record.session_id)
                if self._sessions.get(record.session_id) is record and record.lifecycle_state == "executing":
                    record.lifecycle_state = "open"

    def close(self, session_id: str) -> None:
        with self._lock:
            record = self._sessions.get(session_id)
            if record is not None:
                record.lifecycle_state = "closing"
                self._sessions.pop(session_id)
            cancel_event = self._active_turns.pop(session_id, None)
        if record is None:
            return
        try:
            if cancel_event is not None:
                cancel_event.set()
                try:
                    self._backend.interrupt_turn(record.provider_session)
                finally:
                    self._backend.close_role_session(record.provider_session)
            else:
                self._backend.close_role_session(record.provider_session)
        finally:
            with self._lock:
                record.lifecycle_state = "closed"

    def close_cycle(
        self,
        *,
        root_issue_id: str,
        cycle_issue_id: str,
        expected_process_generation: str,
        expected_sessions: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        if expected_process_generation != self.process_generation:
            role_results = {
                role: _close_rejected(
                    role,
                    _expected_session_id(expected_sessions.get(role)),
                    "process_generation_mismatch",
                    "The Performer process generation does not match the close command.",
                )
                for role in STAGE_ROLE_ORDER
            }
            return _close_cycle_result(self.process_generation, role_results)
        with self._lock:
            self._frozen_cycles.add((root_issue_id, cycle_issue_id))
        role_results = {
            role: self._close_stage_role(
                root_issue_id=root_issue_id,
                cycle_issue_id=cycle_issue_id,
                role=role,
                expected=expected_sessions.get(role),
            )
            for role in STAGE_ROLE_ORDER
        }
        return _close_cycle_result(self.process_generation, role_results)

    def _close_stage_role(
        self,
        *,
        root_issue_id: str,
        cycle_issue_id: str,
        role: StageRole,
        expected: dict[str, str] | None,
    ) -> dict[str, Any]:
        if expected is None or expected.get("kind") not in {"expected", "absent"}:
            return _close_rejected(role, None, "session_generation_mismatch", "The expected role session is invalid.")
        with self._lock:
            current = next((
                record for record in self._sessions.values()
                if record.root_issue_id == root_issue_id
                and record.cycle_issue_id == cycle_issue_id
                and record.role == role
            ), None)
            if expected["kind"] == "absent":
                if current is None:
                    return _closed_role(role, None, "already_absent")
                return _close_rejected(
                    role, current.session_id, "concurrent_newer_session",
                    "A Stage role session exists where the close command expected none.",
                )
            expected_session_id = expected.get("role_session_id")
            expected_generation = expected.get("session_generation")
            if not expected_session_id or not expected_generation:
                return _close_rejected(role, expected_session_id, "session_generation_mismatch", "The expected session generation is invalid.")
            closed_key = (root_issue_id, cycle_issue_id, role, expected_session_id, expected_generation)
            if current is None:
                if closed_key in self._closed_stage_sessions:
                    return _closed_role(role, expected_session_id, "already_closed")
                return _close_rejected(
                    role, expected_session_id, "session_generation_mismatch",
                    "The expected Stage role session generation is not present.",
                )
            if current.session_id != expected_session_id:
                return _close_rejected(
                    role, current.session_id, "concurrent_newer_session",
                    "A different Stage role session is currently open.",
                )
            if current.session_generation != expected_generation:
                return _close_rejected(
                    role, current.session_id, "session_generation_mismatch",
                    "The Stage role session generation does not match.",
                )
            current.lifecycle_state = "closing"
            cancel_event = self._active_turns.pop(current.session_id, None)
        try:
            if cancel_event is not None:
                cancel_event.set()
                self._backend.interrupt_turn(current.provider_session)
            self._backend.close_role_session(current.provider_session)
        except Exception:
            return {
                "kind": "close_pending",
                "role": role,
                "role_session_id": current.session_id,
                "close_reason": "provider_shutdown_pending",
                "sanitized_reason": "The Provider role session close is not yet confirmed.",
                "retryable": True,
                "action_required": "retry_close_only",
            }
        with self._lock:
            if self._sessions.get(current.session_id) is current:
                self._sessions.pop(current.session_id)
            current.lifecycle_state = "closed"
            self._closed_stage_sessions.add(closed_key)
        return _closed_role(role, current.session_id, "closed_now")

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


def _provider_failure_category(code: str) -> Literal["schema_invalid", "transport_failed"]:
    return "schema_invalid" if code == "provider_schema_unsupported" else "transport_failed"


def _expected_session_id(expected: dict[str, str] | None) -> str | None:
    if expected is None or expected.get("kind") != "expected":
        return None
    session_id = expected.get("role_session_id")
    return session_id if session_id else None


def _closed_role(
    role: StageRole,
    session_id: str | None,
    outcome: Literal["closed_now", "already_closed", "already_absent"],
) -> dict[str, Any]:
    return {
        "kind": "closed",
        "role": role,
        "role_session_id": session_id,
        "close_outcome": outcome,
    }


def _close_rejected(
    role: StageRole,
    session_id: str | None,
    reason: Literal[
        "process_generation_mismatch",
        "session_generation_mismatch",
        "concurrent_newer_session",
    ],
    sanitized_reason: str,
) -> dict[str, Any]:
    return {
        "kind": "close_rejected",
        "role": role,
        "role_session_id": session_id,
        "close_reason": reason,
        "sanitized_reason": sanitized_reason,
        "retryable": False,
        "action_required": "refresh_runtime_state",
    }


def _close_cycle_result(
    process_generation: str,
    role_results: dict[StageRole, dict[str, Any]],
) -> dict[str, Any]:
    return {
        "process_generation": process_generation,
        "kind": "all_closed"
        if all(result.get("kind") == "closed" for result in role_results.values())
        else "close_incomplete",
        "role_results": role_results,
    }


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
