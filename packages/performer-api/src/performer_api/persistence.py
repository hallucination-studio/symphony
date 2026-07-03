from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import (
    BlockedEntry,
    ContinuationEntry,
    HumanInterventionEntry,
    RetryEntry,
    RunningEntry,
    RuntimeTokens,
    monotonic_ms,
)


@dataclass(frozen=True)
class CodexThreadEntry:
    issue_id: str
    thread_id: str
    backend: str
    workspace_path: str
    last_turn_id: str | None = None
    status: str = "active"
    last_final_response: str | None = None
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(frozen=True)
class PersistedSession:
    issue_id: str
    issue_identifier: str
    issue_url: str | None
    session_id: str | None
    thread_id: str | None
    turn_id: str | None
    worker_host: str | None
    started_at: datetime
    last_event: str | None = None
    last_message: str | None = None
    last_raw_message: str | None = None
    phase: str = "running"
    status_label: str = "performer:running"
    runtime_phase: str = "implementation_running"
    workspace_path: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)
    turn_count: int = 0
    tokens: RuntimeTokens = field(default_factory=RuntimeTokens)


@dataclass(frozen=True)
class PersistedState:
    retry_attempts: list[RetryEntry] = field(default_factory=list)
    continuations: list[ContinuationEntry] = field(default_factory=list)
    blocked: list[BlockedEntry] = field(default_factory=list)
    human_interventions: list[HumanInterventionEntry] = field(default_factory=list)
    sessions: list[PersistedSession] = field(default_factory=list)
    codex_threads: list[CodexThreadEntry] = field(default_factory=list)

    @classmethod
    def from_runtime(
        cls,
        *,
        retry_attempts: list[RetryEntry],
        continuations: list[ContinuationEntry] | None = None,
        blocked: list[BlockedEntry] | None = None,
        human_interventions: list[HumanInterventionEntry] | None = None,
        running: list[RunningEntry],
        codex_threads: list[CodexThreadEntry] | None = None,
    ) -> PersistedState:
        return cls(
            retry_attempts=list(retry_attempts),
            continuations=list(continuations or []),
            blocked=list(blocked or []),
            human_interventions=list(human_interventions or []),
            sessions=[
                PersistedSession(
                    issue_id=entry.issue.id,
                    issue_identifier=entry.issue.identifier,
                    issue_url=entry.issue.url,
                    session_id=entry.session_id,
                    thread_id=entry.thread_id,
                    turn_id=entry.turn_id,
                    worker_host=getattr(entry, "worker_host", None),
                    started_at=entry.started_at,
                    last_event=entry.last_codex_event,
                    last_message=entry.last_codex_message,
                    last_raw_message=entry.last_raw_codex_message,
                    phase=entry.phase,
                    status_label=entry.status_label,
                    runtime_phase=entry.runtime_phase,
                    workspace_path=entry.workspace_path,
                    recent_events=list(entry.recent_events),
                    turn_count=entry.turn_count,
                    tokens=entry.tokens,
                )
                for entry in running
            ],
            codex_threads=list(codex_threads or []),
        )


class PersistenceStore:
    def __init__(self, path: Path):
        self.path = path

    def save(self, state: PersistedState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(_state_to_json(state), sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)

    def load(self) -> PersistedState:
        if not self.path.exists():
            return PersistedState()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return PersistedState()
        if not isinstance(payload, dict):
            return PersistedState()
        return _state_from_json(payload)


def ops_snapshot_path_from_persistence_path(path: Path | None) -> Path:
    if path is None:
        return Path("ops.json")
    return path.parent / "ops.json"


def _state_to_json(state: PersistedState) -> dict[str, Any]:
    return {
        "retry_attempts": [_retry_to_json(entry) for entry in state.retry_attempts],
        "continuations": [_continuation_to_json(entry) for entry in state.continuations],
        "blocked": [_blocked_to_json(entry) for entry in state.blocked],
        "human_interventions": [_human_intervention_to_json(entry) for entry in state.human_interventions],
        "sessions": [_session_to_json(session) for session in state.sessions],
        "codex_threads": [_codex_thread_to_json(entry) for entry in state.codex_threads],
    }


def _state_from_json(payload: dict[str, Any]) -> PersistedState:
    parsed_retry_entries = [
        entry
        for item in payload.get("retry_attempts", [])
        if isinstance(item, dict)
        for entry in [_retry_from_json(item)]
        if entry is not None
    ]
    retry_attempts = [
        entry
        for entry in parsed_retry_entries
        if not _is_legacy_continuation_retry(entry)
    ]
    continuations = [
        _continuation_from_retry(entry)
        for entry in parsed_retry_entries
        if _is_legacy_continuation_retry(entry)
    ] + [
        entry
        for item in payload.get("continuations", [])
        if isinstance(item, dict)
        for entry in [_continuation_from_json(item)]
        if entry is not None
    ]
    sessions = [
        session
        for item in payload.get("sessions", [])
        if isinstance(item, dict)
        for session in [_session_from_json(item)]
        if session is not None
    ]
    blocked = [
        entry
        for item in payload.get("blocked", [])
        if isinstance(item, dict)
        for entry in [_blocked_from_json(item)]
        if entry is not None
    ]
    human_interventions = [
        entry
        for item in payload.get("human_interventions", [])
        if isinstance(item, dict)
        for entry in [_human_intervention_from_json(item)]
        if entry is not None
    ]
    codex_threads = [
        entry
        for item in payload.get("codex_threads", [])
        if isinstance(item, dict)
        for entry in [_codex_thread_from_json(item)]
        if entry is not None
    ]
    return PersistedState(
        retry_attempts=retry_attempts,
        continuations=continuations,
        blocked=blocked,
        human_interventions=human_interventions,
        sessions=sessions,
        codex_threads=codex_threads,
    )


def _retry_to_json(entry: RetryEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "identifier": entry.identifier,
        "attempt": entry.attempt,
        "due_at": _iso(entry.due_at),
        "error": entry.error,
        "issue_url": entry.issue_url,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "runtime_phase": entry.runtime_phase,
        "last_message": entry.last_message,
        "recent_events": entry.recent_events,
    }


def _retry_from_json(payload: dict[str, Any]) -> RetryEntry | None:
    due_at = _parse_datetime(payload.get("due_at"))
    if due_at is None:
        return None
    issue_id = payload.get("issue_id")
    identifier = payload.get("identifier")
    attempt = payload.get("attempt")
    if not isinstance(issue_id, str) or not isinstance(identifier, str) or not isinstance(attempt, int):
        return None
    delay_ms = max(int((due_at - _utc_now()).total_seconds() * 1000), 0)
    return RetryEntry(
        issue_id=issue_id,
        identifier=identifier,
        attempt=attempt,
        due_at=due_at,
        due_at_ms=monotonic_ms() + delay_ms,
        error=payload.get("error") if isinstance(payload.get("error"), str) else None,
        issue_url=payload.get("issue_url") if isinstance(payload.get("issue_url"), str) else None,
        phase=payload.get("phase") if isinstance(payload.get("phase"), str) else "retrying",
        status_label=payload.get("status_label")
        if isinstance(payload.get("status_label"), str)
        else "performer:retrying",
        runtime_phase=payload.get("runtime_phase") if isinstance(payload.get("runtime_phase"), str) else "failed",
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
    )


def _continuation_to_json(entry: ContinuationEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "identifier": entry.identifier,
        "attempt": entry.attempt,
        "due_at": _iso(entry.due_at),
        "issue_url": entry.issue_url,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "runtime_phase": entry.runtime_phase,
        "last_message": entry.last_message,
        "recent_events": entry.recent_events,
    }


def _continuation_from_json(payload: dict[str, Any]) -> ContinuationEntry | None:
    due_at = _parse_datetime(payload.get("due_at"))
    if due_at is None:
        return None
    issue_id = payload.get("issue_id")
    identifier = payload.get("identifier")
    attempt = payload.get("attempt")
    if not isinstance(issue_id, str) or not isinstance(identifier, str) or not isinstance(attempt, int):
        return None
    delay_ms = max(int((due_at - _utc_now()).total_seconds() * 1000), 0)
    return ContinuationEntry(
        issue_id=issue_id,
        identifier=identifier,
        attempt=attempt,
        due_at=due_at,
        due_at_ms=monotonic_ms() + delay_ms,
        issue_url=payload.get("issue_url") if isinstance(payload.get("issue_url"), str) else None,
        phase="continuing",
        status_label="performer:continuing",
        runtime_phase=payload.get("runtime_phase")
        if isinstance(payload.get("runtime_phase"), str)
        else "implementation_done",
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
    )


def _blocked_to_json(entry: BlockedEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "identifier": entry.identifier,
        "attempt": entry.attempt,
        "blocked_at": _iso(entry.blocked_at),
        "error": entry.error,
        "issue_url": entry.issue_url,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "runtime_phase": entry.runtime_phase,
        "last_message": entry.last_message,
        "recent_events": entry.recent_events,
    }


def _blocked_from_json(payload: dict[str, Any]) -> BlockedEntry | None:
    blocked_at = _parse_datetime(payload.get("blocked_at"))
    if blocked_at is None:
        return None
    issue_id = payload.get("issue_id")
    identifier = payload.get("identifier")
    attempt = payload.get("attempt")
    error = payload.get("error")
    if (
        not isinstance(issue_id, str)
        or not isinstance(identifier, str)
        or not isinstance(attempt, int)
        or not isinstance(error, str)
    ):
        return None
    return BlockedEntry(
        issue_id=issue_id,
        identifier=identifier,
        attempt=attempt,
        blocked_at=blocked_at,
        error=error,
        issue_url=payload.get("issue_url") if isinstance(payload.get("issue_url"), str) else None,
        phase=payload.get("phase") if isinstance(payload.get("phase"), str) else "error",
        status_label=payload.get("status_label") if isinstance(payload.get("status_label"), str) else "performer:error",
        runtime_phase=payload.get("runtime_phase") if isinstance(payload.get("runtime_phase"), str) else "failed",
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
    )


def _human_intervention_to_json(entry: HumanInterventionEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "identifier": entry.identifier,
        "child_issue_id": entry.child_issue_id,
        "child_identifier": entry.child_identifier,
        "child_url": entry.child_url,
        "kind": entry.kind,
        "attempt": entry.attempt,
        "created_at": _iso(entry.created_at),
        "error": entry.error,
        "questions": entry.questions,
        "resume_strategy": entry.resume_strategy,
        "issue_url": entry.issue_url,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "runtime_phase": entry.runtime_phase,
        "last_message": entry.last_message,
        "recent_events": entry.recent_events,
    }


def _human_intervention_from_json(payload: dict[str, Any]) -> HumanInterventionEntry | None:
    created_at = _parse_datetime(payload.get("created_at"))
    issue_id = payload.get("issue_id")
    identifier = payload.get("identifier")
    child_issue_id = payload.get("child_issue_id")
    kind = payload.get("kind")
    attempt = payload.get("attempt")
    if (
        created_at is None
        or not isinstance(issue_id, str)
        or not isinstance(identifier, str)
        or not isinstance(child_issue_id, str)
        or not isinstance(kind, str)
        or not isinstance(attempt, int)
    ):
        return None
    questions = payload.get("questions")
    return HumanInterventionEntry(
        issue_id=issue_id,
        identifier=identifier,
        child_issue_id=child_issue_id,
        child_identifier=payload.get("child_identifier") if isinstance(payload.get("child_identifier"), str) else None,
        child_url=payload.get("child_url") if isinstance(payload.get("child_url"), str) else None,
        kind=kind,
        attempt=attempt,
        created_at=created_at,
        error=payload.get("error") if isinstance(payload.get("error"), str) else None,
        questions=[item for item in questions if isinstance(item, str)] if isinstance(questions, list) else [],
        resume_strategy=payload.get("resume_strategy") if isinstance(payload.get("resume_strategy"), str) else "retry",
        issue_url=payload.get("issue_url") if isinstance(payload.get("issue_url"), str) else None,
        phase=payload.get("phase") if isinstance(payload.get("phase"), str) else "human_pending",
        status_label=payload.get("status_label")
        if isinstance(payload.get("status_label"), str)
        else "performer:human/pending",
        runtime_phase=payload.get("runtime_phase") if isinstance(payload.get("runtime_phase"), str) else "human_pending",
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
    )


def _is_legacy_continuation_retry(entry: RetryEntry) -> bool:
    return entry.error is None or entry.phase in {"done", "continuing"}


def _continuation_from_retry(entry: RetryEntry) -> ContinuationEntry:
    return ContinuationEntry(
        issue_id=entry.issue_id,
        identifier=entry.identifier,
        attempt=entry.attempt,
        due_at=entry.due_at,
        due_at_ms=entry.due_at_ms,
        issue_url=entry.issue_url,
        last_message=entry.last_message,
        recent_events=list(entry.recent_events),
    )


def _session_to_json(session: PersistedSession) -> dict[str, Any]:
    return {
        "issue_id": session.issue_id,
        "issue_identifier": session.issue_identifier,
        "issue_url": session.issue_url,
        "session_id": session.session_id,
        "thread_id": session.thread_id,
        "turn_id": session.turn_id,
        "worker_host": session.worker_host,
        "started_at": _iso(session.started_at),
        "last_event": session.last_event,
        "last_message": session.last_message,
        "last_raw_message": session.last_raw_message,
        "phase": session.phase,
        "status_label": session.status_label,
        "runtime_phase": session.runtime_phase,
        "workspace_path": session.workspace_path,
        "recent_events": session.recent_events,
        "turn_count": session.turn_count,
        "tokens": {
            "input_tokens": session.tokens.input_tokens,
            "output_tokens": session.tokens.output_tokens,
            "cached_tokens": session.tokens.cached_tokens,
            "total_tokens": session.tokens.total_tokens,
        },
    }


def _session_from_json(payload: dict[str, Any]) -> PersistedSession | None:
    started_at = _parse_datetime(payload.get("started_at"))
    issue_id = payload.get("issue_id")
    identifier = payload.get("issue_identifier")
    if started_at is None or not isinstance(issue_id, str) or not isinstance(identifier, str):
        return None
    tokens = payload.get("tokens") if isinstance(payload.get("tokens"), dict) else {}
    return PersistedSession(
        issue_id=issue_id,
        issue_identifier=identifier,
        issue_url=payload.get("issue_url") if isinstance(payload.get("issue_url"), str) else None,
        session_id=payload.get("session_id") if isinstance(payload.get("session_id"), str) else None,
        thread_id=payload.get("thread_id") if isinstance(payload.get("thread_id"), str) else None,
        turn_id=payload.get("turn_id") if isinstance(payload.get("turn_id"), str) else None,
        worker_host=payload.get("worker_host") if isinstance(payload.get("worker_host"), str) else None,
        started_at=started_at,
        last_event=payload.get("last_event") if isinstance(payload.get("last_event"), str) else None,
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        last_raw_message=payload.get("last_raw_message") if isinstance(payload.get("last_raw_message"), str) else None,
        phase=payload.get("phase") if isinstance(payload.get("phase"), str) else "running",
        status_label=payload.get("status_label")
        if isinstance(payload.get("status_label"), str)
        else "performer:running",
        runtime_phase=payload.get("runtime_phase")
        if isinstance(payload.get("runtime_phase"), str)
        else _runtime_phase_from_legacy_session_phase(payload.get("phase")),
        workspace_path=payload.get("workspace_path") if isinstance(payload.get("workspace_path"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
        turn_count=payload.get("turn_count") if isinstance(payload.get("turn_count"), int) else 0,
        tokens=RuntimeTokens(
            input_tokens=_int(tokens.get("input_tokens")),
            output_tokens=_int(tokens.get("output_tokens")),
            cached_tokens=_int(tokens.get("cached_tokens")),
            total_tokens=_int(tokens.get("total_tokens")),
        ),
    )


def _codex_thread_to_json(entry: CodexThreadEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "thread_id": entry.thread_id,
        "backend": entry.backend,
        "workspace_path": entry.workspace_path,
        "last_turn_id": entry.last_turn_id,
        "status": entry.status,
        "last_final_response": entry.last_final_response,
        "updated_at": _iso(entry.updated_at),
    }


def _codex_thread_from_json(payload: dict[str, Any]) -> CodexThreadEntry | None:
    issue_id = payload.get("issue_id")
    thread_id = payload.get("thread_id")
    backend = payload.get("backend")
    workspace_path = payload.get("workspace_path")
    updated_at = _parse_datetime(payload.get("updated_at")) or _utc_now()
    if (
        not isinstance(issue_id, str)
        or not issue_id
        or not isinstance(thread_id, str)
        or not thread_id
        or not isinstance(backend, str)
        or not backend
        or not isinstance(workspace_path, str)
        or not workspace_path
    ):
        return None
    return CodexThreadEntry(
        issue_id=issue_id,
        thread_id=thread_id,
        backend=backend,
        workspace_path=workspace_path,
        last_turn_id=payload.get("last_turn_id") if isinstance(payload.get("last_turn_id"), str) else None,
        status=payload.get("status") if isinstance(payload.get("status"), str) else "active",
        last_final_response=payload.get("last_final_response")
        if isinstance(payload.get("last_final_response"), str)
        else None,
        updated_at=updated_at,
    )


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    return 0


def _list_of_dicts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _runtime_phase_from_legacy_session_phase(value: Any) -> str:
    if value == "done":
        return "completed"
    if value == "error":
        return "failed"
    if value == "starting":
        return "dispatch_received"
    return "implementation_running"
