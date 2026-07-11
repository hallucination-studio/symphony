from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from podium.app import create_app


def _app(store: object) -> object:
    return create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=store,
    )


@pytest.mark.asyncio
async def test_dispatch_http_lease_and_ack_preserve_fencing_and_managed_run_fields() -> None:
    leased = {
        "dispatch_id": "dispatch-1",
        "project_binding_id": "binding-1",
        "issue_id": "issue-1",
        "issue_identifier": "ALPHA-1",
        "linear_workspace_id": "user-1",
        "project_slug": "ALPHA",
        "status": "leased",
        "fencing_token": 3,
    }
    completed = {
        **leased,
        "status": "completed",
        "reason": "completed_by_runtime",
        "run_id": "run-1",
        "active_work_item_id": "work-item-1",
        "managed_run_state": "done",
        "plan_version": 2,
        "backend_session_id": "thread-1",
    }
    store = SimpleNamespace(ack_dispatch=AsyncMock(return_value=completed))
    app = _app(store)
    app.state.podium.runtime_for_bearer = AsyncMock(
        return_value={"id": "runtime-1", "runtime_group_id": "group-1"}
    )
    app.state.podium.lease_dispatch = AsyncMock(return_value=leased)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        lease = await client.post(
            "/api/v1/runtime/dispatches/lease",
            headers={"Authorization": "Bearer runtime-token"},
        )
        missing_fence = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": "Bearer runtime-token"},
            json={"dispatch_id": "dispatch-1", "status": "completed"},
        )
        acknowledged = await client.post(
            "/api/v1/runtime/dispatches/ack",
            headers={"Authorization": "Bearer runtime-token"},
            json={
                "dispatch_id": "dispatch-1",
                "fencing_token": 3,
                "status": "completed",
                "reason": "completed_by_runtime",
                "run_id": "run-1",
                "parent_issue_id": "issue-1",
                "active_work_item_id": "work-item-1",
                "managed_run_state": "done",
                "plan_version": 2,
                "backend_session_id": "thread-1",
            },
        )

    assert lease.status_code == 200
    assert lease.json()["dispatch"]["fencing_token"] == 3
    assert missing_fence.status_code == 409
    assert missing_fence.json()["error"]["code"] == "stale_dispatch_lease"
    assert acknowledged.status_code == 200
    assert acknowledged.json()["dispatch"]["run_id"] == "run-1"
    assert acknowledged.json()["dispatch"]["managed_run_state"] == "done"
    assert "runtime_phase" not in acknowledged.text
    assert "graph_id" not in acknowledged.text
    stored_managed_run = store.ack_dispatch.await_args.kwargs["managed_run"]
    assert stored_managed_run == {
        "run_id": "run-1",
        "parent_issue_id": "issue-1",
        "active_work_item_id": "work-item-1",
        "managed_run_state": "done",
        "backend_session_id": "thread-1",
        "plan_version": 2,
    }


@pytest.mark.asyncio
async def test_runtime_report_projects_metrics_queue_and_log_tail_to_store() -> None:
    store = SimpleNamespace(
        upsert_project_binding=AsyncMock(),
        upsert_metrics_snapshot=AsyncMock(),
        upsert_instance_log_tail=AsyncMock(),
    )
    app = _app(store)
    conductor = {
        "id": "runtime-1",
        "runtime_group_id": "group-1",
        "last_report_at": "2026-07-11T00:00:00Z",
    }
    binding = {
        "id": "binding-1",
        "instance_id": "instance-1",
        "process_status": "running",
    }

    await app.state.podium._store_binding_report(
        "runtime-1",
        conductor,
        binding,
        metrics={
            "instance-1": {
                "tokens": 10,
                "runtime_seconds": 20,
                "retries": 1,
                "continuations": 2,
                "blocked": 3,
                "pending_human": 4,
                "failures": 5,
            }
        },
        queue={"instance-1": {"queued": 5, "leased": 1, "running": 1}},
        log_tail={
            "instance-1": {
                "generation": 7,
                "offset_end": 123,
                "lines": ["newest", "older"],
            }
        },
    )

    metrics = store.upsert_metrics_snapshot.await_args.args[2]
    tail = store.upsert_instance_log_tail.await_args.args[2]
    assert metrics["tokens"] == 10
    assert metrics["pending_human"] == 4
    assert metrics["queue_depth"] == 6
    assert metrics["running"] is True
    assert tail["generation"] == 7
    assert tail["offset_end"] == 123
    assert tail["lines"] == ["newest", "older"]


@pytest.mark.asyncio
async def test_agent_session_webhook_route_is_removed() -> None:
    app = _app(object())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        response = await client.post(
            "/api/v1/linear/webhooks/agent-session",
            json={"type": "AgentSessionEvent"},
        )

    assert response.status_code == 404
