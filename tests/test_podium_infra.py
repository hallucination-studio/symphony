from __future__ import annotations

import ast
from pathlib import Path

import fakeredis.aioredis
from fastapi.testclient import TestClient

from podium.app import create_app
from podium.config import PodiumConfig
from podium.store.postgres import PgMigrator
from podium.store.redis import RedisStore

APP_PATH = Path("packages/podium/src/podium/app.py")


def test_config_reads_podium_database_and_redis_urls(monkeypatch) -> None:
    monkeypatch.setenv("PODIUM_DATABASE_URL", "postgresql://podium@localhost/podium")
    monkeypatch.setenv("PODIUM_REDIS_URL", "redis://localhost:6379/3")
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SITE_KEY", "  site-key-123  ")

    config = PodiumConfig.from_env()

    assert config.database_url == "postgresql://podium@localhost/podium"
    assert config.redis_url == "redis://localhost:6379/3"
    assert config.turnstile_site_key == "site-key-123"
    assert config.turnstile_secret_key == ""


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


def test_pg_migrator_exposes_phase_0_schema() -> None:
    sql = "\n".join(PgMigrator().statements())

    assert "CREATE TABLE IF NOT EXISTS users" in sql
    assert "CREATE TABLE IF NOT EXISTS linear_installations" in sql
    assert "CREATE TABLE IF NOT EXISTS conductors" in sql
    assert "CREATE TABLE IF NOT EXISTS project_bindings" in sql
    assert "CREATE TABLE IF NOT EXISTS dispatches" in sql
    assert "CREATE TABLE IF NOT EXISTS metrics_snapshots" in sql
    assert "CREATE TABLE IF NOT EXISTS instance_log_tails" in sql
    assert "CREATE TABLE IF NOT EXISTS onboarding_state" in sql
    assert "CREATE TABLE IF NOT EXISTS proxy_audit_events" in sql
    assert "sessions" not in sql.lower()


async def test_redis_store_persists_session_with_ttl() -> None:
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    store = RedisStore(client)

    await store.save_session("token-hash", user_id="user_1", ttl_seconds=60)

    assert await store.get_session("token-hash") == {"user_id": "user_1", "revoked": False}
    assert await client.ttl("session:token-hash") > 0


async def test_redis_store_tracks_conductor_owner_with_ttl() -> None:
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    store = RedisStore(client)

    await store.set_conductor_owner("conductor_1", "podium-a", ttl_seconds=30)

    assert await store.get_conductor_owner("conductor_1") == "podium-a"
    assert await client.ttl("conductor:conductor_1:owner") > 0


async def test_redis_store_consumes_enrollment_token_once() -> None:
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    store = RedisStore(client)

    await store.save_enrollment_token("token-hash", runtime_group_id="group_1", ttl_seconds=60)

    assert await store.consume_enrollment_token("token-hash") == {"runtime_group_id": "group_1"}
    assert await store.consume_enrollment_token("token-hash") is None


async def test_redis_store_persists_log_fetch_result_with_ttl() -> None:
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    store = RedisStore(client)
    result = {"request_id": "req_1", "lines": ["a", "b"]}

    await store.save_log_fetch_result("req_1", result, ttl_seconds=60)

    assert await store.get_log_fetch_result("req_1") == result
    assert await client.ttl("fetch:req_1") > 0


def test_create_app_exposes_injected_infra() -> None:
    pg_store = object()
    redis_store = object()
    config = PodiumConfig(database_url="postgresql://db", redis_url="redis://cache")

    app = create_app(pg_store=pg_store, redis_store=redis_store, config=config)

    assert app.state.podium.pg_store is pg_store
    assert app.state.podium.redis_store is redis_store
    assert app.state.podium.config is config


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
