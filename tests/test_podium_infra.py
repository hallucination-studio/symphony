from __future__ import annotations

import asyncio
import ast
import inspect
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.config import PodiumConfig
from podium.podium_shared import dispatch_public
from podium.store._postgres_dispatch import PgDispatchMixin, _binding_values
from podium.store.postgres import PgMigrator
from podium.store import PodiumStore

APP_PATH = Path("packages/podium/src/podium/app.py")


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


def test_config_defaults_linear_reconciliation_initial_lookback_to_no_backfill(monkeypatch) -> None:
    monkeypatch.setenv("PODIUM_LINEAR_POLL_INITIAL_LOOKBACK_SECONDS", "86400")
    monkeypatch.delenv("PODIUM_LINEAR_RECONCILIATION_INITIAL_LOOKBACK_SECONDS", raising=False)

    config = PodiumConfig.from_env()

    assert config.linear_reconciliation_initial_lookback_seconds == 0
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
    )

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": False, "site_key": ""}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_public_config_reports_turnstile_disabled_without_secret_key() -> None:
    app = create_app(config=PodiumConfig(turnstile_site_key="site-key"), secure_cookies=False)

    config = app.state.podium.public_config()

    assert config == {"turnstile": {"enabled": False, "site_key": ""}}
    assert TestClient(app).get("/api/v1/config").json() == config


def test_public_config_reports_turnstile_enabled_with_site_and_secret_key() -> None:
    app = create_app(
        config=PodiumConfig(turnstile_site_key="site-key", turnstile_secret_key="secret-key"),
        secure_cookies=False,
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
    assert "UNIQUE(project_binding_id, agent_session_id)" not in sql
    assert "dispatches_binding_session_unique" in sql
    assert "WHERE agent_session_id <> ''" in sql
    assert "dispatches_binding_issue_empty_session_unique" in sql
    assert "WHERE agent_session_id = ''" in sql
    assert "managed_run_profile TEXT NOT NULL DEFAULT 'default'" in sql
    assert "workflow_profile" not in sql
    assert "CREATE TABLE IF NOT EXISTS sessions" in sql
    assert "CREATE TABLE IF NOT EXISTS enrollment_tokens" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_presence" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_configs" in sql
    assert "CREATE TABLE IF NOT EXISTS managed_run_views" in sql
    assert "CREATE TABLE IF NOT EXISTS runtime_commands" in sql


def test_pg_project_binding_upsert_values_match_replacement_schema() -> None:
    values = _binding_values(
        {
            "id": "binding-old",
            "conductor_id": "conductor-old",
            "user_id": "user-1",
            "instance_id": "instance-old",
            "replacement_conductor_id": "conductor-new",
            "replacement_repo_source": {"type": "local_path", "value": "/repo/new"},
            "replacement_state": "pending_ack",
            "replacement_binding_id": "binding-new",
            "updated_at": "2026-07-10T00:00:00Z",
        }
    )
    source = inspect.getsource(PgDispatchMixin.upsert_project_binding)
    placeholders = [int(value) for value in re.findall(r"\$(\d+)", source)]

    assert len(values) == max(placeholders) == 32
    assert "instance_id = EXCLUDED.instance_id" in source
    assert values[25] == "conductor-new"
    assert json.loads(values[26]) == {"type": "local_path", "value": "/repo/new"}
    assert values[27:29] == ("pending_ack", "binding-new")


def test_pg_store_dispatch_lease_uses_atomic_skip_locked_query() -> None:
    source = Path("packages/podium/src/podium/store/postgres.py").read_text(encoding="utf-8")

    assert "FOR UPDATE SKIP LOCKED" in source
    assert "fencing_token = dispatches.fencing_token + 1" in source


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


async def test_json_store_persists_session_and_does_not_revive_revoked_token(tmp_path) -> None:
    store = PodiumStore(tmp_path)

    await store.save_session("token-hash", user_id="user_1", expires_at="2099-01-01T00:00:00Z")
    await store.revoke_session("token-hash")
    await store.save_session("token-hash", user_id="user_1", expires_at="2099-01-01T00:00:00Z")

    assert await store.get_session("token-hash") == {
        "user_id": "user_1",
        "expires_at": "2099-01-01T00:00:00Z",
        "revoked": True,
    }


async def test_json_store_consumes_enrollment_token_once(tmp_path) -> None:
    store = PodiumStore(tmp_path)
    await store.upsert_runtime_group({"id": "group_1", "linear_workspace_id": "user_1"})
    await store.save_enrollment_token(
        "token-hash",
        runtime_group_id="group_1",
        conductor_id="conductor_1",
        expires_at="2099-01-01T00:00:00Z",
    )

    consumed = (await store.consume_enrollment_token("token-hash"))[0]
    assert consumed["runtime_group_id"] == "group_1"
    assert consumed["conductor_id"] == "conductor_1"
    assert await store.consume_enrollment_token("token-hash") == (None, "enrollment_token_used")


async def test_onboarding_enrollment_token_reserves_conductor_for_authenticated_user(tmp_path) -> None:
    store = PodiumStore(tmp_path)
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        registered = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "runtime-owner@example.com",
                "password": "correct-horse",
                "turnstile_token": "turnstile-ok",
            },
        )
        created = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "Mahler"},
        )

    user_id = registered.json()["user"]["id"]
    assert created.status_code == 200
    conductor = await store.get_runtime(created.json()["conductor"]["id"])
    assert conductor["user_id"] == user_id
    assert conductor["name"] == "Mahler"


async def test_runtime_enrollment_token_rejects_legacy_managed_run_profile_field(tmp_path) -> None:
    store = PodiumStore(tmp_path)
    app = create_app(
        store=store,
        secret_key="test-secret",
        secure_cookies=False,
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        await client.post(
            "/api/v1/auth/register",
            json={
                "email": "legacy-profile@example.com",
                "password": "correct-horse",
                "turnstile_token": "turnstile-ok",
            },
        )
        response = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"managed_run_profile": "gated-task"},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "legacy_runtime_profile_field"


async def test_json_store_persists_presence_and_log_fetch_result(tmp_path) -> None:
    store = PodiumStore(tmp_path)
    result = {"request_id": "req_1", "lines": ["a", "b"]}

    await store.set_presence("conductor_1", timestamp="2026-01-01T00:00:00Z", expires_at="2099-01-01T00:00:00Z")
    await store.save_log_fetch_result("req_1", result)

    assert (await store.get_presence("conductor_1"))["last_seen_at"] == "2026-01-01T00:00:00Z"
    assert await store.get_log_fetch_result("req_1") == result


def test_create_app_exposes_injected_infra() -> None:
    store = object()
    config = PodiumConfig(database_url="postgresql://db")

    app = create_app(store=store, config=config)

    assert app.state.podium.store is store
    assert app.state.podium.config is config


async def test_auth_uses_injected_state_store_for_users_and_sessions(tmp_path) -> None:
    store = PodiumStore(tmp_path)
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
    assert await store.get_user("user_1") is not None
    assert store._load_map("sessions.json")


@pytest.mark.asyncio
async def test_register_uses_store_allocated_user_id(tmp_path) -> None:
    store = PodiumStore(tmp_path)
    await store.create_user("user_1", email="existing@example.com", password_hash="x", created_at="2026-01-01T00:00:00Z")
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
    class ReapingState:
        def __init__(self) -> None:
            self.calls = 0

        async def reap_expired_dispatch_leases(self) -> int:
            self.calls += 1
            return 0

    app = create_app(secret_key="test-secret", secure_cookies=False)
    state = ReapingState()
    app.state.podium = state

    async with app.router.lifespan_context(app):
        for _ in range(20):
            if state.calls:
                break
            await asyncio.sleep(0.01)

    assert state.calls >= 1


def test_managed_podium_state_does_not_declare_business_collections() -> None:
    tree = ast.parse(APP_PATH.read_text(encoding="utf-8"))
    state_class = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "ManagedPodiumState"
    )

    offenders: list[str] = []
    for node in state_class.body:
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.annotation, ast.Subscript):
            continue
        name = node.target.id if isinstance(node.target, ast.Name) else "<unknown>"
        annotation = ast.unparse(node.annotation)
        if annotation.startswith(("dict[", "list[")):
            offenders.append(name)

    assert offenders == []


def test_podium_app_no_longer_uses_legacy_onboarding_store() -> None:
    source = APP_PATH.read_text(encoding="utf-8")

    assert "from .onboarding import OnboardingStore" not in source
    assert "app.state.onboarding" not in source
