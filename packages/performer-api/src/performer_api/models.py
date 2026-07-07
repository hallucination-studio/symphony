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
