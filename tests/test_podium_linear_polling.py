from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx
import podium.linear_polling as linear_polling

from podium.app import create_app
from podium.config import PodiumConfig
from podium.linear_polling import LinearDelegatePoller
from podium.linear_polling import DELEGATED_ISSUES_QUERY
from podium.store import PodiumStore


def test_delegated_issues_query_uses_linear_id_type_for_delegate() -> None:
    assert "$delegateId: ID!" in DELEGATED_ISSUES_QUERY


def test_delegated_issues_query_uses_linear_datetime_or_duration_for_updated_after() -> None:
    assert "$updatedAfter: DateTimeOrDuration" in DELEGATED_ISSUES_QUERY


def test_delegated_issues_query_orders_by_updated_at() -> None:
    assert "orderBy: updatedAt" in DELEGATED_ISSUES_QUERY


def test_delegated_issues_query_reads_created_at_for_initial_no_backfill_filter() -> None:
    assert "createdAt" in DELEGATED_ISSUES_QUERY


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
            "managed_run_profile": "default",
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
    assert poll_state["cursor"] >= "2026-07-08T12:00:00Z"
    assert poll_state["last_error"] == ""


async def test_linear_delegate_poller_leases_newest_issue_before_backfilled_older_issue(tmp_path) -> None:
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
            "managed_run_profile": "default",
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
                                "id": "old-issue",
                                "identifier": "ALPHA-1",
                                "title": "Older delegated work",
                                "description": "",
                                "updatedAt": "2026-07-08T12:00:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": None,
                                "inverseRelations": {"nodes": []},
                            },
                            {
                                "id": "new-issue",
                                "identifier": "ALPHA-2",
                                "title": "Current delegated work",
                                "description": "",
                                "updatedAt": "2026-07-08T12:05:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": None,
                                "inverseRelations": {"nodes": []},
                            },
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

    result = await poller.poll_once()
    first_lease = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 2
    assert first_lease is not None
    assert first_lease["issue_id"] == "new-issue"


async def test_linear_delegate_poller_persists_initial_cursor_when_no_issues(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    await store.upsert_runtime_group(
        {
            "id": "binding-1",
            "linear_workspace_id": "workspace-1",
            "project_slug": "ALPHA",
            "linear_agent_app_user_id": "agent-app-1",
            "managed_run_profile": "default",
            "project_binding_id": "binding-1",
        }
    )
    requested_cursors: list[str] = []

    def empty_transport(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        requested_cursors.append(body["variables"]["updatedAfter"])
        return httpx.Response(200, json={"data": {"issues": {"nodes": []}}})

    poller = LinearDelegatePoller(
        store=store,
        application_id="agent-app-1",
        app_token="app-token",
        transport=empty_transport,
        initial_lookback_seconds=0,
    )

    first = await poller.poll_once()
    second = await poller.poll_once()
    poll_state = await store.get_linear_poll_state("binding-1")

    assert first["queued"] == 0
    assert second["queued"] == 0
    assert poll_state is not None
    assert poll_state["cursor"]
    assert requested_cursors[1] == poll_state["cursor"]


async def test_linear_delegate_poller_cold_start_catches_recently_delegated_issue(tmp_path, monkeypatch) -> None:
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
            "managed_run_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-07-08T12:00:30Z",
        }
    )

    class FrozenDatetime:
        @classmethod
        def now(cls, tz: timezone | None = None) -> datetime:
            return datetime(2026, 7, 8, 12, 0, 30, tzinfo=tz)

    monkeypatch.setattr(linear_polling, "datetime", FrozenDatetime)

    def recently_delegated_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-created-before-binding",
                                "identifier": "ALPHA-30",
                                "title": "Delegated just before runtime binding",
                                "description": "",
                                "createdAt": "2026-07-08T12:00:00Z",
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
        transport=recently_delegated_transport,
        initial_lookback_seconds=0,
    )

    result = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 1
    assert leased is not None
    assert leased["issue_id"] == "issue-created-before-binding"


async def test_linear_delegate_poller_skips_issue_created_before_initial_cursor(tmp_path) -> None:
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
            "managed_run_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )

    def old_issue_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "old-issue",
                                "identifier": "ALPHA-1",
                                "title": "Old delegated work",
                                "description": "",
                                "createdAt": "2000-01-01T00:00:00Z",
                                "updatedAt": "2099-01-01T00:00:00Z",
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
        transport=old_issue_transport,
        initial_lookback_seconds=0,
    )

    result = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 0
    assert leased is None


async def test_linear_delegate_poller_skips_symphony_projection_issues(tmp_path) -> None:
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
            "managed_run_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )

    def projection_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "projection-issue",
                                "identifier": "ALPHA-2",
                                "title": "Projected child task",
                                "description": "<!-- SYMPHONY WORK ITEM:start -->\nwork item projection\n<!-- SYMPHONY WORK ITEM:end -->",
                                "createdAt": "2099-01-01T00:00:00Z",
                                "updatedAt": "2099-01-01T00:01:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": {"id": "root-issue"},
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
        transport=projection_transport,
        initial_lookback_seconds=0,
    )

    result = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 0
    assert leased is None


async def test_linear_delegate_poller_skips_delegated_child_issues_without_projection_marker(tmp_path) -> None:
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
            "managed_run_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )

    def child_issue_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "child-issue",
                                "identifier": "ALPHA-2",
                                "title": "Create result report",
                                "description": "Objective: Create the report",
                                "createdAt": "2099-01-01T00:00:00Z",
                                "updatedAt": "2099-01-01T00:01:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": {"id": "root-issue", "identifier": "ALPHA-1"},
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
        transport=child_issue_transport,
        initial_lookback_seconds=0,
    )

    result = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 0
    assert leased is None


async def test_linear_delegate_poller_skips_runtime_wait_human_action_issues(tmp_path) -> None:
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
            "managed_run_profile": "default",
            "process_status": "idle",
            "constraint_labels": [],
            "repo_source": {},
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )

    def runtime_wait_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "runtime-wait-issue",
                                "identifier": "ALPHA-3",
                                "title": "[Human Action] Runtime wait: approval_requested",
                                "description": (
                                    "Managed run wait requires operator attention.\n\n"
                                    "```yaml\n"
                                    "symphony_runtime_wait:\n"
                                    "  wait_id: runtime-wait-execute-1-approval_requested\n"
                                    "  node_id: child-1\n"
                                    "  mode: execute\n"
                                    "  attempt_id: execute-1\n"
                                    "  lease_id: child-1-execute-execute-1\n"
                                    "  wait_kind: approval_requested\n"
                                    "  status: waiting\n"
                                    "```"
                                ),
                                "createdAt": "2099-01-01T00:00:00Z",
                                "updatedAt": "2099-01-01T00:01:00Z",
                                "project": {"slugId": "ALPHA"},
                                "delegate": {"id": "agent-app-1"},
                                "parent": {"id": "root-issue"},
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
        transport=runtime_wait_transport,
        initial_lookback_seconds=0,
    )

    result = await poller.poll_once()
    leased = await store.lease_dispatch("runtime-1", binding_ids=["runtime-1:inst-1"], lease_until="2099-01-01T00:00:00Z")

    assert result["queued"] == 0
    assert leased is None


async def test_linear_delegate_poller_records_error_without_advancing_cursor(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    await store.upsert_runtime_group(
        {
            "id": "binding-1",
            "linear_workspace_id": "workspace-1",
            "project_slug": "ALPHA",
            "linear_agent_app_user_id": "agent-app-1",
            "managed_run_profile": "default",
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
            "managed_run_profile": "default",
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
