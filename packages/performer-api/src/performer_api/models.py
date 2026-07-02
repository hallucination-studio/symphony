from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def normalize_state_key(value: str) -> str:
    return value.strip().lower()


def normalize_labels(labels: list[str] | None) -> list[str]:
    if not labels:
        return []
    return [label.strip().lower() for label in labels if label.strip()]


def parse_datetime(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


LIFECYCLE_LABEL_PREFIX = "performer:"
LIFECYCLE_LABELS = {
    "queued": f"{LIFECYCLE_LABEL_PREFIX}queued",
    "starting": f"{LIFECYCLE_LABEL_PREFIX}starting",
    "running": f"{LIFECYCLE_LABEL_PREFIX}running",
    "error": f"{LIFECYCLE_LABEL_PREFIX}error",
    "continuing": f"{LIFECYCLE_LABEL_PREFIX}continuing",
    "retrying": f"{LIFECYCLE_LABEL_PREFIX}retrying",
    "failed": f"{LIFECYCLE_LABEL_PREFIX}failed",
    "done": f"{LIFECYCLE_LABEL_PREFIX}done",
}


@dataclass(frozen=True)
class BlockerRef:
    id: str | None = None
    identifier: str | None = None
    state: str | None = None

    @classmethod
    def from_linear_relation(cls, relation: dict[str, Any]) -> BlockerRef | None:
        if relation.get("type") != "blocks":
            return None
        issue = relation.get("issue") or relation.get("relatedIssue") or {}
        state = issue.get("state")
        if isinstance(state, dict):
            state_name = state.get("name")
        else:
            state_name = state
        return cls(
            id=issue.get("id"),
            identifier=issue.get("identifier"),
            state=state_name,
        )


@dataclass
class Issue:
    id: str
    identifier: str
    title: str
    state: str
    description: str | None = None
    priority: int | None = None
    branch_name: str | None = None
    url: str | None = None
    labels: list[str] = field(default_factory=list)
    blocked_by: list[BlockerRef] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    assignee_id: str | None = None
    delegate_id: str | None = None
    project_slug: str | None = None
    project_name: str | None = None

    def __post_init__(self) -> None:
        self.labels = normalize_labels(self.labels)
        self.priority = self._normalize_priority(self.priority)
        self.created_at = parse_datetime(self.created_at)
        self.updated_at = parse_datetime(self.updated_at)

    @staticmethod
    def _normalize_priority(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
        return None

    def state_key(self) -> str:
        return normalize_state_key(self.state)

    def has_required_labels(self, required_labels: list[str]) -> bool:
        if any(not str(label).strip() for label in required_labels):
            return False
        issue_labels = set(self.labels)
        normalized_required = normalize_labels(required_labels)
        return all(label in issue_labels for label in normalized_required)

    def has_non_terminal_blocker(self, terminal_states: list[str]) -> bool:
        terminal = {normalize_state_key(state) for state in terminal_states}
        for blocker in self.blocked_by:
            if blocker.state is None:
                return True
            if normalize_state_key(blocker.state) not in terminal:
                return True
        return False


@dataclass(init=False)
class RuntimeTokens:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0

    def __init__(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        total_tokens: int | None = None,
    ) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        if total_tokens is None:
            self.cached_tokens = 0
            self.total_tokens = cached_tokens
        else:
            self.cached_tokens = cached_tokens
            self.total_tokens = total_tokens


@dataclass
class RunningEntry:
    issue: Issue
    task: Any
    started_at: datetime
    retry_attempt: int
    session_id: str | None = None
    thread_id: str | None = None
    turn_id: str | None = None
    worker_host: str | None = None
    codex_app_server_pid: int | None = None
    last_codex_event: str | None = None
    last_codex_timestamp: datetime | None = None
    last_codex_message: str | None = None
    last_raw_codex_message: str | None = None
    phase: str = "starting"
    status_label: str = LIFECYCLE_LABELS["starting"]
    workspace_path: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)
    tokens: RuntimeTokens = field(default_factory=RuntimeTokens)
    last_reported_tokens: RuntimeTokens = field(default_factory=RuntimeTokens)
    turn_count: int = 0
    human_blocked_reason: str | None = None


@dataclass
class RetryEntry:
    issue_id: str
    identifier: str
    attempt: int
    due_at: datetime
    due_at_ms: int
    error: str | None = None
    issue_url: str | None = None
    phase: str = "retrying"
    status_label: str = LIFECYCLE_LABELS["retrying"]
    last_message: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ContinuationEntry:
    issue_id: str
    identifier: str
    attempt: int
    due_at: datetime
    due_at_ms: int
    issue_url: str | None = None
    phase: str = "continuing"
    status_label: str = LIFECYCLE_LABELS["continuing"]
    last_message: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class BlockedEntry:
    issue_id: str
    identifier: str
    attempt: int
    blocked_at: datetime
    error: str
    issue_url: str | None = None
    phase: str = "error"
    status_label: str = LIFECYCLE_LABELS["error"]
    last_message: str | None = None
    recent_events: list[dict[str, Any]] = field(default_factory=list)


def sort_for_dispatch(issues: list[Issue]) -> list[Issue]:
    max_dt = datetime.max.replace(tzinfo=timezone.utc)
    return sorted(
        issues,
        key=lambda issue: (
            issue.priority if issue.priority is not None else 999_999,
            issue.created_at or max_dt,
            issue.identifier,
        ),
    )
