from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from performer_api.config import ServiceConfig
from performer_api.models import BlockedEntry, ContinuationEntry, RetryEntry, RunningEntry, RuntimeTokens, utc_now
from .orchestrator import OrchestratorState
from .workspace import sanitize_workspace_key


def build_runtime_snapshot(config: ServiceConfig, state: OrchestratorState) -> dict[str, Any]:
    now = utc_now()
    running = [_running_row(entry) for entry in state.running.values()]
    retrying = [_retry_row(entry) for entry in state.retry_attempts.values()]
    continuing = [_continuation_row(entry) for entry in state.continuations.values()]
    blocked = [_blocked_row(entry) for entry in state.blocked.values()]
    return {
        "generated_at": _iso(now),
        "counts": {
            "running": len(running),
            "retrying": len(retrying),
            "continuing": len(continuing),
            "blocked": len(blocked),
        },
        "running": running,
        "retrying": retrying,
        "continuing": continuing,
        "blocked": blocked,
        "issues": running + retrying + continuing + blocked,
        "codex_totals": _totals_row(state, now),
        "rate_limits": state.codex_rate_limits,
        "config": {
            "poll_interval_ms": config.polling.interval_ms,
            "max_concurrent_agents": config.agent.max_concurrent_agents,
            "observability": {
                "enabled": config.observability.enabled,
                "host": config.observability.host,
                "allow_refresh": config.observability.allow_refresh,
            },
            "persistence": {
                "enabled": config.persistence.path is not None,
                "path": str(config.persistence.path) if config.persistence.path is not None else None,
            },
        },
    }


def build_issue_snapshot(
    config: ServiceConfig, state: OrchestratorState, issue_identifier: str
) -> dict[str, Any] | None:
    normalized = issue_identifier.strip().lower()
    running_entry = next(
        (entry for entry in state.running.values() if entry.issue.identifier.lower() == normalized),
        None,
    )
    retry_entry = next(
        (entry for entry in state.retry_attempts.values() if entry.identifier.lower() == normalized),
        None,
    )
    continuation_entry = next(
        (entry for entry in state.continuations.values() if entry.identifier.lower() == normalized),
        None,
    )
    blocked_entry = next(
        (entry for entry in state.blocked.values() if entry.identifier.lower() == normalized),
        None,
    )
    if running_entry is None and retry_entry is None and continuation_entry is None and blocked_entry is None:
        return None

    issue_id = (
        running_entry.issue.id
        if running_entry is not None
        else retry_entry.issue_id
        if retry_entry is not None
        else continuation_entry.issue_id
        if continuation_entry is not None
        else blocked_entry.issue_id
    )
    identifier = (
        running_entry.issue.identifier
        if running_entry is not None
        else retry_entry.identifier
        if retry_entry is not None
        else continuation_entry.identifier
        if continuation_entry is not None
        else blocked_entry.identifier
    )
    return {
        "issue_identifier": identifier,
        "issue_id": issue_id,
        "status": _issue_status(running_entry, retry_entry, continuation_entry, blocked_entry),
        "phase": _issue_phase(running_entry, retry_entry, continuation_entry, blocked_entry),
        "status_label": _issue_status_label(running_entry, retry_entry, continuation_entry, blocked_entry),
        "workspace": {
            "path": (
                running_entry.workspace_path
                if running_entry is not None and running_entry.workspace_path
                else str((config.workspace.root / sanitize_workspace_key(identifier)).resolve())
            ),
        },
        "attempts": {
            "restart_count": _restart_count(running_entry, retry_entry, continuation_entry, blocked_entry),
            "current_retry_attempt": _current_retry_attempt(running_entry, retry_entry, continuation_entry, blocked_entry),
        },
        "running": _running_row(running_entry) if running_entry is not None else None,
        "retry": _retry_row(retry_entry) if retry_entry is not None else None,
        "continuation": _continuation_row(continuation_entry) if continuation_entry is not None else None,
        "blocked": _blocked_row(blocked_entry) if blocked_entry is not None else None,
        "logs": {"codex_session_logs": []},
        "recent_events": _recent_events(running_entry, retry_entry, continuation_entry, blocked_entry),
        "last_error": retry_entry.error if retry_entry is not None else blocked_entry.error if blocked_entry is not None else None,
        "tracked": {},
    }


def _running_row(entry: RunningEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue.id,
        "issue_identifier": entry.issue.identifier,
        "issue_url": entry.issue.url,
        "state": entry.issue.state,
        "session_id": entry.session_id,
        "thread_id": entry.thread_id,
        "turn_id": entry.turn_id,
        "worker_host": entry.worker_host,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "workspace_path": entry.workspace_path,
        "turn_count": entry.turn_count,
        "last_event": entry.last_codex_event,
        "last_message": entry.last_codex_message,
        "last_raw_message": entry.last_raw_codex_message,
        "recent_events": entry.recent_events,
        "started_at": _iso(entry.started_at),
        "last_event_at": _iso(entry.last_codex_timestamp),
        "tokens": _tokens_row(entry.tokens),
    }


def _retry_row(entry: RetryEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": _iso(entry.due_at),
        "due_at_ms": entry.due_at_ms,
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _continuation_row(entry: ContinuationEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "due_at": _iso(entry.due_at),
        "due_at_ms": entry.due_at_ms,
        "error": None,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _blocked_row(entry: BlockedEntry) -> dict[str, Any]:
    return {
        "issue_id": entry.issue_id,
        "issue_identifier": entry.identifier,
        "issue_url": entry.issue_url,
        "attempt": entry.attempt,
        "blocked_at": _iso(entry.blocked_at),
        "error": entry.error,
        "last_message": entry.last_message,
        "phase": entry.phase,
        "status_label": entry.status_label,
        "recent_events": entry.recent_events,
    }


def _totals_row(state: OrchestratorState, now: datetime) -> dict[str, Any]:
    active_seconds = sum(max((now - entry.started_at).total_seconds(), 0) for entry in state.running.values())
    return {
        "input_tokens": state.codex_totals.input_tokens,
        "output_tokens": state.codex_totals.output_tokens,
        "total_tokens": state.codex_totals.total_tokens,
        "seconds_running": state.ended_runtime_seconds + active_seconds,
    }


def _tokens_row(tokens: RuntimeTokens) -> dict[str, int]:
    return {
        "input_tokens": tokens.input_tokens,
        "output_tokens": tokens.output_tokens,
        "total_tokens": tokens.total_tokens,
    }


def _restart_count(
    running: RunningEntry | None,
    retry: RetryEntry | None,
    continuation: ContinuationEntry | None = None,
    blocked: BlockedEntry | None = None,
) -> int:
    attempt = _current_retry_attempt(running, retry, continuation, blocked)
    return max(attempt - 1, 0)


def _current_retry_attempt(
    running: RunningEntry | None,
    retry: RetryEntry | None,
    continuation: ContinuationEntry | None = None,
    blocked: BlockedEntry | None = None,
) -> int:
    if running is not None:
        return running.retry_attempt
    if retry is not None:
        return retry.attempt
    if continuation is not None:
        return continuation.attempt
    if blocked is not None:
        return blocked.attempt
    return 0


def _recent_events(
    running: RunningEntry | None,
    retry: RetryEntry | None = None,
    continuation: ContinuationEntry | None = None,
    blocked: BlockedEntry | None = None,
) -> list[dict[str, Any]]:
    if running is not None and running.recent_events:
        return running.recent_events
    if retry is not None and retry.recent_events:
        return retry.recent_events
    if continuation is not None and continuation.recent_events:
        return continuation.recent_events
    if blocked is not None and blocked.recent_events:
        return blocked.recent_events
    entry = running
    if entry is None or entry.last_codex_event is None:
        return []
    return [
        {
            "at": _iso(entry.last_codex_timestamp),
            "event": entry.last_codex_event,
            "message": entry.last_codex_message,
        }
    ]


def _issue_status(
    running: RunningEntry | None,
    retry: RetryEntry | None,
    continuation: ContinuationEntry | None,
    blocked: BlockedEntry | None,
) -> str:
    if running is not None:
        return "running"
    if retry is not None:
        return "retrying"
    if blocked is not None:
        return "blocked"
    return "continuing"


def _issue_phase(
    running: RunningEntry | None,
    retry: RetryEntry | None,
    continuation: ContinuationEntry | None,
    blocked: BlockedEntry | None,
) -> str:
    if running is not None:
        return running.phase
    if retry is not None:
        return retry.phase
    if blocked is not None:
        return blocked.phase
    return continuation.phase


def _issue_status_label(
    running: RunningEntry | None,
    retry: RetryEntry | None,
    continuation: ContinuationEntry | None,
    blocked: BlockedEntry | None,
) -> str:
    if running is not None:
        return running.status_label
    if retry is not None:
        return retry.status_label
    if blocked is not None:
        return blocked.status_label
    return continuation.status_label


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
