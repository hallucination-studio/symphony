from __future__ import annotations

import asyncio
import json

import asyncpg
import pytest

from podium.store import PgStore

async def _seed_dispatch_route(store: PgStore) -> None:
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
            "installation_id": "installation-1",
            "agent_app_user_id": "agent-alpha",
            "state": "ready",
            "updated_at": "2026-07-11T00:00:00Z",
        }
    )


def _dispatch(*, dispatch_id: str, epoch: int, user_id: str = "user-1") -> dict[str, object]:
    return {
        "dispatch_id": dispatch_id,
        "project_binding_id": "binding-1",
        "user_id": user_id,
        "issue_id": "issue-1",
        "issue_identifier": "ALPHA-1",
        "intake_key": f"linear-issue:issue-1:epoch:{epoch}",
        "workspace_id": "user-1",
        "project_slug": "ALPHA",
        "status": "queued",
        "created_at": "2026-07-11T00:00:00Z",
    }

async def test_pg_store_persists_auth_runtime_and_project_binding_across_connections(
    postgres_database_url: str,
) -> None:
    first = await PgStore.connect(postgres_database_url)
    try:
        await first.migrate()
        await first.create_user(
            "user-1",
            email="operator@example.com",
            password_hash="password-hash",
            created_at="2026-07-11T00:00:00Z",
        )
        await first.save_session(
            "session-hash",
            user_id="user-1",
            expires_at="2099-01-01T00:00:00Z",
        )
        await first.save_session(
            "expired-session-hash",
            user_id="user-1",
            expires_at="2020-01-01T00:00:00Z",
        )
        await first.upsert_runtime_group({"id": "group-1"})
        await first.upsert_conductor(
            {
                "id": "runtime-1",
                "user_id": "user-1",
                "runtime_group_id": "group-1",
                "runtime_token_hash": "runtime-token-hash",
                "proxy_token_hash": "proxy-token-hash",
                "created_at": "2026-07-11T00:00:00Z",
            }
        )
        binding = {
            "id": "binding-1",
            "conductor_id": "runtime-1",
            "user_id": "user-1",
            "instance_id": "instance-old",
            "linear_project_id": "project-1",
            "project_slug": "ALPHA",
            "state": "ready",
            "updated_at": "2026-07-11T00:00:00Z",
        }
        await first.upsert_project_binding(binding)
        await first.upsert_project_binding(
            {
                **binding,
                "instance_id": "instance-new",
                "replacement_conductor_id": "runtime-new",
                "replacement_repo_source": {"type": "local_path", "value": "/repo/new"},
                "replacement_state": "pending_ack",
                "replacement_binding_id": "binding-new",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )
        await first.save_onboarding_state(
            "user-1",
            ["repository_mapping"],
            {"repository": {"mode": "local_path", "value": "/srv/repo"}},
        )
        await first.save_enrollment_token(
            "enrollment-token-hash",
            runtime_group_id="group-1",
            conductor_id="runtime-1",
            expires_at="2099-01-01T00:00:00Z",
        )
    finally:
        await first.close()

    restarted = await PgStore.connect(postgres_database_url)
    try:
        await restarted.migrate()
        user = await restarted.get_user_by_email("operator@example.com")
        session = await restarted.get_session("session-hash")
        expired_session = await restarted.get_session("expired-session-hash")
        runtime = await restarted.get_runtime_by_token_hash("runtime-token-hash")
        proxy_runtime = await restarted.get_runtime_by_token_hash("proxy-token-hash", proxy=True)
        project_binding = await restarted.get_project_binding("binding-1")
        onboarding_state = await restarted.get_onboarding_state("user-1")
        enrollment, enrollment_error = await restarted.consume_enrollment_token(
            "enrollment-token-hash"
        )
        repeated_enrollment = await restarted.consume_enrollment_token(
            "enrollment-token-hash"
        )
        await restarted.revoke_session("session-hash")
        await restarted.save_session(
            "session-hash",
            user_id="user-1",
            expires_at="2099-01-01T00:00:00Z",
        )
        revoked_session = await restarted.get_session("session-hash")
    finally:
        await restarted.close()

    assert user is not None
    assert (user["id"], user["password_hash"]) == ("user-1", "password-hash")
    assert session == {
        "user_id": "user-1",
        "expires_at": "2099-01-01T00:00:00+00:00",
        "revoked": False,
    }
    assert expired_session is None
    assert runtime is not None and runtime["id"] == "runtime-1"
    assert proxy_runtime is not None and proxy_runtime["id"] == "runtime-1"
    assert project_binding is not None
    assert {
        key: project_binding[key]
        for key in (
            "instance_id",
            "replacement_conductor_id",
            "replacement_repo_source",
            "replacement_state",
            "replacement_binding_id",
        )
    } == {
        "instance_id": "instance-new",
        "replacement_conductor_id": "runtime-new",
        "replacement_repo_source": {"type": "local_path", "value": "/repo/new"},
        "replacement_state": "pending_ack",
        "replacement_binding_id": "binding-new",
    }
    assert onboarding_state is not None
    assert onboarding_state["completed_steps"] == ["repository_mapping"]
    assert onboarding_state["metadata"] == {
        "repository": {"mode": "local_path", "value": "/srv/repo"}
    }
    assert onboarding_state["updated_at"]
    assert enrollment is not None
    assert enrollment["runtime_group_id"] == "group-1"
    assert enrollment["conductor_id"] == "runtime-1"
    assert enrollment_error is None
    assert repeated_enrollment == (None, "enrollment_token_used")
    assert revoked_session == {
        "user_id": "user-1",
        "expires_at": "2099-01-01T00:00:00+00:00",
        "revoked": True,
    }


async def test_pg_enrollment_token_claim_is_atomic_across_connections(
    postgres_database_url: str,
) -> None:
    first = await PgStore.connect(postgres_database_url)
    second = await PgStore.connect(postgres_database_url)
    try:
        await first.migrate()
        await _seed_dispatch_route(first)
        await first.save_enrollment_token(
            "concurrent-enrollment-token",
            runtime_group_id="group-1",
            conductor_id="runtime-1",
            expires_at="2099-01-01T00:00:00Z",
        )
        await first.pool.execute(
            """
            CREATE FUNCTION delay_enrollment_claim() RETURNS trigger AS $$
            BEGIN
              PERFORM pg_sleep(0.2);
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
            """
        )
        await first.pool.execute(
            """
            CREATE TRIGGER delay_enrollment_claim_update
            BEFORE UPDATE ON enrollment_tokens
            FOR EACH ROW EXECUTE FUNCTION delay_enrollment_claim()
            """
        )

        results = await asyncio.gather(
            first.consume_enrollment_token("concurrent-enrollment-token"),
            second.consume_enrollment_token("concurrent-enrollment-token"),
        )
    finally:
        await first.close()
        await second.close()

    successes = [row for row, error in results if row is not None and error is None]
    errors = [error for row, error in results if row is None]
    assert len(successes) == 1
    assert errors == ["enrollment_token_used"]


async def test_pg_runtime_commands_are_durable_and_deduplicated(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_dispatch_route(writer)

        first = await writer.append_runtime_command_once(
            "runtime-1", "smoke:one", {"type": "smoke.check"}
        )
        repeated = await reader.append_runtime_command_once(
            "runtime-1", "smoke:one", {"type": "different"}
        )
        second = await writer.append_runtime_command_once(
            "runtime-1", "smoke:two", {"type": "smoke.check"}
        )
        loaded_first = await reader.next_runtime_command("runtime-1")
        loaded_second = await reader.next_runtime_command(
            "runtime-1", after_id=int(first["id"])
        )
    finally:
        await writer.close()
        await reader.close()

    assert repeated == first
    assert repeated["command"] == {"type": "smoke.check"}
    assert int(second["id"]) > int(first["id"])
    assert loaded_first == first
    assert loaded_second == second


async def test_pg_runtime_ops_are_durable_and_revision_fenced(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_dispatch_route(writer)

        created = await writer.compare_and_save_smoke_result(
            "user-1", 0, {"revision": 1, "status": "running"}
        )
        stale = await reader.compare_and_save_smoke_result(
            "user-1", 0, {"revision": 1, "status": "failed"}
        )
        updated = await reader.compare_and_save_smoke_result(
            "user-1", 1, {"revision": 2, "status": "passed"}
        )
        await writer.set_presence(
            "runtime-1",
            timestamp="2026-07-11T01:00:00Z",
            expires_at="2099-01-01T00:00:00Z",
        )
        log_result = {"request_id": "request-1", "lines": ["started", "finished"]}
        await writer.save_log_fetch_result("request-1", log_result)

        smoke = await reader.get_smoke_result("user-1")
        presence = await reader.get_presence("runtime-1")
        loaded_log = await reader.get_log_fetch_result("request-1")
    finally:
        await writer.close()
        await reader.close()

    assert (created, stale, updated) == (True, False, True)
    assert smoke == {"revision": 2, "status": "passed"}
    assert presence is not None
    assert presence["last_seen_at"] == "2026-07-11T01:00:00+00:00"
    assert loaded_log == log_result


async def test_pg_linear_installation_state_is_atomic_and_durable(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    application = {
        "id": "application-1",
        "user_id": "user-1",
        "source": "default",
        "version": 7,
        "client_id": "linear-client",
        "client_secret_enc": "encrypted-client-secret",
        "callback_url": "https://podium.test/api/v1/linear/oauth/callback",
        "created_at": "2026-07-11T00:00:00Z",
    }
    installation = {
        "id": "installation-1",
        "user_id": "user-1",
        "application_config_id": "application-1",
        "application_config_version": 7,
        "application_source": "default",
        "state": "accepted",
        "active": False,
        "access_token_enc": "encrypted-access-token",
        "refresh_token_enc": "encrypted-refresh-token",
        "token_type": "Bearer",
        "actor": "app",
        "scope": ["app:assignable", "read", "write"],
        "expires_at": "2099-01-01T00:00:00Z",
        "linear_organization_id": "organization-1",
        "organization_url_key": "acme",
        "organization_name": "Acme",
        "app_user_id": "linear-app-user-1",
        "projects": [
            {"id": "project-1", "name": "Alpha", "slug_id": "alpha"},
            {"id": "project-2", "name": "Beta", "slug_id": "beta"},
        ],
        "created_at": "2026-07-11T00:00:00Z",
        "updated_at": "2026-07-11T00:00:00Z",
    }
    try:
        await writer.migrate()
        await writer.create_user(
            "user-1",
            email="operator@example.com",
            password_hash="password-hash",
            created_at="2026-07-11T00:00:00Z",
        )
        await writer.save_linear_application_config(application)
        await writer.set_linear_application_preference("user-1", "application-1")
        await writer.save_oauth_state(
            "hashed-oauth-state",
            {
                "workspace_id": "user-1",
                "application_config_id": "application-1",
                "application_config_version": 7,
                "code_verifier_enc": "encrypted-verifier",
                "expires_at": "2099-01-01T00:00:00Z",
            },
        )
        oauth_results = await asyncio.gather(
            writer.consume_oauth_state("hashed-oauth-state"),
            reader.consume_oauth_state("hashed-oauth-state"),
        )

        await writer.save_workspace_installation(installation)
        await writer.activate_workspace_installation("user-1", "installation-1")
        await writer.save_workspace_installation(
            {
                **installation,
                "id": "installation-candidate",
                "state": "failed",
                "active": False,
                "access_token_enc": "",
                "refresh_token_enc": "",
                "error_code": "linear_scope_missing",
                "sanitized_reason": "Linear OAuth scopes are missing",
                "action_required": "reauthorize",
                "next_action": "reauthorize",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )
        await writer.replace_selected_linear_projects(
            "user-1",
            [
                {
                    "user_id": "user-1",
                    "linear_organization_id": "organization-1",
                    "linear_project_id": "project-2",
                    "project_slug": "beta",
                    "project_name": "Beta",
                    "access_state": "ready",
                },
                {
                    "user_id": "user-1",
                    "linear_organization_id": "organization-1",
                    "linear_project_id": "project-1",
                    "project_slug": "alpha",
                    "project_name": "Alpha",
                    "access_state": "ready",
                },
            ],
        )
        reconciled = await reader.update_workspace_installation_reconciliation(
            "user-1",
            "installation-1",
            {
                "reconciliation_state": "healthy",
                "last_reconciliation_at": "2026-07-11T02:00:00Z",
                "reconciliation_error_code": "",
                "reconciliation_error": "",
                "reconciliation_retry_count": 0,
                "reconciliation_next_retry_at": None,
                "updated_at": "2026-07-11T02:00:00Z",
            },
        )
        assert reconciled is not None
        degraded = await writer.update_workspace_installation_reconciliation(
            "user-1",
            "installation-1",
            {
                "expected_updated_at": reconciled["updated_at"],
                "reconciliation_state": "degraded",
                "last_reconciliation_at": reconciled["last_reconciliation_at"],
                "reconciliation_error_code": "linear_reconciliation_unavailable",
                "reconciliation_error": "Linear reconciliation is unavailable",
                "reconciliation_retry_count": 1,
                "reconciliation_next_retry_at": "2026-07-11T03:05:00Z",
                "updated_at": "2026-07-11T03:00:00Z",
            },
        )
        stale_success = await reader.update_workspace_installation_reconciliation(
            "user-1",
            "installation-1",
            {
                "expected_updated_at": reconciled["updated_at"],
                "reconciliation_state": "healthy",
                "last_reconciliation_at": "2026-07-11T04:00:00Z",
                "reconciliation_error_code": "",
                "reconciliation_error": "",
                "reconciliation_retry_count": 0,
                "reconciliation_next_retry_at": None,
                "updated_at": "2026-07-11T04:00:00Z",
            },
        )

        preference = await reader.get_linear_application_preference("user-1")
        loaded_application = await reader.get_linear_application_config("application-1")
        active = await reader.get_active_workspace_installation("user-1")
        candidate = await reader.get_candidate_workspace_installation("user-1")
        projects = await reader.list_selected_linear_projects("user-1")
    finally:
        await writer.close()
        await reader.close()

    consumed = [row for row in oauth_results if row is not None]
    assert len(consumed) == 1
    assert consumed[0]["application_config_version"] == 7
    assert preference == "application-1"
    assert loaded_application is not None and loaded_application["client_secret_enc"] == "encrypted-client-secret"
    assert active is not None and active["id"] == "installation-1"
    assert active["access_token_enc"] == "encrypted-access-token"
    assert active["reconciliation_state"] == "degraded"
    assert active["reconciliation_error_code"] == "linear_reconciliation_unavailable"
    assert candidate is not None and candidate["error_code"] == "linear_scope_missing"
    assert reconciled is not None and reconciled["reconciliation_state"] == "healthy"
    assert degraded is not None and degraded["reconciliation_state"] == "degraded"
    assert stale_success is None
    assert reconciled["access_token_enc"] == "encrypted-access-token"
    assert [row["linear_project_id"] for row in projects] == ["project-1", "project-2"]


async def test_pg_polling_page_rolls_back_observation_and_checkpoint_when_dispatch_fails(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await store.migrate()
        await _seed_dispatch_route(store)

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await store.commit_linear_reconciliation_page(
                "binding-1",
                expected_state=None,
                expected_installation_id="installation-1",
                expected_agent_app_user_id="agent-alpha",
                state={
                    "binding_id": "binding-1",
                    "baseline_complete": False,
                    "page_cursor": "cursor-1",
                    "checkpoint_updated_at": "2026-07-11T00:00:00Z",
                },
                observations=[
                    {
                        "binding_id": "binding-1",
                        "issue_id": "issue-1",
                        "issue_identifier": "ALPHA-1",
                        "delegated": True,
                        "delegation_epoch": 1,
                        "last_updated_at": "2026-07-11T00:00:00Z",
                    }
                ],
                dispatches=[_dispatch(dispatch_id="dispatch-invalid", epoch=1, user_id="missing-user")],
            )

        state = await store.get_linear_reconciliation_state("binding-1")
        observation = await store.get_linear_issue_observation("binding-1", "issue-1")
    finally:
        await store.close()

    assert state is None
    assert observation is None


async def test_pg_polling_page_rejects_binding_retired_after_fetch(
    postgres_database_url: str,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await store.migrate()
        await _seed_dispatch_route(store)
        binding = await store.get_project_binding("binding-1")
        assert binding is not None
        await store.upsert_project_binding(
            {
                **binding,
                "active": False,
                "state": "retired",
                "updated_at": "2026-07-11T01:00:00Z",
            }
        )

        committed = await store.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=None,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state={"binding_id": "binding-1", "baseline_complete": True},
            observations=[
                {
                    "binding_id": "binding-1",
                    "issue_id": "issue-stale-route",
                    "issue_identifier": "ALPHA-2",
                    "delegated": True,
                    "delegation_epoch": 1,
                    "last_updated_at": "2026-07-11T01:00:00Z",
                }
            ],
            dispatches=[_dispatch(dispatch_id="dispatch-stale-route", epoch=1)],
        )
        state = await store.get_linear_reconciliation_state("binding-1")
        observation = await store.get_linear_issue_observation(
            "binding-1",
            "issue-stale-route",
        )
        dispatch_count = await store.pool.fetchval(
            "SELECT count(*) FROM dispatches WHERE id = $1",
            "dispatch-stale-route",
        )
    finally:
        await store.close()

    assert committed is None
    assert state is None
    assert observation is None
    assert dispatch_count == 0


async def test_pg_polling_checkpoint_and_delegation_epochs_are_durable_and_idempotent(
    postgres_database_url: str,
) -> None:
    first = await PgStore.connect(postgres_database_url)
    second = await PgStore.connect(postgres_database_url)
    try:
        await first.migrate()
        await _seed_dispatch_route(first)
        delegated = {
            "binding_id": "binding-1",
            "issue_id": "issue-1",
            "issue_identifier": "ALPHA-1",
            "delegated": True,
            "delegation_epoch": 1,
            "last_updated_at": "2026-07-11T00:00:00Z",
        }
        first_state = {
            "binding_id": "binding-1",
            "baseline_complete": True,
            "page_cursor": "",
            "checkpoint_updated_at": "2026-07-11T00:00:00Z",
            "checkpoint_issue_id": "issue-1",
        }
        inserted = await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=None,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=first_state,
            observations=[delegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-1", epoch=1)],
        )
        repeated = await second.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=first_state,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=first_state,
            observations=[delegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-1", epoch=1)],
        )

        undelegated_state = {
            **first_state,
            "checkpoint_updated_at": "2026-07-11T01:00:00Z",
        }
        await second.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=first_state,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=undelegated_state,
            observations=[
                {
                    **delegated,
                    "delegated": False,
                    "last_updated_at": "2026-07-11T01:00:00Z",
                }
            ],
            dispatches=[],
        )
        redelegated = {
            **delegated,
            "delegation_epoch": 2,
            "last_updated_at": "2026-07-11T02:00:00Z",
        }
        final_state = {**first_state, "checkpoint_updated_at": "2026-07-11T02:00:00Z"}
        requeued = await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=undelegated_state,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=final_state,
            observations=[redelegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-2", epoch=2)],
        )
        replayed_redelegation = await second.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=final_state,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=final_state,
            observations=[redelegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-2", epoch=2)],
        )

        checkpoint = await second.get_linear_reconciliation_state("binding-1")
        observation = await second.get_linear_issue_observation("binding-1", "issue-1")
        dispatches = await second.pool.fetch("SELECT id, intake_key FROM dispatches ORDER BY id")
    finally:
        await first.close()
        await second.close()

    assert (inserted, repeated, requeued, replayed_redelegation) == (1, 0, 1, 0)
    assert checkpoint == final_state
    assert observation is not None and observation["delegated"] is True
    assert observation["delegation_epoch"] == 2
    assert [(row["id"], row["intake_key"]) for row in dispatches] == [
        ("dispatch-epoch-1", "linear-issue:issue-1:epoch:1"),
        ("dispatch-epoch-2", "linear-issue:issue-1:epoch:2"),
    ]


async def test_pg_polling_rejects_stale_page_before_it_erases_redelegation(
    postgres_database_url: str,
) -> None:
    first = await PgStore.connect(postgres_database_url)
    second = await PgStore.connect(postgres_database_url)
    try:
        await first.migrate()
        await _seed_dispatch_route(first)
        delegated = {
            "binding_id": "binding-1",
            "issue_id": "issue-1",
            "issue_identifier": "ALPHA-1",
            "delegated": True,
            "delegation_epoch": 1,
            "last_updated_at": "2026-07-11T00:00:00Z",
        }
        baseline = {
            "binding_id": "binding-1",
            "baseline_complete": True,
            "page_cursor": "",
            "checkpoint_updated_at": "2026-07-11T00:00:00Z",
            "checkpoint_issue_id": "issue-1",
        }
        await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=None,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=baseline,
            observations=[delegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-1", epoch=1)],
        )
        undelegated = {
            **delegated,
            "delegated": False,
            "last_updated_at": "2026-07-11T01:00:00Z",
        }
        undelegated_state = {
            **baseline,
            "checkpoint_updated_at": "2026-07-11T01:00:00Z",
        }
        await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=baseline,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=undelegated_state,
            observations=[undelegated],
            dispatches=[],
        )

        # Both workers fetched from the same undelegated snapshot. The newer
        # redelegation commits first; the delayed old page must then lose CAS.
        shared_snapshot = await first.get_linear_reconciliation_state("binding-1")
        assert shared_snapshot == undelegated_state
        redelegated = {
            **delegated,
            "delegation_epoch": 2,
            "last_updated_at": "2026-07-11T02:00:00Z",
        }
        redelegated_state = {
            **baseline,
            "checkpoint_updated_at": "2026-07-11T02:00:00Z",
        }
        committed = await second.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=shared_snapshot,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=redelegated_state,
            observations=[redelegated],
            dispatches=[_dispatch(dispatch_id="dispatch-epoch-2", epoch=2)],
        )
        stale = await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=shared_snapshot,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=undelegated_state,
            observations=[undelegated],
            dispatches=[],
        )

        checkpoint = await first.get_linear_reconciliation_state("binding-1")
        observation = await first.get_linear_issue_observation("binding-1", "issue-1")
        dispatches = await first.pool.fetch("SELECT id, intake_key FROM dispatches ORDER BY id")
    finally:
        await first.close()
        await second.close()

    assert (committed, stale) == (1, None)
    assert checkpoint == redelegated_state
    assert observation is not None
    assert (observation["delegated"], observation["delegation_epoch"]) == (True, 2)
    assert [(row["id"], row["intake_key"]) for row in dispatches] == [
        ("dispatch-epoch-1", "linear-issue:issue-1:epoch:1"),
        ("dispatch-epoch-2", "linear-issue:issue-1:epoch:2"),
    ]


async def test_pg_dispatch_leasing_skips_locked_candidates_and_rejects_stale_fences_after_reap(
    postgres_database_url: str,
) -> None:
    first = await PgStore.connect(postgres_database_url)
    second = await PgStore.connect(postgres_database_url)
    try:
        await first.migrate()
        await _seed_dispatch_route(first)
        reconciliation_state = {"binding_id": "binding-1"}
        queued = await first.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=None,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=reconciliation_state,
            observations=[],
            dispatches=[_dispatch(dispatch_id="dispatch-1", epoch=1)],
        )
        duplicate = await second.commit_linear_reconciliation_page(
            "binding-1",
            expected_state=reconciliation_state,
            expected_installation_id="installation-1",
            expected_agent_app_user_id="agent-alpha",
            state=reconciliation_state,
            observations=[],
            dispatches=[_dispatch(dispatch_id="dispatch-duplicate", epoch=1)],
        )

        async with first.pool.acquire() as connection:
            async with connection.transaction():
                locked_id = await connection.fetchval(
                    "SELECT id FROM dispatches WHERE id = $1 FOR UPDATE",
                    "dispatch-1",
                )
                skipped = await asyncio.wait_for(
                    second.lease_dispatch(
                        "runtime-1",
                        binding_ids=["binding-1"],
                        lease_until="2099-01-01T00:00:00Z",
                    ),
                    timeout=2,
                )

        competing_leases = await asyncio.gather(
            first.lease_dispatch(
                "runtime-1",
                binding_ids=["binding-1"],
                lease_until="2099-01-01T00:00:00Z",
            ),
            second.lease_dispatch(
                "runtime-1",
                binding_ids=["binding-1"],
                lease_until="2099-01-01T00:00:00Z",
            ),
        )
        claimed = [lease for lease in competing_leases if lease is not None]
        assert len(claimed) == 1
        first_lease = claimed[0]

        await second.pool.execute(
            "UPDATE dispatches SET leased_until = now() - interval '1 second' WHERE id = $1",
            "dispatch-1",
        )
        reaped = await first.reap_expired_dispatch_leases()
        reclaimed = await second.lease_dispatch(
            "runtime-1",
            binding_ids=["binding-1"],
            lease_until="2099-01-01T00:00:00Z",
        )
        stale_ack = await first.ack_dispatch(
            "runtime-1",
            "dispatch-1",
            "completed",
            fencing_token=first_lease["fencing_token"],
        )
        assert reclaimed is not None
        state_after_stale_ack = await second.pool.fetchrow(
            "SELECT status, fencing_token, reason, completed_at FROM dispatches WHERE id = $1",
            "dispatch-1",
        )
        assert state_after_stale_ack is not None
        assert dict(state_after_stale_ack) == {
            "status": "leased",
            "fencing_token": 2,
            "reason": "",
            "completed_at": None,
        }
        current_ack = await second.ack_dispatch(
            "runtime-1",
            "dispatch-1",
            "completed",
            fencing_token=reclaimed["fencing_token"],
            reason="completed_by_runtime",
            completed_at="2026-07-11T03:00:00Z",
        )
    finally:
        await first.close()
        await second.close()

    assert queued == 1
    assert duplicate == 0
    assert locked_id == "dispatch-1"
    assert skipped is None
    assert first_lease["fencing_token"] == 1
    assert reaped == 1
    assert reclaimed["fencing_token"] == 2
    assert stale_ack is None
    assert current_ack is not None and current_ack["status"] == "completed"


async def test_pg_proxy_audit_is_persisted_without_runtime_credentials(
    postgres_database_url: str,
) -> None:
    writer = await PgStore.connect(postgres_database_url)
    reader = await PgStore.connect(postgres_database_url)
    try:
        await writer.migrate()
        await _seed_dispatch_route(writer)
        await writer.insert_proxy_audit_event(
            {
                "runtime_id": "runtime-1",
                "workspace_id": "user-1",
                "operation_name": "Viewer",
                "allowed": True,
                "metadata": {
                    "project_binding_id": "binding-1",
                    "linear_project_id": "project-1",
                    "token_source": "installation",
                },
                "timestamp": "2026-07-11T04:00:00Z",
            }
        )

        row = await reader.pool.fetchrow(
            """
            SELECT runtime_id, workspace_id, operation_name, allowed, reason, metadata_json
            FROM proxy_audit_events
            """
        )
    finally:
        await writer.close()
        await reader.close()

    assert row is not None
    metadata = (
        json.loads(row["metadata_json"])
        if isinstance(row["metadata_json"], str)
        else row["metadata_json"]
    )
    audit_record = dict(row) | {"metadata_json": metadata}
    assert audit_record == {
        "runtime_id": "runtime-1",
        "workspace_id": "user-1",
        "operation_name": "Viewer",
        "allowed": True,
        "reason": "",
        "metadata_json": {
            "project_binding_id": "binding-1",
            "linear_project_id": "project-1",
            "token_source": "installation",
        },
    }
    assert "runtime-token-hash" not in json.dumps(audit_record)
    assert "proxy-token-hash" not in json.dumps(audit_record)
