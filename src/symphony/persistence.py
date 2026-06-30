from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import RetryEntry, RunningEntry, RuntimeTokens, monotonic_ms


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
    status_label: str = "symphony:running"
    workspace_path: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)
    turn_count: int = 0
    tokens: RuntimeTokens = field(default_factory=RuntimeTokens)


@dataclass(frozen=True)
class PersistedState:
    retry_attempts: list[RetryEntry] = field(default_factory=list)
    sessions: list[PersistedSession] = field(default_factory=list)

    @classmethod
    def from_runtime(
        cls, *, retry_attempts: list[RetryEntry], running: list[RunningEntry]
    ) -> PersistedState:
        return cls(
            retry_attempts=list(retry_attempts),
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
                    workspace_path=entry.workspace_path,
                    recent_events=list(entry.recent_events),
                    turn_count=entry.turn_count,
                    tokens=entry.tokens,
                )
                for entry in running
            ],
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
        "sessions": [_session_to_json(session) for session in state.sessions],
    }


def _state_from_json(payload: dict[str, Any]) -> PersistedState:
    retry_attempts = [
        entry
        for item in payload.get("retry_attempts", [])
        if isinstance(item, dict)
        for entry in [_retry_from_json(item)]
        if entry is not None
    ]
    sessions = [
        session
        for item in payload.get("sessions", [])
        if isinstance(item, dict)
        for session in [_session_from_json(item)]
        if session is not None
    ]
    return PersistedState(retry_attempts=retry_attempts, sessions=sessions)


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
        else "symphony:retrying",
        last_message=payload.get("last_message") if isinstance(payload.get("last_message"), str) else None,
        recent_events=_list_of_dicts(payload.get("recent_events")),
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
        else "symphony:running",
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
