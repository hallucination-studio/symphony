from __future__ import annotations

import asyncio
import ast
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

import httpx
import fakeredis.aioredis
import pytest
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
    assert "CREATE TABLE IF NOT EXISTS linear_installations" in sql
    assert "CREATE TABLE IF NOT EXISTS conductors" in sql
    assert "CREATE TABLE IF NOT EXISTS project_bindings" in sql
    assert "CREATE TABLE IF NOT EXISTS dispatches" in sql
    assert "CREATE TABLE IF NOT EXISTS metrics_snapshots" in sql
    assert "CREATE TABLE IF NOT EXISTS instance_log_tails" in sql
    assert "CREATE TABLE IF NOT EXISTS onboarding_state" in sql
    assert "CREATE TABLE IF NOT EXISTS proxy_audit_events" in sql
    assert "fencing_token BIGINT NOT NULL DEFAULT 0" in sql
    assert "UNIQUE(project_binding_id, agent_session_id)" in sql
    assert "sessions" not in sql.lower()


def test_pg_store_dispatch_lease_uses_atomic_skip_locked_query() -> None:
    source = Path("packages/podium/src/podium/store/postgres.py").read_text(encoding="utf-8")

    assert "FOR UPDATE SKIP LOCKED" in source
    assert "fencing_token = dispatches.fencing_token + 1" in source


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


class FakePgStore:
    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.linear_installations: dict[str, dict[str, Any]] = {}
        self.created_users: list[str] = []
        self.email_lookups: list[str] = []
        self.id_lookups: list[str] = []
        self.linear_app_updates: list[tuple[str, dict[str, Any] | None]] = []
        self.onboarding_state: dict[str, dict[str, Any]] = {}
        self.conductors: dict[str, dict[str, Any]] = {}
        self.project_bindings: dict[str, dict[str, Any]] = {}
        self.dispatches: dict[str, dict[str, Any]] = {}
        self.proxy_audit_events: list[dict[str, Any]] = []
        self.next_ids: list[str] = ["user_1"]

    async def next_user_id(self) -> str:
        return self.next_ids.pop(0)

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        self.created_users.append(user_id)
        user = {
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
            "linear_app": None,
        }
        self.users[user_id] = user
        return dict(user)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        self.id_lookups.append(user_id)
        user = self.users.get(user_id)
        return dict(user) if user is not None else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        self.email_lookups.append(email)
        for user in self.users.values():
            if user["email"] == email:
                return dict(user)
        return None

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        self.linear_app_updates.append((user_id, linear_app))
        self.users[user_id]["linear_app"] = linear_app

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        self.linear_installations[workspace_id] = dict(installation)

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        installation = self.linear_installations.get(workspace_id)
        return dict(installation) if installation is not None else None

    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        self.onboarding_state[user_id] = {
            "completed_steps": list(completed_steps),
            "metadata": dict(metadata),
        }

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        state = self.onboarding_state.get(user_id)
        return dict(state) if state is not None else None

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        self.conductors[str(conductor["id"])] = dict(conductor)

    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        self.project_bindings[str(binding["id"])] = dict(binding)

    async def get_runtime_by_token_hash(self, token_hash: str, *, proxy: bool = False) -> dict[str, Any] | None:
        field = "proxy_token_hash" if proxy else "runtime_token_hash"
        for conductor in self.conductors.values():
            if str(conductor.get(field) or "") == token_hash:
                return {
                    "id": str(conductor["id"]),
                    "runtime_group_id": f"group_{conductor.get('user_id') or ''}",
                    "user_id": str(conductor.get("user_id") or ""),
                    "runtime_token_hash": str(conductor.get("runtime_token_hash") or ""),
                    "proxy_token_hash": str(conductor.get("proxy_token_hash") or ""),
                    "disabled": bool(conductor.get("disabled")),
                    "revoked": bool(conductor.get("revoked")),
                    "created_at": str(conductor.get("created_at") or ""),
                }
        return None

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        return [
            dict(conductor)
            for conductor in self.conductors.values()
            if str(conductor.get("user_id") or "") == user_id
        ]

    async def upsert_dispatch(self, dispatch: dict[str, Any]) -> bool:
        for existing in self.dispatches.values():
            if (
                existing.get("project_binding_id") == dispatch.get("project_binding_id")
                and existing.get("agent_session_id") == dispatch.get("agent_session_id")
            ):
                return False
        self.dispatches[str(dispatch["dispatch_id"])] = dict(dispatch)
        return True

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        return [
            dict(binding)
            for binding in self.project_bindings.values()
            if str(binding.get("conductor_id") or "") == conductor_id
        ]

    async def list_project_bindings_for_route(
        self,
        *,
        user_id: str,
        project_slug: str,
        agent_app_user_ids: list[str],
    ) -> list[dict[str, Any]]:
        expected_agents = {str(agent_id) for agent_id in agent_app_user_ids if str(agent_id)}
        return [
            dict(binding)
            for binding in self.project_bindings.values()
            if str(binding.get("user_id") or "") == user_id
            and str(binding.get("project_slug") or "") == project_slug
            and (
                not str(binding.get("agent_app_user_id") or "")
                or str(binding.get("agent_app_user_id") or "") in expected_agents
            )
        ]

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        for dispatch in self.dispatches.values():
            if dispatch.get("project_binding_id") not in binding_ids:
                continue
            if dispatch.get("status") not in {"queued", "leased"}:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = conductor_id
            dispatch["leased_until"] = lease_until
            dispatch["fencing_token"] = int(dispatch.get("fencing_token") or 0) + 1
            return dict(dispatch)
        return None

    async def ack_dispatch(
        self,
        conductor_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None,
        reason: str = "",
        runtime_phase: str = "",
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        if fencing_token is None:
            return None
        dispatch = self.dispatches.get(dispatch_id)
        if dispatch is None:
            return None
        if dispatch.get("leased_runtime_id") != conductor_id:
            return None
        if int(dispatch.get("fencing_token") or 0) != fencing_token:
            return None
        dispatch["status"] = status
        dispatch["reason"] = reason
        dispatch["runtime_phase"] = runtime_phase
        dispatch["updated_at"] = "2026-07-06T00:00:00Z"
        if completed_at is not None:
            dispatch["completed_at"] = completed_at
        elif status in {"completed", "failed", "cancelled", "canceled"}:
            dispatch["completed_at"] = dispatch["updated_at"]
        return dict(dispatch)

    async def reap_expired_dispatch_leases(self) -> int:
        reaped = 0
        for dispatch in self.dispatches.values():
            if dispatch.get("status") != "leased":
                continue
            leased_until = str(dispatch.get("leased_until") or "")
            if leased_until and leased_until < "2026-07-06T00:00:00Z":
                dispatch["status"] = "queued"
                dispatch["leased_runtime_id"] = None
                dispatch["leased_until"] = None
                reaped += 1
        return reaped

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        self.proxy_audit_events.append(dict(event))


class FakeRedisStore:
    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}
        self.enrollment_tokens: dict[str, dict[str, Any]] = {}
        self.saved_sessions: list[str] = []
        self.owners: dict[str, str] = {}
        self.command_queues: dict[str, list[dict[str, Any]]] = {}

    async def save_session(self, token_hash: str, *, user_id: str, ttl_seconds: int) -> None:
        self.saved_sessions.append(token_hash)
        self.sessions[token_hash] = {"user_id": user_id, "revoked": False}

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        return self.sessions.get(token_hash)

    async def revoke_session(self, token_hash: str) -> None:
        if token_hash in self.sessions:
            self.sessions[token_hash]["revoked"] = True

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, ttl_seconds: int) -> None:
        self.enrollment_tokens[token_hash] = {"runtime_group_id": runtime_group_id}

    async def consume_enrollment_token(self, token_hash: str) -> dict[str, Any] | None:
        return self.enrollment_tokens.pop(token_hash, None)

    async def has_enrollment_token_for_group(self, runtime_group_id: str) -> bool:
        return any(row.get("runtime_group_id") == runtime_group_id for row in self.enrollment_tokens.values())

    async def set_conductor_owner(self, conductor_id: str, podium_instance_id: str, *, ttl_seconds: int) -> None:
        self.owners[conductor_id] = podium_instance_id

    async def get_conductor_owner(self, conductor_id: str) -> str | None:
        return self.owners.get(conductor_id)

    async def clear_conductor_owner(self, conductor_id: str) -> None:
        self.owners.pop(conductor_id, None)

    async def publish_runtime_command(self, conductor_id: str, command: dict[str, Any]) -> None:
        self.command_queues.setdefault(conductor_id, []).append(dict(command))

    async def subscribe_runtime_commands(self, conductor_id: str) -> Any:
        store = self

        class _PubSub:
            async def get_message(self, *, ignore_subscribe_messages: bool = True, timeout: float = 1.0) -> dict[str, Any] | None:
                queued = store.command_queues.setdefault(conductor_id, [])
                if not queued:
                    return None
                return {"type": "message", "data": json.dumps(queued.pop(0))}

            async def aclose(self) -> None:
                return None

        return _PubSub()


async def test_auth_uses_postgres_for_users_and_redis_for_sessions() -> None:
    pg_store = FakePgStore()
    redis_store = FakeRedisStore()
    app = create_app(
        pg_store=pg_store,
        redis_store=redis_store,
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
    assert pg_store.created_users == ["user_1"]
    assert "user_1" in pg_store.id_lookups
    assert redis_store.saved_sessions
    assert app.state.podium.users == {}


@pytest.mark.asyncio
async def test_pg_register_uses_store_allocated_user_id_without_scanning() -> None:
    pg_store = FakePgStore()
    pg_store.next_ids = ["user_42"]
    app = create_app(
        pg_store=pg_store,
        redis_store=FakeRedisStore(),
        secret_key="test-secret",
        secure_cookies=False,
    )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        register = await client.post(
            "/api/v1/auth/register",
            json={"email": "atomic-user@example.com", "password": "correct-horse"},
        )

    assert register.status_code == 200
    assert register.json()["user"]["id"] == "user_42"
    assert pg_store.created_users == ["user_42"]
    assert "user_1" not in pg_store.id_lookups


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
