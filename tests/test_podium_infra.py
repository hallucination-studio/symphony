from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.cli import secure_cookies_from_env
from podium.config import PodiumConfig
from podium.podium_shared import dispatch_public
from podium.store.postgres import PgMigrator


def test_cli_cookies_are_secure_by_default_and_require_explicit_local_override(monkeypatch) -> None:
    monkeypatch.delenv("PODIUM_SECURE_COOKIES", raising=False)
    assert secure_cookies_from_env() is True

    monkeypatch.setenv("PODIUM_SECURE_COOKIES", "0")
    assert secure_cookies_from_env() is False


def test_config_reads_podium_database_url(monkeypatch) -> None:
    monkeypatch.setenv("PODIUM_DATABASE_URL", "postgresql://podium@localhost/podium")
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SITE_KEY", "  site-key-123  ")

    config = PodiumConfig.from_env()

    assert config.database_url == "postgresql://podium@localhost/podium"
    assert config.turnstile_site_key == "site-key-123"
    assert config.turnstile_secret_key == ""


def test_config_does_not_read_removed_global_linear_actor_env(monkeypatch) -> None:
    monkeypatch.setenv("PODIUM_LINEAR_APPLICATION_ID", "removed-app-id")
    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "removed-app-token")
    monkeypatch.delenv("LINEAR_CLIENT_ID", raising=False)

    config = PodiumConfig.from_env()

    assert config.linear_client_id == ""
    assert not hasattr(config, "linear_application_id")
    assert not hasattr(config, "linear_app_access_token")


def test_config_has_no_linear_reconciliation_lookback(monkeypatch) -> None:
    monkeypatch.setenv("PODIUM_LINEAR_RECONCILIATION_INITIAL_LOOKBACK_SECONDS", "86400")

    config = PodiumConfig.from_env()

    assert not hasattr(config, "linear_reconciliation_initial_lookback_seconds")
    assert not hasattr(config, "linear_poll_initial_lookback_seconds")


def test_config_reads_turnstile_disable_flags(monkeypatch) -> None:
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SITE_KEY", "site-key")
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SECRET_KEY", "secret-key")
    monkeypatch.setenv("PODIUM_DISABLE_TURNSTILE", "1")

    config = PodiumConfig.from_env()

    assert config.turnstile_disabled is True


def test_public_config_reports_turnstile_disabled_without_site_key() -> None:
    app = create_app(
        config=PodiumConfig(turnstile_site_key="", turnstile_secret_key="secret-key"),
        secure_cookies=False,
        store=object(),
    )

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": False, "site_key": ""}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_public_config_reports_turnstile_disabled_without_secret_key() -> None:
    app = create_app(
        config=PodiumConfig(turnstile_site_key="site-key"),
        secure_cookies=False,
        store=object(),
    )

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": False, "site_key": ""}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_public_config_reports_turnstile_enabled_with_site_and_secret_key() -> None:
    app = create_app(
        config=PodiumConfig(turnstile_site_key="site-key", turnstile_secret_key="secret-key"),
        secure_cookies=False,
        store=object(),
    )

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": True, "site_key": "site-key"}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_public_config_reports_turnstile_disabled_by_debug_flag() -> None:
    app = create_app(
        config=PodiumConfig(
            turnstile_site_key="site-key",
            turnstile_secret_key="secret-key",
            turnstile_disabled=True,
        ),
        secure_cookies=False,
        store=object(),
    )

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": False, "site_key": ""}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_pg_migrator_exposes_phase_0_schema() -> None:
    sql = "\n".join(PgMigrator().statements())

    assert "CREATE TABLE IF NOT EXISTS users" in sql
    assert "CREATE TABLE IF NOT EXISTS linear_application_configs" in sql
    assert "CREATE TABLE IF NOT EXISTS linear_application_preferences" in sql
    assert "CREATE TABLE IF NOT EXISTS linear_workspace_installations" in sql
    assert "linear_workspace_installations_active_unique" in sql
    assert "application_config_id TEXT NOT NULL" in sql
    assert "application_config_version BIGINT NOT NULL" in sql
    assert "CREATE TABLE IF NOT EXISTS conductors" in sql
    assert "CREATE TABLE IF NOT EXISTS project_bindings" in sql
    assert "replacement_conductor_id TEXT NOT NULL DEFAULT ''" in sql
    assert "replacement_repo_source JSONB NOT NULL DEFAULT '{}'::jsonb" in sql
    assert "replacement_state TEXT NOT NULL DEFAULT ''" in sql
    assert "replacement_binding_id TEXT NOT NULL DEFAULT ''" in sql
    assert "CREATE TABLE IF NOT EXISTS dispatches" in sql
    assert "agent_app_user_id TEXT NOT NULL DEFAULT ''" in sql
    assert "issue_delegate_id TEXT NOT NULL DEFAULT ''" in sql
    assert "CREATE TABLE IF NOT EXISTS metrics_snapshots" in sql
    assert "CREATE TABLE IF NOT EXISTS instance_log_tails" in sql
    assert "CREATE TABLE IF NOT EXISTS onboarding_state" in sql
    assert "CREATE TABLE IF NOT EXISTS proxy_audit_events" in sql
    assert "fencing_token BIGINT NOT NULL DEFAULT 0" in sql
    assert "dispatches_binding_intake_unique" in sql
    assert "DROP COLUMN IF EXISTS agent_session_id" in sql
    assert "managed_run_profile TEXT NOT NULL DEFAULT 'default'" in sql
    assert "workflow_profile" not in sql
    assert "CREATE TABLE IF NOT EXISTS sessions" in sql
    assert "CREATE TABLE IF NOT EXISTS enrollment_tokens" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_presence" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_configs" in sql
    assert "CREATE TABLE IF NOT EXISTS managed_run_views" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_commands" in sql
    assert "runtime_commands_dedupe_unique" in sql
    assert "WHERE dedupe_key <> ''" in sql


def test_dispatch_public_tolerates_pg_ack_record_without_route_fields() -> None:
    payload = dispatch_public(
        {
            "dispatch_id": "dispatch-1",
            "project_binding_id": "runtime-1:inst-1",
            "issue_id": "issue-1",
            "issue_identifier": "ALPHA-1",
            "linear_workspace_id": "workspace-1",
            "project_slug": "ALPHA",
            "status": "completed",
            "fencing_token": 1,
        }
    )

    assert payload["routing_rule_id"] == "runtime-1:inst-1"
    assert payload["managed_run_profile"] == "default"


async def test_onboarding_enrollment_token_reserves_conductor_for_authenticated_user() -> None:
    store = SimpleNamespace(
        list_conductors_for_user=AsyncMock(return_value=[]),
        list_runtime_groups=AsyncMock(return_value=[]),
        list_all_conductors=AsyncMock(return_value=[]),
        upsert_runtime_group=AsyncMock(),
        upsert_conductor=AsyncMock(),
        save_enrollment_token=AsyncMock(),
        list_project_bindings_for_conductor=AsyncMock(return_value=[]),
        get_presence=AsyncMock(return_value=None),
    )
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    )
    app.state.podium.user_for_session = AsyncMock(
        return_value={"id": "user-1", "email": "runtime-owner@example.com"}
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        created = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "Mahler"},
        )

    assert created.status_code == 200
    conductor = store.upsert_conductor.await_args.args[0]
    assert conductor["user_id"] == "user-1"
    assert conductor["name"] == "Mahler"
    store.save_enrollment_token.assert_awaited_once()


async def test_runtime_enrollment_token_rejects_legacy_managed_run_profile_field() -> None:
    store = object()
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    )
    app.state.podium.user_for_session = AsyncMock(
        return_value={"id": "user-1", "email": "legacy-profile@example.com"}
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        response = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"managed_run_profile": "gated-task"},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "legacy_runtime_profile_field"


def test_create_app_exposes_injected_infra() -> None:
    store = object()
    config = PodiumConfig(database_url="postgresql://db")

    app = create_app(store=store, config=config)

    assert app.state.podium.store is store
    assert app.state.podium.config is config


async def test_auth_uses_injected_state_store_for_users_and_sessions() -> None:
    user = {
        "id": "user_1",
        "email": "sql-user@example.com",
        "password_hash": "password-hash",
        "created_at": "2026-01-01T00:00:00Z",
    }
    store = SimpleNamespace(
        next_user_id=AsyncMock(return_value="user_1"),
        get_user_by_email=AsyncMock(return_value=None),
        create_user=AsyncMock(return_value=user),
        save_session=AsyncMock(),
        get_session=AsyncMock(
            return_value={
                "user_id": "user_1",
                "expires_at": "2099-01-01T00:00:00Z",
                "revoked": False,
            }
        ),
        get_user=AsyncMock(return_value=user),
    )
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={"email": "sql-user@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        me = await client.get("/api/v1/auth/me")

    assert register.status_code == 200
    assert me.status_code == 200
    store.create_user.assert_awaited_once()
    store.save_session.assert_awaited_once()
    store.get_session.assert_awaited_once()


@pytest.mark.asyncio
async def test_register_uses_store_allocated_user_id() -> None:
    async def create_user(
        user_id: str, *, email: str, password_hash: str, created_at: str
    ) -> dict[str, str]:
        return {
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
        }

    store = SimpleNamespace(
        next_user_id=AsyncMock(return_value="user_2"),
        get_user_by_email=AsyncMock(return_value=None),
        create_user=AsyncMock(side_effect=create_user),
        save_session=AsyncMock(),
    )
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={"email": "atomic-user@example.com", "password": "correct-horse"},
        )

    assert register.status_code == 200
    assert register.json()["user"]["id"] == "user_2"


@pytest.mark.asyncio
async def test_app_lifespan_runs_dispatch_lease_reaper() -> None:
    class EmptyInstallationStore:
        async def list_active_workspace_installations(self) -> list[dict[str, object]]:
            return []

    class ReapingState:
        def __init__(self) -> None:
            self.calls = 0

        async def reap_expired_dispatch_leases(self) -> int:
            self.calls += 1
            return 0

    app = create_app(
        secret_key="test-secret",
        secure_cookies=False,
        store=EmptyInstallationStore(),
    )
    state = ReapingState()
    app.state.podium = state

    async with app.router.lifespan_context(app):
        for _ in range(20):
            if state.calls:
                break
            await asyncio.sleep(0.01)

    assert state.calls >= 1
