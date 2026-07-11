from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx

from podium.app import create_app
from podium.linear_reconciliation import LinearReconciler
from podium.store import PgStore


async def _seed_routes(store: PgStore) -> None:
    await store.create_user(
        "user-1",
        email="operator@example.com",
        password_hash="password-hash",
        created_at="2026-07-11T00:00:00Z",
    )
    for suffix, project in (("1", "ALPHA"), ("2", "BETA")):
        await store.upsert_runtime_group({"id": f"group-{suffix}"})
        await store.upsert_conductor(
            {
                "id": f"runtime-{suffix}",
                "user_id": "user-1",
                "runtime_group_id": f"group-{suffix}",
                "runtime_token_hash": f"runtime-token-hash-{suffix}",
                "proxy_token_hash": f"proxy-token-hash-{suffix}",
                "created_at": "2026-07-11T00:00:00Z",
            }
        )
        await store.upsert_project_binding(
            {
                "id": f"binding-{suffix}",
                "conductor_id": f"runtime-{suffix}",
                "user_id": "user-1",
                "instance_id": f"instance-{suffix}",
                "linear_project_id": f"project-{suffix}",
                "project_slug": project,
                "installation_id": f"installation-{suffix}",
                "agent_app_user_id": f"agent-{suffix}",
                "state": "ready",
                "updated_at": "2026-07-11T00:00:00Z",
            }
        )


def _dispatch(*, dispatch_id: str, epoch: int, status: str = "queued") -> dict[str, object]:
    return {
        "dispatch_id": dispatch_id,
        "project_binding_id": "binding-1",
        "user_id": "user-1",
        "issue_id": f"issue-{epoch}",
        "issue_identifier": f"ALPHA-{epoch}",
        "intake_key": f"linear-issue:issue-{epoch}:epoch:1",
        "workspace_id": "user-1",
        "project_slug": "ALPHA",
        "status": status,
        "created_at": "2026-07-11T00:00:00Z",
    }


async def _commit_dispatch(store: PgStore, dispatch: dict[str, object]) -> int:
    binding_id = str(dispatch["project_binding_id"])
    binding = await store.get_project_binding(binding_id)
    assert binding is not None
    committed = await store.commit_linear_reconciliation_page(
        binding_id,
        expected_state=await store.get_linear_reconciliation_state(binding_id),
        expected_installation_id=str(binding["installation_id"]),
        expected_agent_app_user_id=str(binding["agent_app_user_id"]),
        state={"binding_id": binding_id},
        observations=[],
        dispatches=[dispatch],
    )
    assert committed is not None
    return committed


async def test_pg_project_replacement_lookups_preserve_workspace_linkage(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_routes(writer)
        binding = await writer.get_project_binding("binding-1")
        assert binding is not None
        await writer.upsert_project_binding(
            {
                **binding,
                "replacement_conductor_id": "runtime-replacement",
                "replacement_repo_source": {"type": "local_path", "value": "/repo/new"},
                "replacement_state": "pending_ack",
                "replacement_binding_id": "binding-replacement",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )

        replacement_by_conductor = await reader.get_project_binding_replacement_for_conductor(
            "user-1",
            "runtime-replacement",
        )
        replacement_by_binding = await reader.get_project_binding_replacement_for_new_binding(
            "binding-replacement"
        )
        cross_workspace_replacement = await reader.get_project_binding_replacement_for_conductor(
            "other-user",
            "runtime-replacement",
        )
    finally:
        await writer.close()
        await reader.close()

    assert replacement_by_conductor is not None
    assert replacement_by_binding is not None
    assert replacement_by_conductor["id"] == "binding-1"
    assert replacement_by_binding["id"] == "binding-1"
    assert replacement_by_binding["replacement_state"] == "pending_ack"
    assert cross_workspace_replacement is None


async def test_pg_open_dispatch_counts_exclude_terminal_states_and_preserve_scope(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_routes(writer)
        for epoch, status in enumerate(
            ("queued", "leased", "completed", "failed", "cancelled", "canceled"),
            start=1,
        ):
            await _commit_dispatch(
                writer,
                _dispatch(
                    dispatch_id=f"dispatch-{status}",
                    epoch=epoch,
                    status=status,
                )
            )
        await _commit_dispatch(
            writer,
            {
                **_dispatch(dispatch_id="dispatch-other-binding", epoch=7),
                "project_binding_id": "binding-2",
                "issue_identifier": "BETA-1",
            }
        )

        user_open = await reader.count_open_dispatches_for_user("user-1")
        first_binding_open = await reader.count_open_dispatches_for_binding("binding-1")
        second_binding_open = await reader.count_open_dispatches_for_binding("binding-2")
    finally:
        await writer.close()
        await reader.close()

    assert (user_open, first_binding_open, second_binding_open) == (3, 2, 1)


async def test_pg_reconciler_routes_only_exact_ready_installation_binding(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await store.migrate()
        await _seed_routes(store)
        binding = await store.get_project_binding("binding-1")
        assert binding is not None
        await store.upsert_project_binding(
            {
                **binding,
                "installation_id": "installation-other",
                "agent_app_user_id": "agent-other",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )

        app = create_app(secure_cookies=False, secret_key="test-secret", store=store)
        installation = {
            "id": "installation-match",
            "user_id": "user-1",
            "linear_organization_id": "organization-1",
            "app_user_id": "agent-match",
        }
        project = {"linear_project_id": "project-1", "project_slug": "ALPHA"}
        app.state.podium.list_active_linear_installations = AsyncMock(return_value=[installation])
        app.state.podium.list_selected_linear_projects = AsyncMock(return_value=[project])
        app.state.podium.linear_access_token = AsyncMock(return_value="workspace-oauth-token")
        app.state.podium.update_linear_reconciliation_health = AsyncMock()
        app.state.podium.notify_reconciled_dispatches = AsyncMock()
        requested = 0

        def transport(_request: httpx.Request) -> httpx.Response:
            nonlocal requested
            requested += 1
            now = datetime.now(timezone.utc)
            return httpx.Response(
                200,
                json={
                    "data": {
                        "issues": {
                            "nodes": [
                                {
                                    "id": "issue-1",
                                    "identifier": "ALPHA-1",
                                    "title": "Route exact installation",
                                    "description": "",
                                    "createdAt": (now - timedelta(seconds=30)).isoformat(),
                                    "updatedAt": (now - timedelta(seconds=10)).isoformat(),
                                    "project": {"id": "project-1", "slugId": "ALPHA"},
                                    "delegate": {"id": "agent-match"},
                                    "parent": None,
                                    "inverseRelations": {"nodes": []},
                                }
                            ],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                },
            )

        reconciler = LinearReconciler(state=app.state.podium, transport=transport)
        mismatched = await reconciler.reconcile_once()

        assert mismatched == {"installations": 1, "bindings": 0, "queued": 0, "errors": 0}
        assert requested == 0

        await store.upsert_project_binding(
            {
                **binding,
                "installation_id": "installation-match",
                "agent_app_user_id": "agent-match",
                "updated_at": "2026-07-11T02:00:00Z",
            }
        )
        matched = await reconciler.reconcile_once()
        dispatches = await store.pool.fetch("SELECT project_binding_id, issue_id FROM dispatches")
    finally:
        await store.close()

    assert matched == {"installations": 1, "bindings": 1, "queued": 1, "errors": 0}
    assert requested == 1
    assert [(row["project_binding_id"], row["issue_id"]) for row in dispatches] == [
        ("binding-1", "issue-1")
    ]
