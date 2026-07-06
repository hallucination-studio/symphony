from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
import json
from typing import Any

import asyncpg


class PgMigrator:
    """Handwritten Podium Postgres schema for the Conductor model."""

    def statements(self) -> Iterable[str]:
        return (
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                linear_app_json JSONB
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS linear_installations (
                workspace_id TEXT PRIMARY KEY,
                access_token_enc TEXT NOT NULL,
                scope JSONB,
                expires_at TIMESTAMPTZ
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS conductors (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                hostname TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL DEFAULT '',
                version TEXT NOT NULL DEFAULT '',
                conductor_id TEXT NOT NULL DEFAULT '',
                runtime_token_hash TEXT NOT NULL,
                proxy_token_hash TEXT NOT NULL,
                disabled BOOLEAN NOT NULL DEFAULT FALSE,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL,
                last_report_at TIMESTAMPTZ
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS project_bindings (
                id TEXT PRIMARY KEY,
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                linear_project TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                workflow_profile TEXT NOT NULL DEFAULT 'task',
                process_status TEXT NOT NULL DEFAULT '',
                repo_source JSONB,
                updated_at TIMESTAMPTZ NOT NULL,
                UNIQUE(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS dispatches (
                id TEXT PRIMARY KEY,
                project_binding_id TEXT NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                issue_id TEXT NOT NULL,
                issue_identifier TEXT NOT NULL DEFAULT '',
                workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_session_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                runtime_phase TEXT NOT NULL DEFAULT '',
                leased_conductor_id TEXT REFERENCES conductors(id) ON DELETE SET NULL,
                leased_until TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS metrics_snapshots (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                captured_at TIMESTAMPTZ NOT NULL,
                tokens BIGINT NOT NULL DEFAULT 0,
                runtime_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
                retries INTEGER NOT NULL DEFAULT 0,
                continuations INTEGER NOT NULL DEFAULT 0,
                blocked INTEGER NOT NULL DEFAULT 0,
                failures INTEGER NOT NULL DEFAULT 0,
                queue_depth INTEGER NOT NULL DEFAULT 0,
                running BOOLEAN NOT NULL DEFAULT FALSE,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS instance_log_tails (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                generation TEXT NOT NULL DEFAULT '',
                offset_end BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL,
                lines_json JSONB NOT NULL,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS onboarding_state (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                completed_steps_json JSONB NOT NULL,
                metadata_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS proxy_audit_events (
                id BIGSERIAL PRIMARY KEY,
                runtime_id TEXT,
                workspace_id TEXT NOT NULL DEFAULT '',
                operation_name TEXT,
                allowed BOOLEAN NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL
            )
            """,
        )


class PgStore:
    def __init__(self, pool: asyncpg.Pool[Any] | None = None, *, database_url: str = "") -> None:
        self.pool = pool
        self.database_url = database_url
        self._owns_pool = False
        self._memory_users: dict[str, dict[str, Any]] = {}
        self._memory_linear_installations: dict[str, dict[str, Any]] = {}
        self._memory_onboarding_state: dict[str, dict[str, Any]] = {}

    @classmethod
    async def connect(cls, database_url: str) -> PgStore:
        pool = await asyncpg.create_pool(database_url)
        store = cls(pool, database_url=database_url)
        store._owns_pool = True
        return store

    async def migrate(self, migrator: PgMigrator | None = None) -> None:
        if self.pool is None:
            raise RuntimeError("postgres_pool_unavailable")
        async with self.pool.acquire() as connection:
            for statement in (migrator or PgMigrator()).statements():
                await connection.execute(statement)

    async def close(self) -> None:
        if self._owns_pool and self.pool is not None:
            await self.pool.close()

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        if self.pool is None:
            user = {
                "id": user_id,
                "email": email,
                "password_hash": password_hash,
                "created_at": created_at,
                "linear_app": None,
            }
            self._memory_users[user_id] = user
            return dict(user)
        row = await self.pool.fetchrow(
            """
            INSERT INTO users (id, email, password_hash, created_at)
            VALUES ($1, $2, $3, $4::timestamptz)
            RETURNING id, email, password_hash, created_at, linear_app_json
            """,
            user_id,
            email,
            password_hash,
            _pg_datetime(created_at),
        )
        return _record_to_user(row)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        if self.pool is None:
            user = self._memory_users.get(user_id)
            return dict(user) if user is not None else None
        row = await self.pool.fetchrow(
            "SELECT id, email, password_hash, created_at, linear_app_json FROM users WHERE id = $1",
            user_id,
        )
        return _record_to_user(row) if row is not None else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        if self.pool is None:
            for user in self._memory_users.values():
                if str(user.get("email") or "") == email:
                    return dict(user)
            return None
        row = await self.pool.fetchrow(
            "SELECT id, email, password_hash, created_at, linear_app_json FROM users WHERE email = $1",
            email,
        )
        return _record_to_user(row) if row is not None else None

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        if self.pool is None:
            user = self._memory_users.get(user_id)
            if user is not None:
                user["linear_app"] = linear_app
            return
        await self.pool.execute("UPDATE users SET linear_app_json = $2 WHERE id = $1", user_id, linear_app)

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        if self.pool is None:
            self._memory_linear_installations[workspace_id] = dict(installation)
            return
        await self.pool.execute(
            """
            INSERT INTO linear_installations (workspace_id, access_token_enc, scope, expires_at)
            VALUES ($1, $2, $3, $4::timestamptz)
            ON CONFLICT (workspace_id) DO UPDATE SET
              access_token_enc = EXCLUDED.access_token_enc,
              scope = EXCLUDED.scope,
              expires_at = EXCLUDED.expires_at
            """,
            workspace_id,
            str(installation.get("access_token") or installation.get("access_token_enc") or ""),
            _pg_json(installation.get("scope")),
            _pg_datetime(installation.get("expires_at")),
        )

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        if self.pool is None:
            installation = self._memory_linear_installations.get(workspace_id)
            if installation is None:
                return None
            return {
                "workspace_id": str(installation.get("workspace_id") or workspace_id),
                "access_token": str(installation.get("access_token") or installation.get("access_token_enc") or ""),
                "scope": installation.get("scope"),
                "expires_at": installation.get("expires_at"),
            }
        row = await self.pool.fetchrow(
            "SELECT workspace_id, access_token_enc, scope, expires_at FROM linear_installations WHERE workspace_id = $1",
            workspace_id,
        )
        if row is None:
            return None
        return {
            "workspace_id": str(row["workspace_id"]),
            "access_token": str(row["access_token_enc"]),
            "scope": row["scope"],
            "expires_at": row["expires_at"].isoformat() if row["expires_at"] is not None else None,
        }

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        if self.pool is None:
            raise RuntimeError("postgres_pool_unavailable")
        await self.pool.execute(
            """
            INSERT INTO conductors (
              id, user_id, hostname, label, version, conductor_id,
              runtime_token_hash, proxy_token_hash, disabled, revoked, created_at, last_report_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              hostname = EXCLUDED.hostname,
              label = EXCLUDED.label,
              version = EXCLUDED.version,
              disabled = EXCLUDED.disabled,
              revoked = EXCLUDED.revoked,
              last_report_at = EXCLUDED.last_report_at
            """,
            str(conductor["id"]),
            str(conductor["user_id"]),
            str(conductor.get("hostname") or ""),
            str(conductor.get("label") or ""),
            str(conductor.get("version") or ""),
            str(conductor.get("conductor_id") or conductor["id"]),
            str(conductor.get("runtime_token_hash") or ""),
            str(conductor.get("proxy_token_hash") or ""),
            bool(conductor.get("disabled")),
            bool(conductor.get("revoked")),
            _pg_datetime(conductor.get("created_at")),
            _pg_datetime(conductor.get("last_report_at")),
        )

    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        if self.pool is None:
            raise RuntimeError("postgres_pool_unavailable")
        await self.pool.execute(
            """
            INSERT INTO project_bindings (
              id, conductor_id, user_id, instance_id, name, linear_project,
              project_slug, agent_app_user_id, workflow_profile, process_status,
              repo_source, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              linear_project = EXCLUDED.linear_project,
              project_slug = EXCLUDED.project_slug,
              agent_app_user_id = EXCLUDED.agent_app_user_id,
              workflow_profile = EXCLUDED.workflow_profile,
              process_status = EXCLUDED.process_status,
              repo_source = EXCLUDED.repo_source,
              updated_at = EXCLUDED.updated_at
            """,
            str(binding["id"]),
            str(binding["conductor_id"]),
            str(binding["user_id"]),
            str(binding["instance_id"]),
            str(binding.get("name") or ""),
            str(binding.get("linear_project") or ""),
            str(binding.get("project_slug") or ""),
            str(binding.get("agent_app_user_id") or ""),
            str(binding.get("workflow_profile") or "task"),
            str(binding.get("process_status") or ""),
            _pg_json(binding.get("repo_source") or {}),
            _pg_datetime(binding.get("updated_at")),
        )

    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        if self.pool is None:
            self._memory_onboarding_state[user_id] = {
                "completed_steps": list(completed_steps),
                "metadata": dict(metadata),
            }
            return
        await self.pool.execute(
            """
            INSERT INTO onboarding_state (user_id, completed_steps_json, metadata_json, updated_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (user_id) DO UPDATE SET
              completed_steps_json = EXCLUDED.completed_steps_json,
              metadata_json = EXCLUDED.metadata_json,
              updated_at = EXCLUDED.updated_at
            """,
            user_id,
            _pg_json(completed_steps),
            _pg_json(metadata),
        )

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        if self.pool is None:
            row = self._memory_onboarding_state.get(user_id)
            return dict(row) if row is not None else None
        row = await self.pool.fetchrow(
            "SELECT completed_steps_json, metadata_json, updated_at FROM onboarding_state WHERE user_id = $1",
            user_id,
        )
        if row is None:
            return None
        return {
            "completed_steps": list(row["completed_steps_json"] or []),
            "metadata": dict(row["metadata_json"] or {}),
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else None,
        }

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        if self.pool is None:
            return
        await self.pool.execute(
            """
            INSERT INTO proxy_audit_events (
              runtime_id, workspace_id, operation_name, allowed, reason, metadata_json, created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)
            """,
            event.get("runtime_id"),
            str(event.get("workspace_id") or ""),
            event.get("operation_name"),
            bool(event.get("allowed")),
            str(event.get("reason") or ""),
            _pg_json(event.get("metadata") or {}),
            _pg_datetime(event.get("timestamp") or event.get("created_at") or ""),
        )


def _record_to_user(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "email": str(row["email"]),
        "password_hash": str(row["password_hash"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "linear_app": row["linear_app_json"],
    }


def _pg_datetime(value: Any) -> datetime | None:
    if value in {None, ""}:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    raise TypeError(f"expected datetime-compatible value, got {type(value).__name__}")


def _pg_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True)
