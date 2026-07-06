from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from performer_api.models import (
    BlockedEntry,
    ContinuationEntry,
    HumanInterventionEntry,
    RetryEntry,
    RunningEntry,
    RuntimeTokens,
)
from performer_api.persistence import CodexThreadEntry


class StateTransitionError(RuntimeError):
    pass


@dataclass
class OrchestratorState:
    running: dict[str, RunningEntry] = field(default_factory=dict)
    claimed: set[str] = field(default_factory=set)
    retry_attempts: dict[str, RetryEntry] = field(default_factory=dict)
    continuations: dict[str, ContinuationEntry] = field(default_factory=dict)
    blocked: dict[str, BlockedEntry] = field(default_factory=dict)
    human_interventions: dict[str, HumanInterventionEntry] = field(default_factory=dict)
    completed: set[str] = field(default_factory=set)
    codex_totals: RuntimeTokens = field(default_factory=RuntimeTokens)
    codex_rate_limits: dict[str, Any] | None = None
    ended_runtime_seconds: float = 0
    codex_threads: dict[str, CodexThreadEntry] = field(default_factory=dict)

    def dispatch_blocked(self, issue_id: str) -> bool:
        return issue_id in self.running or issue_id in self.claimed or issue_id in self.completed

    def claim(self, issue_id: str) -> None:
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is already running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)

    def release(self, issue_id: str) -> None:
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        self.claimed.discard(issue_id)

    def forget_active(self, issue_id: str, *, keep_human_intervention: bool = False) -> None:
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        self.claimed.discard(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.continuations.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        if not keep_human_intervention:
            self.human_interventions.pop(issue_id, None)

    def mark_running(self, entry: RunningEntry) -> None:
        issue_id = entry.issue.id
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is already running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.continuations.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        self.human_interventions.pop(issue_id, None)
        self.running[issue_id] = entry

    def finish_running(self, issue_id: str) -> RunningEntry | None:
        return self.running.pop(issue_id, None)

    def mark_retry(self, entry: RetryEntry) -> None:
        issue_id = entry.issue_id
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)
        self.continuations.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        self.human_interventions.pop(issue_id, None)
        self.retry_attempts[issue_id] = entry

    def release_retry(self, issue_id: str) -> RetryEntry | None:
        entry = self.retry_attempts.pop(issue_id, None)
        self.claimed.discard(issue_id)
        return entry

    def mark_continuation(self, entry: ContinuationEntry) -> None:
        issue_id = entry.issue_id
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        self.human_interventions.pop(issue_id, None)
        self.continuations[issue_id] = entry

    def release_continuation(self, issue_id: str) -> ContinuationEntry | None:
        entry = self.continuations.pop(issue_id, None)
        self.claimed.discard(issue_id)
        return entry

    def mark_blocked(self, entry: BlockedEntry) -> None:
        issue_id = entry.issue_id
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.continuations.pop(issue_id, None)
        self.human_interventions.pop(issue_id, None)
        self.blocked[issue_id] = entry

    def mark_human_intervention(self, entry: HumanInterventionEntry) -> None:
        issue_id = entry.issue_id
        if issue_id in self.running:
            raise StateTransitionError(f"issue {issue_id} is still running")
        if issue_id in self.completed:
            raise StateTransitionError(f"issue {issue_id} is already completed")
        self.claimed.add(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.continuations.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        self.human_interventions[issue_id] = entry

    def release_human_intervention(self, issue_id: str) -> HumanInterventionEntry | None:
        self.blocked.pop(issue_id, None)
        return self.human_interventions.pop(issue_id, None)

    def mark_completed(self, issue_id: str) -> None:
        self.running.pop(issue_id, None)
        self.claimed.discard(issue_id)
        self.retry_attempts.pop(issue_id, None)
        self.continuations.pop(issue_id, None)
        self.blocked.pop(issue_id, None)
        self.human_interventions.pop(issue_id, None)
        self.completed.add(issue_id)

    def release_completed(self, issue_id: str) -> None:
        self.completed.discard(issue_id)
