from __future__ import annotations

import asyncio
import json

import httpx

from podium.app import create_app
from podium.config import PodiumConfig
from podium.linear_polling import LinearDelegatePoller
from podium.store import PodiumStore


async def test_linear_delegate_poller_queues_matching_delegated_issue_once(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    await store.create_user("workspace-1", email="workspace@example.com", password_hash="x", created_at="2026-01-01T00:00:00Z")
    await store.upsert_conductor(
        {
            "id": "runtime-1",
            "user_id": "workspace-1",
            "runtime_group_id": "group-workspace-1",
            "hostname": "host",
            "label": "Host",
            "version": "1",
            "runtime_token_hash": "runtime-hash",
            "proxy_token_hash": "proxy-hash",
            "disabled": False,
            "revoked": False,
            "created_at": "2026-01-01T00:00:00Z",
            "last_report_at": None,
        }
    )
    await store.upsert_project_binding(
        {
            "id": "runtime-1:inst-1",
            "conductor_id": "runtime-1",
            "user_id": "workspace-1",
            "instance_id": "inst-1",
            "name": "Instance",
            "linear_project": "ALPHA",
            "project_slug": "ALPHA",
            "agent_app_user_id": "agent-app-1",
            "pipeline_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )
    seen_authorization: list[str | None] = []

    def linear_transport(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers.get("Authorization"))
        body = json.loads(request.content.decode())
        assert body["variables"]["projectSlug"] == "ALPHA"
        assert body["variables"]["delegateId"] == "agent-app-1"
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-1",
                                "identifier": "ALPHA-1",
                                "title": "Do work",
                                "description": "Create the file",
                                "updatedAt": "2026-07-08T12:00:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": None,
                                "inverseRelations": {"nodes": []},
                            }
                        ]
                    }
                }
            },
        )

    poller = LinearDelegatePoller(
        store=store,
        application_id="agent-app-1",
        app_token="app-token",
        transport=linear_transport,
        initial_lookback_seconds=60,
    )

    first = await poller.poll_once()
    second = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")
    poll_state = await store.get_linear_poll_state("runtime-1:inst-1")

    assert first["queued"] == 1
    assert second["queued"] == 0
    assert leased is not None
    assert leased["issue_id"] == "issue-1"
    assert leased["agent_app_user_id"] == "agent-app-1"
    assert seen_authorization == ["app-token", "app-token"]
    assert poll_state is not None
    assert poll_state["cursor"] == "2026-07-08T12:00:00Z"
    assert poll_state["last_error"] == ""


async def test_linear_delegate_poller_records_error_without_advancing_cursor(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    await store.upsert_runtime_group(
        {
            "id": "binding-1",
            "linear_workspace_id": "workspace-1",
            "project_slug": "ALPHA",
            "linear_agent_app_user_id": "agent-app-1",
            "pipeline_profile": "default",
            "project_binding_id": "binding-1",
        }
    )
    await store.save_linear_poll_state("binding-1", {"binding_id": "binding-1", "cursor": "2026-07-08T10:00:00Z"})

    def failing_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"errors": [{"message": "upstream unavailable"}]})

    poller = LinearDelegatePoller(
        store=store,
        application_id="agent-app-1",
        app_token="app-token",
        transport=failing_transport,
    )

    result = await poller.poll_once()
    poll_state = await store.get_linear_poll_state("binding-1")

    assert result["queued"] == 0
    assert result["errors"] == 1
    assert poll_state is not None
    assert poll_state["cursor"] == "2026-07-08T10:00:00Z"
    assert "500" in poll_state["last_error"]


async def test_podium_lifespan_starts_delegate_poller_when_application_token_configured(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    await store.create_user("workspace-1", email="workspace@example.com", password_hash="x", created_at="2026-01-01T00:00:00Z")
    await store.upsert_conductor(
        {
            "id": "runtime-1",
            "user_id": "workspace-1",
            "runtime_group_id": "group-workspace-1",
            "hostname": "host",
            "label": "Host",
            "version": "1",
            "runtime_token_hash": "runtime-hash",
            "proxy_token_hash": "proxy-hash",
            "disabled": False,
            "revoked": False,
            "created_at": "2026-01-01T00:00:00Z",
            "last_report_at": None,
        }
    )
    await store.upsert_project_binding(
        {
            "id": "runtime-1:inst-1",
            "conductor_id": "runtime-1",
            "user_id": "workspace-1",
            "instance_id": "inst-1",
            "name": "Instance",
            "linear_project": "ALPHA",
            "project_slug": "ALPHA",
            "agent_app_user_id": "agent-app-1",
            "pipeline_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )

    def linear_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-2",
                                "identifier": "ALPHA-2",
                                "title": "Do more work",
                                "description": "Create another file",
                                "updatedAt": "2026-07-08T12:01:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": None,
                                "inverseRelations": {"nodes": []},
                            }
                        ]
                    }
                }
            },
        )

    app = create_app(
        store=store,
        config=PodiumConfig(
            linear_application_id="agent-app-1",
            linear_app_access_token="app-token",
            linear_poll_interval_seconds=1,
            linear_poll_initial_lookback_seconds=60,
        ),
        linear_graphql_transport=linear_transport,
    )

    async with app.router.lifespan_context(app):
        for _ in range(20):
            leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")
            if leased is not None:
                break
            await asyncio.sleep(0.05)

    assert leased is not None
    assert leased["issue_id"] == "issue-2"
