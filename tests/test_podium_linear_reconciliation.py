from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.config import PodiumConfig
from podium.linear_reconciliation import LinearReconciler


INSTALLATION = {
    "id": "installation-1",
    "user_id": "user-1",
    "linear_organization_id": "org-1",
    "app_user_id": "agent-alpha",
    "updated_at": "2026-07-11T00:00:00Z",
    "reconciliation_state": "pending",
}
PROJECT = {
    "linear_project_id": "project-alpha",
    "project_slug": "ALPHA",
}
BINDING = {
    "id": "binding-1",
    "conductor_id": "runtime-1",
    "user_id": "user-1",
    "instance_id": "instance-1",
    "project_slug": "ALPHA",
    "agent_app_user_id": "agent-alpha",
    "managed_run_profile": "default",
    "state": "ready",
}


class _ReconciliationStore:
    def __init__(self) -> None:
        self.states: dict[str, dict[str, Any]] = {}
        self.observations: dict[tuple[str, str], dict[str, Any]] = {}
        self.dispatches: list[dict[str, Any]] = []
        self.route_valid = True

    async def get_ready_project_binding_for_installation(
        self,
        user_id: str,
        project_id: str,
        *,
        installation_id: str,
        agent_app_user_id: str,
    ) -> dict[str, Any] | None:
        if not self.route_valid:
            return None
        if (user_id, project_id, installation_id, agent_app_user_id) != (
            "user-1",
            "project-alpha",
            "installation-1",
            "agent-alpha",
        ):
            return None
        return dict(BINDING)

    async def get_linear_reconciliation_state(
        self,
        binding_id: str,
    ) -> dict[str, Any] | None:
        row = self.states.get(binding_id)
        return dict(row) if row is not None else None

    async def save_linear_reconciliation_state(
        self,
        binding_id: str,
        state: dict[str, Any],
    ) -> None:
        self.states[binding_id] = dict(state)

    async def get_linear_issue_observations(
        self,
        binding_id: str,
        issue_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        return {
            issue_id: dict(self.observations[(binding_id, issue_id)])
            for issue_id in issue_ids
            if (binding_id, issue_id) in self.observations
        }

    async def get_linear_issue_observation(
        self,
        binding_id: str,
        issue_id: str,
    ) -> dict[str, Any] | None:
        row = self.observations.get((binding_id, issue_id))
        return dict(row) if row is not None else None

    async def commit_linear_reconciliation_page(
        self,
        binding_id: str,
        *,
        expected_state: dict[str, Any] | None,
        expected_installation_id: str,
        expected_agent_app_user_id: str,
        state: dict[str, Any],
        observations: list[dict[str, Any]],
        dispatches: list[dict[str, Any]],
    ) -> int | None:
        if (
            not self.route_valid
            or expected_installation_id != INSTALLATION["id"]
            or expected_agent_app_user_id != INSTALLATION["app_user_id"]
        ):
            return None
        current = self.states.get(binding_id)
        if current != expected_state:
            return None
        self.states[binding_id] = dict(state)
        for observation in observations:
            key = (binding_id, str(observation["issue_id"]))
            self.observations[key] = dict(observation)
        known_intake_keys = {str(row["intake_key"]) for row in self.dispatches}
        inserted = 0
        for row in dispatches:
            intake_key = str(row["intake_key"])
            if intake_key in known_intake_keys:
                continue
            known_intake_keys.add(intake_key)
            self.dispatches.append(dict(row))
            inserted += 1
        return inserted

    async def reap_expired_dispatch_leases(self) -> int:
        return 0


def _app(store: _ReconciliationStore | None = None) -> Any:
    selected_store = store or _ReconciliationStore()
    app = create_app(
        secure_cookies=False,
        secret_key="test-secret",
        store=selected_store,
    )
    state = app.state.podium
    state.list_active_linear_installations = AsyncMock(
        return_value=[dict(INSTALLATION)]
    )
    state.list_selected_linear_projects = AsyncMock(return_value=[dict(PROJECT)])
    state.linear_access_token = AsyncMock(return_value="workspace-oauth-token")
    async def update_health(
        installation: dict[str, Any],
        **changes: Any,
    ) -> dict[str, Any]:
        changes.pop("expected_updated_at", None)
        return {
            **installation,
            **changes,
            "updated_at": "2026-07-11T00:00:01Z",
        }

    state.update_linear_reconciliation_health = AsyncMock(side_effect=update_health)
    state.get_active_linear_installation = AsyncMock(return_value=dict(INSTALLATION))
    state.notify_reconciled_dispatches = AsyncMock()
    return app


def _issue(
    *,
    issue_id: str = "issue-1",
    title: str = "Do the work",
    description: str = "",
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "id": issue_id,
        "identifier": "ALPHA-1",
        "title": title,
        "description": description,
        "createdAt": (now - timedelta(seconds=30)).isoformat().replace("+00:00", "Z"),
        "updatedAt": (now - timedelta(seconds=10)).isoformat().replace("+00:00", "Z"),
        "project": {"id": "project-alpha", "slugId": "ALPHA"},
        "delegate": {"id": "agent-alpha"},
        "parent": None,
        "inverseRelations": {"nodes": []},
    }


@pytest.mark.asyncio
async def test_reconciliation_uses_active_installation_token_and_stable_project_id() -> None:
    seen: dict[str, Any] = {}

    def transport(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("Authorization")
        seen["variables"] = json.loads(request.content)["variables"]
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [_issue()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    app = _app()
    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
    ).reconcile_once()
    store = app.state.podium.store

    assert result == {"installations": 1, "bindings": 1, "queued": 1, "errors": 0}
    assert seen["authorization"] == "Bearer workspace-oauth-token"
    assert seen["variables"]["projectId"] == "project-alpha"
    assert seen["variables"]["delegateId"] == "agent-alpha"
    assert store.dispatches[0]["issue_id"] == "issue-1"
    state = await store.get_linear_reconciliation_state("binding-1")
    assert state is not None
    assert state["baseline_complete"] is True
    assert state["checkpoint_updated_at"]
    assert state["checkpoint_issue_id"] == ""
    assert state["last_error"] == ""


@pytest.mark.asyncio
async def test_reconciliation_failure_preserves_cursor_and_is_visible(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})

    store = _ReconciliationStore()
    await store.save_linear_reconciliation_state(
        "binding-1",
        {
            "binding_id": "binding-1",
            "baseline_complete": True,
            "checkpoint_updated_at": "2026-07-10T09:00:00Z",
            "checkpoint_issue_id": "issue-0",
        },
    )
    app = _app(store)
    with caplog.at_level(logging.WARNING):
        result = await LinearReconciler(
            state=app.state.podium,
            transport=transport,
        ).reconcile_once()

    assert result["errors"] == 1
    state = await store.get_linear_reconciliation_state("binding-1")
    assert state is not None
    assert state["checkpoint_updated_at"] == "2026-07-10T09:00:00Z"
    assert state["checkpoint_issue_id"] == "issue-0"
    assert state["last_error_code"] == "linear_reconciliation_unavailable"
    assert state["last_error"] == "Linear reconciliation is unavailable"
    health = app.state.podium.update_linear_reconciliation_health
    assert health.await_args.kwargs["reconciliation_state"] == "degraded"
    assert health.await_args.kwargs["reconciliation_retry_count"] == 1
    assert health.await_args.kwargs["reconciliation_error_code"] == (
        "linear_reconciliation_unavailable"
    )
    assert health.await_args.kwargs["reconciliation_error"] == (
        "Linear reconciliation is unavailable"
    )
    assert health.await_args.kwargs["reconciliation_next_retry_at"]
    assert "event=linear_reconciliation_failed" in caplog.text
    assert "error_code=linear_reconciliation_unavailable" in caplog.text


@pytest.mark.asyncio
async def test_current_binding_failure_retries_installation_health_with_new_revision() -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})

    app = _app()
    current_installation = {
        **INSTALLATION,
        "updated_at": "2026-07-11T00:00:05Z",
        "reconciliation_state": "healthy",
    }
    health_attempts = 0

    async def update_health(
        installation: dict[str, Any],
        **changes: Any,
    ) -> dict[str, Any]:
        nonlocal health_attempts
        health_attempts += 1
        if health_attempts == 1:
            return dict(installation)
        changes.pop("expected_updated_at", None)
        current_installation.update(
            changes,
            updated_at="2026-07-11T00:00:06Z",
        )
        return dict(current_installation)

    app.state.podium.update_linear_reconciliation_health = AsyncMock(
        side_effect=update_health
    )
    app.state.podium.get_active_linear_installation = AsyncMock(
        return_value=current_installation
    )

    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
    ).reconcile_once()

    assert result["errors"] == 1
    assert health_attempts == 2
    attempts = app.state.podium.update_linear_reconciliation_health.await_args_list
    assert attempts[0].kwargs["expected_updated_at"] == "2026-07-11T00:00:00Z"
    assert attempts[1].kwargs["expected_updated_at"] == "2026-07-11T00:00:05Z"
    assert current_installation["reconciliation_state"] == "degraded"


@pytest.mark.asyncio
async def test_superseded_binding_failure_does_not_retry_installation_degradation() -> None:
    store = _ReconciliationStore()

    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})

    app = _app(store)
    newer_success = {
        "binding_id": "binding-1",
        "baseline_complete": True,
        "checkpoint_updated_at": "2026-07-11T00:01:00Z",
        "checkpoint_issue_id": "",
        "page_cursor": "",
        "last_success_at": "2026-07-11T00:01:01Z",
        "last_error_code": "",
        "last_error": "",
        "retry_count": 0,
        "next_retry_at": None,
    }

    async def lose_health_cas(
        installation: dict[str, Any],
        **_changes: Any,
    ) -> dict[str, Any]:
        store.states["binding-1"] = dict(newer_success)
        return dict(installation)

    app.state.podium.update_linear_reconciliation_health = AsyncMock(
        side_effect=lose_health_cas
    )

    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
    ).reconcile_once()

    assert result == {"installations": 1, "bindings": 1, "queued": 0, "errors": 0}
    assert await store.get_linear_reconciliation_state("binding-1") == newer_success
    health_states = [
        call.kwargs["reconciliation_state"]
        for call in app.state.podium.update_linear_reconciliation_health.await_args_list
    ]
    assert health_states == ["degraded", "healthy"]
    app.state.podium.get_active_linear_installation.assert_not_awaited()


@pytest.mark.asyncio
async def test_page_commit_rejects_binding_invalidated_after_linear_fetch() -> None:
    store = _ReconciliationStore()

    def transport(_request: httpx.Request) -> httpx.Response:
        store.route_valid = False
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [_issue()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    result = await LinearReconciler(
        state=_app(store).state.podium,
        transport=transport,
    ).reconcile_once()

    assert result == {"installations": 1, "bindings": 1, "queued": 0, "errors": 0}
    assert store.dispatches == []
    assert await store.get_linear_reconciliation_state("binding-1") is None


@pytest.mark.asyncio
async def test_stale_fetch_failure_does_not_overwrite_newer_success() -> None:
    store = _ReconciliationStore()
    newer_success = {
        "binding_id": "binding-1",
        "baseline_complete": True,
        "checkpoint_updated_at": "2026-07-11T03:00:00Z",
        "checkpoint_issue_id": "",
        "page_cursor": "",
        "last_success_at": "2026-07-11T03:00:01Z",
        "last_error_code": "",
        "last_error": "",
        "retry_count": 0,
        "next_retry_at": None,
    }

    def transport(_request: httpx.Request) -> httpx.Response:
        store.states["binding-1"] = dict(newer_success)
        return httpx.Response(503, json={"errors": [{"message": "unavailable"}]})

    app = _app(store)
    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
    ).reconcile_once()

    assert result == {"installations": 1, "bindings": 1, "queued": 0, "errors": 0}
    assert await store.get_linear_reconciliation_state("binding-1") == newer_success
    health_updates = app.state.podium.update_linear_reconciliation_health.await_args_list
    assert len(health_updates) == 1
    assert health_updates[0].kwargs["reconciliation_state"] == "healthy"


@pytest.mark.asyncio
async def test_page_cas_retries_are_bounded_under_continuous_contention() -> None:
    class ContendedStore(_ReconciliationStore):
        def __init__(self) -> None:
            super().__init__()
            self.commit_attempts = 0

        async def commit_linear_reconciliation_page(self, *args: Any, **kwargs: Any) -> None:
            self.commit_attempts += 1
            return None

    store = ContendedStore()

    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    result = await asyncio.wait_for(
        LinearReconciler(
            state=_app(store).state.podium,
            transport=transport,
        ).reconcile_once(),
        timeout=0.2,
    )

    assert result["queued"] == 0
    assert store.commit_attempts <= 4


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("title", "description"),
    [
        ("[Human Action] Approve", ""),
        ("Generated work item", "SYMPHONY WORK ITEM"),
        ("Run report", "symphony:run-summary:start"),
    ],
)
async def test_reconciliation_ignores_symphony_projection_issues(
    title: str,
    description: str,
) -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [_issue(title=title, description=description)],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    app = _app()
    result = await LinearReconciler(
        state=app.state.podium,
        transport=transport,
    ).reconcile_once()

    assert result["queued"] == 0
    assert app.state.podium.store.dispatches == []


def test_podium_lifespan_always_starts_reconciliation_without_global_token() -> None:
    app = _app()
    app.state.podium.list_active_linear_installations = AsyncMock(return_value=[])
    app.state.podium.config = PodiumConfig(linear_reconciliation_interval_seconds=1)

    with TestClient(app):
        assert app.state.linear_reconciliation_task is not None
        assert not app.state.linear_reconciliation_task.done()

    assert app.state.linear_reconciliation_task is None
