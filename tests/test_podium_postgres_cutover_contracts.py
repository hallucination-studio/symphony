from __future__ import annotations

from podium.store import PgStore


async def _seed_cutover(store: PgStore) -> None:
    await store.create_user(
        "user-1",
        email="operator@example.com",
        password_hash="password-hash",
        created_at="2026-07-11T00:00:00Z",
    )
    await store.upsert_runtime_group({"id": "group-1"})
    await store.upsert_conductor(
        {
            "id": "runtime-1",
            "user_id": "user-1",
            "runtime_group_id": "group-1",
            "runtime_token_hash": "runtime-token-hash",
            "proxy_token_hash": "proxy-token-hash",
            "created_at": "2026-07-11T00:00:00Z",
        }
    )
    await store.upsert_project_binding(
        {
            "id": "binding-1",
            "conductor_id": "runtime-1",
            "user_id": "user-1",
            "instance_id": "instance-1",
            "linear_project_id": "project-1",
            "project_slug": "ALPHA",
            "agent_app_user_id": "agent-old",
            "installation_id": "installation-active",
            "state": "ready",
            "config_version": 3,
            "acknowledged_config_version": 3,
            "candidate_installation_id": "installation-candidate",
            "candidate_agent_app_user_id": "agent-new",
            "candidate_config_version": 4,
            "candidate_acknowledged_config_version": 4,
            "updated_at": "2026-07-11T01:00:00Z",
        }
    )
    await store.save_linear_application_config(
        {
            "id": "application-1",
            "user_id": "user-1",
            "source": "default",
            "version": 1,
            "client_id": "linear-client",
            "client_secret_enc": "encrypted-client-secret",
            "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
            "created_at": "2026-07-11T00:00:00Z",
        }
    )
    installation = {
        "user_id": "user-1",
        "application_config_id": "application-1",
        "application_config_version": 1,
        "application_source": "default",
        "access_token_enc": "encrypted-access-token",
        "refresh_token_enc": "encrypted-refresh-token",
        "token_type": "Bearer",
        "actor": "app",
        "scope": ["read", "write"],
        "linear_organization_id": "organization-1",
        "created_at": "2026-07-11T00:00:00Z",
        "updated_at": "2026-07-11T00:00:00Z",
    }
    await store.save_workspace_installation(
        {
            **installation,
            "id": "installation-active",
            "state": "ready",
            "active": True,
            "app_user_id": "agent-old",
        }
    )
    await store.save_workspace_installation(
        {
            **installation,
            "id": "installation-candidate",
            "state": "preparing",
            "active": False,
            "app_user_id": "agent-new",
            "action_required": "wait_for_conductors",
            "next_action": "wait_for_conductors",
            "updated_at": "2026-07-11T01:00:00Z",
        }
    )


async def test_pg_installation_cutover_switches_installation_and_active_binding(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_cutover(writer)

        await writer.switch_workspace_installation(
            "user-1",
            "installation-candidate",
            "agent-new",
        )

        installations = {
            row["id"]: row for row in await reader.list_workspace_installations("user-1")
        }
        switched_binding = await reader.get_project_binding("binding-1")
    finally:
        await writer.close()
        await reader.close()

    retired = installations["installation-active"]
    candidate = installations["installation-candidate"]
    assert (retired["active"], retired["state"]) == (False, "retired")
    assert (
        candidate["active"],
        candidate["state"],
        candidate["action_required"],
        candidate["next_action"],
    ) == (True, "ready", "", "")
    assert switched_binding is not None
    assert {
        key: switched_binding[key]
        for key in (
            "installation_id",
            "agent_app_user_id",
            "config_version",
            "state",
            "candidate_installation_id",
            "candidate_agent_app_user_id",
            "candidate_config_version",
            "candidate_acknowledged_config_version",
        )
    } == {
        "installation_id": "installation-candidate",
        "agent_app_user_id": "agent-new",
        "config_version": 4,
        "state": "switching",
        "candidate_installation_id": "",
        "candidate_agent_app_user_id": "",
        "candidate_config_version": 0,
        "candidate_acknowledged_config_version": 0,
    }


async def test_pg_installation_token_lock_is_scoped_and_released_across_connections(
    postgres_database_url: str,
) -> None:
    holder = await PgStore.connect(postgres_database_url)
    contender = await PgStore.connect(postgres_database_url)
    try:
        async with holder.linear_installation_token_lock("installation-1"):
            async with contender.pool.acquire() as probe:
                same_installation_available = await probe.fetchval(
                    "SELECT pg_try_advisory_lock(hashtext($1))",
                    "installation-1",
                )
                other_installation_available = await probe.fetchval(
                    "SELECT pg_try_advisory_lock(hashtext($1))",
                    "installation-2",
                )
                if other_installation_available:
                    await probe.execute(
                        "SELECT pg_advisory_unlock(hashtext($1))",
                        "installation-2",
                    )

        async with contender.pool.acquire() as probe:
            released_installation_available = await probe.fetchval(
                "SELECT pg_try_advisory_lock(hashtext($1))",
                "installation-1",
            )
            if released_installation_available:
                await probe.execute(
                    "SELECT pg_advisory_unlock(hashtext($1))",
                    "installation-1",
                )
    finally:
        await holder.close()
        await contender.close()

    assert same_installation_available is False
    assert other_installation_available is True
    assert released_installation_available is True
