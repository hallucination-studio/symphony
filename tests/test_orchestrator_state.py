from __future__ import annotations

from datetime import timedelta

import pytest

from performer.orchestrator_state import OrchestratorState, StateTransitionError
from performer_api.models import ContinuationEntry, Issue, RetryEntry, RunningEntry, utc_now


def _issue(issue_id: str = "issue-1") -> Issue:
    return Issue(
        id=issue_id,
        identifier="MT-1",
        title="Build",
        state="In Progress",
        url="https://linear.app/x/issue/MT-1",
    )


def _running(issue: Issue | None = None) -> RunningEntry:
    issue = issue or _issue()
    return RunningEntry(issue=issue, task=None, started_at=utc_now(), retry_attempt=0)


def test_state_claim_refuses_running_issue_until_finished() -> None:
    state = OrchestratorState()
    issue = _issue()
    state.mark_running(_running(issue))

    with pytest.raises(StateTransitionError):
        state.claim(issue.id)

    entry = state.finish_running(issue.id)
    assert entry is not None
    state.release(issue.id)
    state.claim(issue.id)

    assert issue.id in state.claimed
    assert issue.id not in state.running


def test_state_terminal_completion_clears_active_buckets_and_dedupes_dispatch() -> None:
    state = OrchestratorState()
    issue = _issue()
    due_at = utc_now() + timedelta(seconds=30)
    state.retry_attempts[issue.id] = RetryEntry(
        issue_id=issue.id,
        identifier=issue.identifier,
        attempt=1,
        due_at=due_at,
        due_at_ms=1,
        error="failed",
        issue_url=issue.url,
    )
    state.claimed.add(issue.id)

    state.mark_completed(issue.id)

    assert issue.id in state.completed
    assert issue.id not in state.claimed
    assert issue.id not in state.retry_attempts
    assert state.dispatch_blocked(issue.id) is True

    state.release_completed(issue.id)

    assert issue.id not in state.completed
    assert state.dispatch_blocked(issue.id) is False


def test_state_retry_and_continuation_are_mutually_exclusive_claims() -> None:
    state = OrchestratorState()
    issue = _issue()
    due_at = utc_now() + timedelta(seconds=30)
    continuation = ContinuationEntry(
        issue_id=issue.id,
        identifier=issue.identifier,
        attempt=2,
        due_at=due_at,
        due_at_ms=1,
        issue_url=issue.url,
    )
    retry = RetryEntry(
        issue_id=issue.id,
        identifier=issue.identifier,
        attempt=3,
        due_at=due_at,
        due_at_ms=1,
        error="failed",
        issue_url=issue.url,
    )

    state.mark_continuation(continuation)
    assert issue.id in state.claimed
    assert issue.id in state.continuations
    assert issue.id not in state.retry_attempts

    state.mark_retry(retry)
    assert issue.id in state.claimed
    assert issue.id in state.retry_attempts
    assert issue.id not in state.continuations
