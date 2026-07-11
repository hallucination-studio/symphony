from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from podium.linear_reconciliation import LinearReconciler
from test_podium_linear_reconciliation import _app


def _timestamp(offset_seconds: int) -> str:
    value = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return value.isoformat().replace("+00:00", "Z")


def _issue(
    issue_id: str,
    *,
    updated_at: str,
    delegated: bool = True,
    title: str = "Do the work",
) -> dict[str, Any]:
    return {
        "id": issue_id,
        "identifier": f"ALPHA-{issue_id.rsplit('-', 1)[-1]}",
        "title": title,
        "description": "Acceptance work",
        "createdAt": _timestamp(-600),
        "updatedAt": updated_at,
        "project": {"id": "project-alpha", "slugId": "ALPHA"},
        "delegate": {"id": "agent-alpha"} if delegated else None,
        "parent": None,
        "inverseRelations": {"nodes": []},
    }


def _page(
    nodes: list[dict[str, Any]],
    *,
    has_next: bool = False,
    end_cursor: str | None = None,
    status_code: int = 200,
) -> httpx.Response:
    return httpx.Response(
        status_code,
        json={
            "data": {
                "issues": {
                    "nodes": nodes,
                    "pageInfo": {"hasNextPage": has_next, "endCursor": end_cursor},
                }
            }
        },
    )


@pytest.mark.asyncio
async def test_baseline_scan_paginates_and_commits_one_epoch_per_issue() -> None:
    calls: list[dict[str, Any]] = []
    updated = _timestamp(-60)

    def transport(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append({"query": payload["query"], "variables": payload["variables"]})
        if payload["variables"]["after"] is None:
            return _page(
                [_issue("issue-1", updated_at=updated), _issue("issue-2", updated_at=updated)],
                has_next=True,
                end_cursor="page-1",
            )
        return _page([_issue("issue-3", updated_at=updated)])

    app = _app()
    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
        page_size=2,
    ).reconcile_once()
    store = app.state.podium.store

    assert result == {"installations": 1, "bindings": 1, "queued": 3, "errors": 0}
    assert [call["variables"]["after"] for call in calls] == [None, "page-1"]
    assert all("delegate: { id: { eq: $delegateId } }" in call["query"] for call in calls)
    assert all("updatedAfter" not in call["variables"] for call in calls)
    assert all("$updatedAfter" not in call["query"] for call in calls)
    state = await store.get_linear_reconciliation_state("binding-1")
    assert state is not None
    assert state["baseline_complete"] is True
    assert state["page_cursor"] == ""
    assert state["checkpoint_updated_at"]
    assert state["checkpoint_issue_id"] == ""
    observations = [
        await store.get_linear_issue_observation("binding-1", f"issue-{index}")
        for index in range(1, 4)
    ]
    assert all(row and row["delegated"] is True and row["delegation_epoch"] == 1 for row in observations)
    assert {row["intake_key"] for row in store.dispatches} == {
        "linear-issue:issue-1:epoch:1",
        "linear-issue:issue-2:epoch:1",
        "linear-issue:issue-3:epoch:1",
    }


@pytest.mark.asyncio
async def test_incremental_scan_opens_new_epoch_only_after_observed_undelegation() -> None:
    phase = "baseline"
    baseline_updated = _timestamp(-60)
    undelegated_updated = _timestamp(1)
    redelegated_updated = _timestamp(2)

    def transport(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        query = payload["query"]
        if phase == "baseline":
            return _page([_issue("issue-1", updated_at=baseline_updated)])
        assert "delegate: { id: { eq: $delegateId } }" not in query
        if phase == "undelegated":
            return _page([_issue("issue-1", updated_at=undelegated_updated, delegated=False)])
        return _page([_issue("issue-1", updated_at=redelegated_updated)])

    app = _app()
    reconciler = LinearReconciler(state=app.state.podium, transport=transport)
    first = await reconciler.reconcile_once()
    phase = "undelegated"
    second = await reconciler.reconcile_once()
    phase = "redelegated"
    third = await reconciler.reconcile_once()
    store = app.state.podium.store

    assert [first["queued"], second["queued"], third["queued"]] == [1, 0, 1]
    observation = await store.get_linear_issue_observation("binding-1", "issue-1")
    assert observation is not None
    assert observation["delegated"] is True
    assert observation["delegation_epoch"] == 2
    assert {row["intake_key"] for row in store.dispatches} == {
        "linear-issue:issue-1:epoch:1",
        "linear-issue:issue-1:epoch:2",
    }


@pytest.mark.asyncio
async def test_incremental_scan_replays_timestamp_boundary_without_duplicate_dispatch() -> None:
    shared_time = _timestamp(1)
    earlier_time = _timestamp(-10)
    phase = "first"
    app = _app()

    def transport(_request: httpx.Request) -> httpx.Response:
        issues = [_issue("issue-a", updated_at=shared_time), _issue("issue-b", updated_at=shared_time)]
        if phase == "boundary-overlap":
            issues.append(_issue("issue-0", updated_at=shared_time))
        return _page(issues)

    store = app.state.podium.store
    await store.save_linear_reconciliation_state(
        "binding-1",
        {
            "binding_id": "binding-1",
            "baseline_complete": True,
            "checkpoint_updated_at": earlier_time,
            "checkpoint_issue_id": "",
            "page_cursor": "",
            "retry_count": 0,
            "next_retry_at": None,
        },
    )
    reconciler = LinearReconciler(state=app.state.podium, transport=transport)
    first = await reconciler.reconcile_once()
    phase = "boundary-overlap"
    second = await reconciler.reconcile_once()

    assert first["queued"] == 2
    assert second["queued"] == 1
    assert await store.get_linear_issue_observation("binding-1", "issue-0") is not None
    state = await store.get_linear_reconciliation_state("binding-1")
    assert state is not None
    assert (state["checkpoint_updated_at"], state["checkpoint_issue_id"]) == (shared_time, "issue-b")
    assert len(store.dispatches) == 3


@pytest.mark.asyncio
async def test_failed_second_page_resumes_committed_cursor_after_durable_backoff() -> None:
    fail_second_page = True
    calls: list[str | None] = []

    def transport(request: httpx.Request) -> httpx.Response:
        after = json.loads(request.content)["variables"]["after"]
        calls.append(after)
        if after is None:
            return _page([_issue("issue-1", updated_at=_timestamp(-30))], has_next=True, end_cursor="page-1")
        if fail_second_page:
            return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})
        return _page([_issue("issue-2", updated_at=_timestamp(-20))])

    app = _app()
    store = app.state.podium.store
    reconciler = LinearReconciler(state=app.state.podium, transport=transport)
    failed = await reconciler.reconcile_once()
    deferred = await reconciler.reconcile_once()
    state = await store.get_linear_reconciliation_state("binding-1")
    assert state is not None
    await store.save_linear_reconciliation_state(
        "binding-1",
        {**state, "next_retry_at": _timestamp(-1)},
    )
    fail_second_page = False
    resumed = await reconciler.reconcile_once()

    assert failed["errors"] == 1
    assert deferred["errors"] == 0
    assert calls == [None, "page-1", "page-1"]
    failed_state = state
    assert failed_state["page_cursor"] == "page-1"
    assert failed_state["baseline_complete"] is False
    assert failed_state["retry_count"] == 1
    assert failed_state["next_retry_at"]
    assert failed_state["last_error_code"] == "linear_reconciliation_unavailable"
    assert resumed["queued"] == 1
    final_state = await store.get_linear_reconciliation_state("binding-1")
    assert final_state is not None
    assert final_state["baseline_complete"] is True
    assert final_state["page_cursor"] == ""
    assert final_state["retry_count"] == 0
    assert len(store.dispatches) == 2
