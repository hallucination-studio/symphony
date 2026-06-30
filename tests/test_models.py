from __future__ import annotations

from datetime import datetime, timezone

from symphony.models import BlockerRef, Issue, sort_for_dispatch


def test_issue_normalizes_labels_and_priority() -> None:
    issue = Issue(
        id="issue-1",
        identifier="MT-1",
        title="Test issue",
        state="Todo",
        labels=[" Codex ", "BACKEND", ""],
        priority="2",
    )

    assert issue.labels == ["codex", "backend"]
    assert issue.priority == 2


def test_todo_issue_with_non_terminal_blocker_is_not_dispatchable() -> None:
    issue = Issue(
        id="issue-1",
        identifier="MT-1",
        title="Test issue",
        state="Todo",
        blocked_by=[BlockerRef(id="blocked", identifier="MT-0", state="In Progress")],
    )

    assert issue.has_non_terminal_blocker(["Done", "Canceled"])


def test_sort_for_dispatch_orders_by_priority_created_at_identifier() -> None:
    older = datetime(2024, 1, 1, tzinfo=timezone.utc)
    newer = datetime(2024, 1, 2, tzinfo=timezone.utc)
    issues = [
        Issue(id="3", identifier="MT-3", title="No priority", state="Todo", created_at=older),
        Issue(id="2", identifier="MT-2", title="Newer p1", state="Todo", priority=1, created_at=newer),
        Issue(id="1", identifier="MT-1", title="Older p1", state="Todo", priority=1, created_at=older),
    ]

    assert [issue.identifier for issue in sort_for_dispatch(issues)] == ["MT-1", "MT-2", "MT-3"]
