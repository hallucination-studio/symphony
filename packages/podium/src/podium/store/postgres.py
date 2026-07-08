from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
import json
from typing import Any

import asyncpg


class PgMigrator:
    """Handwritten Podium PostgreSQL schema."""

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
            "CREATE SEQUENCE IF NOT EXISTS podium_user_id_seq",
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_groups (
                id TEXT PRIMARY KEY,
                linear_workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                linear_agent_app_user_id TEXT NOT NULL DEFAULT '',
                pipeline_profile TEXT NOT NULL DEFAULT 'default',
                project_binding_id TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS enrollment_tokens (
                token_hash TEXT PRIMARY KEY,
                runtime_group_id TEXT NOT NULL REFERENCES runtime_groups(id) ON DELETE CASCADE,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS linear_installations (
                workspace_id TEXT PRIMARY KEY,
                access_token_enc TEXT NOT NULL,
                scope JSONB,
                actor TEXT NOT NULL DEFAULT '',
                expires_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE linear_installations ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT ''",
            """
            CREATE TABLE IF NOT EXISTS oauth_states (
                state TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
                runtime_group_id TEXT NOT NULL DEFAULT '',
                runtime_token_hash TEXT NOT NULL,
                proxy_token_hash TEXT NOT NULL,
                disabled BOOLEAN NOT NULL DEFAULT FALSE,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL,
                last_report_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS runtime_group_id TEXT NOT NULL DEFAULT ''",
            """
            CREATE TABLE IF NOT EXISTS runtime_presence (
                runtime_id TEXT PRIMARY KEY REFERENCES conductors(id) ON DELETE CASCADE,
                last_seen_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
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
                pipeline_profile TEXT NOT NULL DEFAULT 'default',
                process_status TEXT NOT NULL DEFAULT '',
                constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
                repo_source JSONB,
                updated_at TIMESTAMPTZ NOT NULL,
                UNIQUE(conductor_id, instance_id)
            )
            """,
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb",
            """
            CREATE TABLE IF NOT EXISTS dispatches (
                id TEXT PRIMARY KEY,
                project_binding_id TEXT NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                issue_id TEXT NOT NULL,
                issue_identifier TEXT NOT NULL DEFAULT '',
                issue_title TEXT NOT NULL DEFAULT '',
                issue_description TEXT NOT NULL DEFAULT '',
                pipeline_intent JSONB NOT NULL DEFAULT '{}'::jsonb,
                workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_session_id TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                issue_delegate_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                leased_conductor_id TEXT REFERENCES conductors(id) ON DELETE SET NULL,
                leased_until TIMESTAMPTZ,
                fencing_token BIGINT NOT NULL DEFAULT 0,
                graph_id TEXT NOT NULL DEFAULT '',
                node_id TEXT NOT NULL DEFAULT '',
                attempt_id TEXT NOT NULL DEFAULT '',
                mode TEXT NOT NULL DEFAULT '',
                attempt_status TEXT NOT NULL DEFAULT '',
                graph_revision BIGINT NOT NULL DEFAULT 0,
                policy_revision BIGINT NOT NULL DEFAULT 0,
                lease_id TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_title TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_description TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS pipeline_intent JSONB NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS agent_app_user_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_delegate_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS graph_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS node_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS attempt_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS attempt_status TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS graph_revision BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS policy_revision BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS lease_id TEXT NOT NULL DEFAULT ''",
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_session_unique
            ON dispatches (project_binding_id, agent_session_id)
            WHERE agent_session_id <> ''
            """,
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_issue_empty_session_unique
            ON dispatches (project_binding_id, issue_id)
            WHERE agent_session_id = ''
            """,
            """
            CREATE TABLE IF NOT EXISTS metrics_snapshots (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                captured_at TIMESTAMPTZ NOT NULL,
                metrics_json JSONB NOT NULL,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS instance_log_tails (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                tail_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS log_fetch_results (
                request_id TEXT PRIMARY KEY,
                result_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_configs (
                runtime_group_id TEXT PRIMARY KEY,
                config_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS pipeline_views (
                runtime_group_id TEXT PRIMARY KEY,
                view_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_commands (
                id BIGSERIAL PRIMARY KEY,
                runtime_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                command_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS linear_poll_state (
                binding_id TEXT PRIMARY KEY,
                cursor_text TEXT NOT NULL DEFAULT '',
                last_success_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                last_issue_count BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
            CREATE TABLE IF NOT EXISTS smoke_results (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                result_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    def __init__(self, pool: asyncpg.Pool[Any], *, database_url: str = "") -> None:
        self.pool = pool
        self.database_url = database_url
        self._owns_pool = False

    @classmethod
    async def connect(cls, database_url: str) -> PgStore:
        pool = await asyncpg.create_pool(database_url)
        store = cls(pool, database_url=database_url)
        store._owns_pool = True
        return store

    async def migrate(self, migrator: PgMigrator | None = None) -> None:
        async with self.pool.acquire() as connection:
            for statement in (migrator or PgMigrator()).statements():
                await connection.execute(statement)

    async def close(self) -> None:
        if self._owns_pool:
            await self.pool.close()

    async def next_user_id(self) -> str:
        value = await self.pool.fetchval("SELECT nextval('podium_user_id_seq')")
        return f"user_{int(value)}"

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
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
        row = await self.pool.fetchrow("SELECT id, email, password_hash, created_at, linear_app_json FROM users WHERE id = $1", user_id)
        return _record_to_user(row) if row is not None else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT id, email, password_hash, created_at, linear_app_json FROM users WHERE email = $1", email)
        return _record_to_user(row) if row is not None else None

    async def set_user_linear_app(self, user_id: str, linear_app: dict[str, Any] | None) -> None:
        await self.pool.execute("UPDATE users SET linear_app_json = $2::jsonb WHERE id = $1", user_id, _pg_json(linear_app) if linear_app is not None else None)

    async def save_session(self, token_hash: str, *, user_id: str, expires_at: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO sessions (token_hash, user_id, expires_at, revoked, created_at)
            VALUES ($1, $2, $3::timestamptz, FALSE, now())
            ON CONFLICT (token_hash) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              expires_at = EXCLUDED.expires_at,
              revoked = sessions.revoked
            """,
            token_hash,
            user_id,
            _pg_datetime(expires_at),
        )

    async def get_session(self, token_hash: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT user_id, expires_at, revoked FROM sessions WHERE token_hash = $1 AND expires_at >= now()",
            token_hash,
        )
        if row is None:
            return None
        return {"user_id": str(row["user_id"]), "expires_at": row["expires_at"].isoformat(), "revoked": bool(row["revoked"])}

    async def revoke_session(self, token_hash: str) -> None:
        await self.pool.execute("UPDATE sessions SET revoked = TRUE WHERE token_hash = $1", token_hash)

    async def upsert_runtime_group(self, group: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO runtime_groups (
              id, linear_workspace_id, project_slug, linear_agent_app_user_id, pipeline_profile, project_binding_id, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,now())
            ON CONFLICT (id) DO UPDATE SET
              linear_workspace_id = EXCLUDED.linear_workspace_id,
              project_slug = EXCLUDED.project_slug,
              linear_agent_app_user_id = EXCLUDED.linear_agent_app_user_id,
              pipeline_profile = EXCLUDED.pipeline_profile,
              project_binding_id = EXCLUDED.project_binding_id,
              updated_at = now()
            """,
            str(group["id"]),
            str(group.get("linear_workspace_id") or ""),
            str(group.get("project_slug") or ""),
            str(group.get("linear_agent_app_user_id") or ""),
            str(group.get("pipeline_profile") or "default"),
            str(group.get("project_binding_id") or ""),
        )

    async def get_runtime_group(self, group_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM runtime_groups WHERE id = $1", group_id)
        return _record_to_runtime_group(row) if row is not None else None

    async def list_runtime_groups(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM runtime_groups ORDER BY id")
        return [_record_to_runtime_group(row) for row in rows]

    async def save_enrollment_token(self, token_hash: str, *, runtime_group_id: str, expires_at: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO enrollment_tokens (token_hash, runtime_group_id, used, expires_at, created_at)
            VALUES ($1,$2,FALSE,$3::timestamptz,now())
            ON CONFLICT (token_hash) DO UPDATE SET
              runtime_group_id = EXCLUDED.runtime_group_id,
              used = FALSE,
              expires_at = EXCLUDED.expires_at,
              created_at = now()
            """,
            token_hash,
            runtime_group_id,
            _pg_datetime(expires_at),
        )

    async def consume_enrollment_token(self, token_hash: str) -> tuple[dict[str, Any] | None, str | None]:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow("SELECT runtime_group_id, used, expires_at FROM enrollment_tokens WHERE token_hash = $1 FOR UPDATE", token_hash)
            if row is None:
                return None, "invalid_enrollment_token"
            if bool(row["used"]):
                return None, "enrollment_token_used"
            if row["expires_at"] < datetime.now(row["expires_at"].tzinfo):
                return None, "enrollment_token_expired"
            await connection.execute("UPDATE enrollment_tokens SET used = TRUE WHERE token_hash = $1", token_hash)
        return {"runtime_group_id": str(row["runtime_group_id"]), "used": True, "expires_at": row["expires_at"].isoformat()}, None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        value = await self.pool.fetchval(
            "SELECT EXISTS (SELECT 1 FROM enrollment_tokens WHERE runtime_group_id = $1 AND used = FALSE AND expires_at >= now())",
            runtime_group_id,
        )
        return bool(value)

    async def save_linear_installation(self, workspace_id: str, installation: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO linear_installations (workspace_id, access_token_enc, scope, actor, expires_at)
            VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz)
            ON CONFLICT (workspace_id) DO UPDATE SET
              access_token_enc = EXCLUDED.access_token_enc,
              scope = EXCLUDED.scope,
              actor = EXCLUDED.actor,
              expires_at = EXCLUDED.expires_at
            """,
            workspace_id,
            str(installation.get("access_token") or installation.get("access_token_enc") or ""),
            _pg_json(installation.get("scope")),
            str(installation.get("actor") or ""),
            _pg_datetime(installation.get("expires_at")),
        )

    async def get_linear_installation(self, workspace_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT workspace_id, access_token_enc, scope, actor, expires_at FROM linear_installations WHERE workspace_id = $1", workspace_id)
        if row is None:
            return None
        return {
            "workspace_id": str(row["workspace_id"]),
            "access_token": str(row["access_token_enc"]),
            "scope": _pg_json_value(row["scope"], None),
            "actor": str(row["actor"] or ""),
            "expires_at": row["expires_at"].isoformat() if row["expires_at"] is not None else None,
        }

    async def save_linear_poll_state(self, binding_id: str, state: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO linear_poll_state (
              binding_id, cursor_text, last_success_at, last_error, last_issue_count, updated_at
            )
            VALUES ($1,$2,$3::timestamptz,$4,$5,now())
            ON CONFLICT (binding_id) DO UPDATE SET
              cursor_text = EXCLUDED.cursor_text,
              last_success_at = EXCLUDED.last_success_at,
              last_error = EXCLUDED.last_error,
              last_issue_count = EXCLUDED.last_issue_count,
              updated_at = now()
            """,
            binding_id,
            str(state.get("cursor") or state.get("cursor_text") or ""),
            _pg_datetime(state.get("last_success_at")),
            str(state.get("last_error") or ""),
            int(state.get("last_issue_count") or 0),
        )

    async def get_linear_poll_state(self, binding_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM linear_poll_state WHERE binding_id = $1", binding_id)
        if row is None:
            return None
        return {
            "binding_id": str(row["binding_id"]),
            "cursor": str(row["cursor_text"] or ""),
            "last_success_at": row["last_success_at"].isoformat() if row["last_success_at"] is not None else None,
            "last_error": str(row["last_error"] or ""),
            "last_issue_count": int(row["last_issue_count"] or 0),
        }

    async def save_oauth_state(self, state: str, *, workspace_id: str, expires_at: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO oauth_states (state, workspace_id, expires_at, created_at)
            VALUES ($1,$2,$3::timestamptz,now())
            ON CONFLICT (state) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, expires_at = EXCLUDED.expires_at, created_at = now()
            """,
            state,
            workspace_id,
            _pg_datetime(expires_at),
        )

    async def consume_oauth_state(self, state: str) -> str | None:
        row = await self.pool.fetchrow(
            "DELETE FROM oauth_states WHERE state = $1 AND expires_at >= now() RETURNING workspace_id",
            state,
        )
        return str(row["workspace_id"]) if row is not None else None

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO conductors (
              id, user_id, hostname, label, version, conductor_id, runtime_group_id,
              runtime_token_hash, proxy_token_hash, disabled, revoked, created_at, last_report_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              hostname = EXCLUDED.hostname,
              label = EXCLUDED.label,
              version = EXCLUDED.version,
              runtime_group_id = EXCLUDED.runtime_group_id,
              runtime_token_hash = EXCLUDED.runtime_token_hash,
              proxy_token_hash = EXCLUDED.proxy_token_hash,
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
            str(conductor.get("runtime_group_id") or f"group_{conductor['user_id']}"),
            str(conductor.get("runtime_token_hash") or ""),
            str(conductor.get("proxy_token_hash") or ""),
            bool(conductor.get("disabled")),
            bool(conductor.get("revoked")),
            _pg_datetime(conductor.get("created_at")),
            _pg_datetime(conductor.get("last_report_at")),
        )

    async def get_runtime_by_token_hash(self, token_hash: str, *, proxy: bool = False) -> dict[str, Any] | None:
        column = "proxy_token_hash" if proxy else "runtime_token_hash"
        row = await self.pool.fetchrow(
            f"SELECT id, user_id, runtime_group_id, runtime_token_hash, proxy_token_hash, disabled, revoked, created_at, hostname, label, version FROM conductors WHERE {column} = $1",
            token_hash,
        )
        return _record_to_runtime(row) if row is not None else None

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT id, user_id, runtime_group_id, runtime_token_hash, proxy_token_hash, disabled, revoked, created_at, hostname, label, version FROM conductors WHERE id = $1",
            runtime_id,
        )
        return _record_to_runtime(row) if row is not None else None

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM conductors WHERE user_id = $1 ORDER BY created_at, id", user_id)
        return [_record_to_conductor(row) for row in rows]

    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO project_bindings (
              id, conductor_id, user_id, instance_id, name, linear_project, project_slug,
              agent_app_user_id, pipeline_profile, process_status, constraint_labels, repo_source, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              linear_project = EXCLUDED.linear_project,
              project_slug = EXCLUDED.project_slug,
              agent_app_user_id = EXCLUDED.agent_app_user_id,
              pipeline_profile = EXCLUDED.pipeline_profile,
              process_status = EXCLUDED.process_status,
              constraint_labels = EXCLUDED.constraint_labels,
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
            str(binding.get("pipeline_profile") or "default"),
            str(binding.get("process_status") or ""),
            _pg_json(binding.get("constraint_labels") or []),
            _pg_json(binding.get("repo_source") or {}),
            _pg_datetime(binding.get("updated_at")),
        )
        await self.upsert_runtime_group(
            {
                "id": str(binding["id"]),
                "linear_workspace_id": str(binding["user_id"]),
                "project_slug": str(binding.get("project_slug") or ""),
                "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
                "pipeline_profile": str(binding.get("pipeline_profile") or "default"),
                "project_binding_id": str(binding["id"]),
            }
        )

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM project_bindings WHERE conductor_id = $1 ORDER BY id", conductor_id)
        return [_record_to_project_binding(row) for row in rows]

    async def list_project_bindings_for_route(self, *, user_id: str, project_slug: str, agent_app_user_ids: list[str]) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """
            SELECT * FROM project_bindings
            WHERE user_id = $1
              AND project_slug = $2
              AND (agent_app_user_id = '' OR agent_app_user_id = ANY($3::text[]))
            ORDER BY id
            """,
            user_id,
            project_slug,
            list(agent_app_user_ids),
        )
        return [_record_to_project_binding(row) for row in rows]

    async def upsert_dispatch(self, dispatch: dict[str, Any]) -> bool:
        row = await self.pool.fetchrow(
            """
            INSERT INTO dispatches (
              id, project_binding_id, user_id, issue_id, issue_identifier, issue_title, issue_description,
              pipeline_intent, workspace_id, project_slug, agent_session_id, status, reason,
              agent_app_user_id, issue_delegate_id, leased_conductor_id, leased_until, fencing_token,
              graph_id, node_id, attempt_id, mode, attempt_status, graph_revision, policy_revision, lease_id,
              created_at, updated_at, completed_at
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18,
              $19,$20,$21,$22,$23,$24,$25,$26,$27::timestamptz,$28::timestamptz,$29::timestamptz
            )
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            str(dispatch["dispatch_id"]),
            str(dispatch["project_binding_id"]),
            str(dispatch["user_id"]),
            str(dispatch["issue_id"]),
            str(dispatch.get("issue_identifier") or ""),
            str(dispatch.get("issue_title") or ""),
            str(dispatch.get("issue_description") or ""),
            _pg_json(dispatch.get("pipeline_intent") or {}),
            str(dispatch.get("linear_workspace_id") or dispatch.get("workspace_id") or ""),
            str(dispatch.get("project_slug") or ""),
            str(dispatch.get("agent_session_id") or ""),
            str(dispatch.get("status") or "queued"),
            str(dispatch.get("reason") or ""),
            str(dispatch.get("agent_app_user_id") or ""),
            str(dispatch.get("issue_delegate_id") or ""),
            dispatch.get("leased_runtime_id") or dispatch.get("leased_conductor_id"),
            _pg_datetime(dispatch.get("leased_until")),
            int(dispatch.get("fencing_token") or 0),
            str(dispatch.get("graph_id") or ""),
            str(dispatch.get("node_id") or ""),
            str(dispatch.get("attempt_id") or ""),
            str(dispatch.get("mode") or ""),
            str(dispatch.get("attempt_status") or ""),
            int(dispatch.get("graph_revision") or 0),
            int(dispatch.get("policy_revision") or 0),
            str(dispatch.get("lease_id") or ""),
            _pg_datetime(dispatch.get("created_at")),
            _pg_datetime(dispatch.get("updated_at") or dispatch.get("created_at")),
            _pg_datetime(dispatch.get("completed_at")),
        )
        return row is not None

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                WITH candidate AS (
                  SELECT id
                  FROM dispatches
                  WHERE project_binding_id = ANY($2::text[])
                    AND (status = 'queued' OR (status = 'leased' AND leased_until < now()))
                  ORDER BY created_at ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                UPDATE dispatches
                SET status = 'leased',
                    leased_conductor_id = $1,
                    leased_until = $3::timestamptz,
                    fencing_token = dispatches.fencing_token + 1,
                    updated_at = now()
                FROM candidate
                WHERE dispatches.id = candidate.id
                RETURNING dispatches.*
                """,
                conductor_id,
                list(binding_ids),
                _pg_datetime(lease_until),
            )
        return _record_to_dispatch(row) if row is not None else None

    async def ack_dispatch(
        self,
        conductor_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None,
        reason: str = "",
        pipeline: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        pipeline = pipeline or {}
        row = await self.pool.fetchrow(
            """
            UPDATE dispatches
            SET status = $3,
                reason = $4,
                completed_at = $5::timestamptz,
                graph_id = COALESCE($7, graph_id),
                node_id = COALESCE($8, node_id),
                attempt_id = COALESCE($9, attempt_id),
                mode = COALESCE($10, mode),
                attempt_status = COALESCE($11, attempt_status),
                graph_revision = COALESCE($12, graph_revision),
                policy_revision = COALESCE($13, policy_revision),
                lease_id = COALESCE($14, lease_id),
                updated_at = now()
            WHERE id = $2 AND leased_conductor_id = $1 AND fencing_token = $6::bigint
            RETURNING *
            """,
            conductor_id,
            dispatch_id,
            status,
            reason,
            _pg_datetime(completed_at),
            fencing_token,
            pipeline.get("graph_id"),
            pipeline.get("node_id"),
            pipeline.get("attempt_id"),
            pipeline.get("mode"),
            pipeline.get("attempt_status"),
            pipeline.get("graph_revision"),
            pipeline.get("policy_revision"),
            pipeline.get("lease_id"),
        )
        return _record_to_dispatch(row) if row is not None else None

    async def reap_expired_dispatch_leases(self) -> int:
        result = await self.pool.execute(
            """
            UPDATE dispatches
            SET status = 'queued', leased_conductor_id = NULL, leased_until = NULL, updated_at = now()
            WHERE status = 'leased' AND leased_until < now()
            """
        )
        return _row_count(result)

    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO onboarding_state (user_id, completed_steps_json, metadata_json, updated_at)
            VALUES ($1,$2::jsonb,$3::jsonb,now())
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
        row = await self.pool.fetchrow("SELECT completed_steps_json, metadata_json, updated_at FROM onboarding_state WHERE user_id = $1", user_id)
        if row is None:
            return None
        return {
            "completed_steps": list(_pg_json_value(row["completed_steps_json"], [])),
            "metadata": dict(_pg_json_value(row["metadata_json"], {})),
            "updated_at": row["updated_at"].isoformat(),
        }

    async def save_smoke_result(self, user_id: str, result: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO smoke_results (user_id, result_json, updated_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (user_id) DO UPDATE SET result_json = EXCLUDED.result_json, updated_at = now()
            """,
            user_id,
            _pg_json(result),
        )

    async def get_smoke_result(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT result_json FROM smoke_results WHERE user_id = $1", user_id)
        return dict(_pg_json_value(row["result_json"], {})) if row is not None else None

    async def set_presence(self, runtime_id: str, *, timestamp: str, expires_at: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO runtime_presence (runtime_id, last_seen_at, expires_at)
            VALUES ($1,$2::timestamptz,$3::timestamptz)
            ON CONFLICT (runtime_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at
            """,
            runtime_id,
            _pg_datetime(timestamp),
            _pg_datetime(expires_at),
        )

    async def clear_presence(self, runtime_id: str) -> None:
        await self.pool.execute("DELETE FROM runtime_presence WHERE runtime_id = $1", runtime_id)

    async def get_presence(self, runtime_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT runtime_id, last_seen_at, expires_at FROM runtime_presence WHERE runtime_id = $1 AND expires_at >= now()", runtime_id)
        if row is None:
            return None
        return {"runtime_id": str(row["runtime_id"]), "last_seen_at": row["last_seen_at"].isoformat(), "expires_at": row["expires_at"].isoformat()}

    async def upsert_metrics_snapshot(self, conductor_id: str, instance_id: str, metrics: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO metrics_snapshots (conductor_id, instance_id, captured_at, metrics_json)
            VALUES ($1,$2,$3::timestamptz,$4::jsonb)
            ON CONFLICT (conductor_id, instance_id) DO UPDATE SET captured_at = EXCLUDED.captured_at, metrics_json = EXCLUDED.metrics_json
            """,
            conductor_id,
            instance_id,
            _pg_datetime(metrics.get("captured_at")),
            _pg_json(metrics),
        )

    async def get_metrics_snapshot(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT metrics_json FROM metrics_snapshots WHERE conductor_id = $1 AND instance_id = $2", conductor_id, instance_id)
        return dict(_pg_json_value(row["metrics_json"], {})) if row is not None else None

    async def upsert_instance_log_tail(self, conductor_id: str, instance_id: str, tail: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO instance_log_tails (conductor_id, instance_id, tail_json, updated_at)
            VALUES ($1,$2,$3::jsonb,$4::timestamptz)
            ON CONFLICT (conductor_id, instance_id) DO UPDATE SET tail_json = EXCLUDED.tail_json, updated_at = EXCLUDED.updated_at
            """,
            conductor_id,
            instance_id,
            _pg_json(tail),
            _pg_datetime(tail.get("updated_at")),
        )

    async def get_instance_log_tail(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT tail_json FROM instance_log_tails WHERE conductor_id = $1 AND instance_id = $2", conductor_id, instance_id)
        return dict(_pg_json_value(row["tail_json"], {})) if row is not None else None

    async def save_log_fetch_result(self, request_id: str, result: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO log_fetch_results (request_id, result_json, created_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (request_id) DO UPDATE SET result_json = EXCLUDED.result_json, created_at = now()
            """,
            request_id,
            _pg_json(result),
        )

    async def get_log_fetch_result(self, request_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT result_json FROM log_fetch_results WHERE request_id = $1", request_id)
        return dict(_pg_json_value(row["result_json"], {})) if row is not None else None

    async def save_runtime_config(self, runtime_group_id: str, config: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO runtime_configs (runtime_group_id, config_json, updated_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (runtime_group_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = now()
            """,
            runtime_group_id,
            _pg_json(config),
        )

    async def get_runtime_config(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT config_json FROM runtime_configs WHERE runtime_group_id = $1", runtime_group_id)
        return dict(_pg_json_value(row["config_json"], {})) if row is not None else None

    async def save_pipeline_view(self, runtime_group_id: str, view: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO pipeline_views (runtime_group_id, view_json, updated_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (runtime_group_id) DO UPDATE SET view_json = EXCLUDED.view_json, updated_at = now()
            """,
            runtime_group_id,
            _pg_json(view),
        )

    async def get_pipeline_view(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT view_json FROM pipeline_views WHERE runtime_group_id = $1", runtime_group_id)
        return dict(_pg_json_value(row["view_json"], {})) if row is not None else None

    async def append_runtime_command(self, runtime_id: str, command: dict[str, Any]) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            """
            INSERT INTO runtime_commands (runtime_id, command_json, created_at)
            VALUES ($1,$2::jsonb,now())
            RETURNING id, runtime_id, command_json, created_at
            """,
            runtime_id,
            _pg_json(command),
        )
        await self.pool.execute("SELECT pg_notify($1, $2)", f"runtime_commands_{runtime_id}", str(row["id"]))
        return _record_to_runtime_command(row)

    async def next_runtime_command(self, runtime_id: str, *, after_id: int = 0) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT id, runtime_id, command_json, created_at FROM runtime_commands WHERE runtime_id = $1 AND id > $2 ORDER BY id LIMIT 1",
            runtime_id,
            after_id,
        )
        return _record_to_runtime_command(row) if row is not None else None

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO proxy_audit_events (runtime_id, workspace_id, operation_name, allowed, reason, metadata_json, created_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
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
        "linear_app": _pg_json_value(row["linear_app_json"], None),
    }


def _record_to_runtime_group(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "linear_workspace_id": str(row["linear_workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "linear_agent_app_user_id": str(row["linear_agent_app_user_id"]),
        "pipeline_profile": str(row["pipeline_profile"]),
        "project_binding_id": str(row["project_binding_id"]),
    }


def _record_to_runtime(row: Any) -> dict[str, Any]:
    user_id = str(row["user_id"])
    return {
        "id": str(row["id"]),
        "runtime_group_id": str(row["runtime_group_id"] or f"group_{user_id}"),
        "user_id": user_id,
        "runtime_token_hash": str(row["runtime_token_hash"]),
        "proxy_token_hash": str(row["proxy_token_hash"]),
        "disabled": bool(row["disabled"]),
        "revoked": bool(row["revoked"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "hostname": str(row["hostname"]),
        "label": str(row["label"]),
        "version": str(row["version"]),
    }


def _record_to_conductor(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "user_id": str(row["user_id"]),
        "hostname": str(row["hostname"]),
        "label": str(row["label"]),
        "version": str(row["version"]),
        "conductor_id": str(row["conductor_id"]),
        "runtime_group_id": str(row["runtime_group_id"] or f"group_{row['user_id']}"),
        "runtime_token_hash": str(row["runtime_token_hash"]),
        "proxy_token_hash": str(row["proxy_token_hash"]),
        "disabled": bool(row["disabled"]),
        "revoked": bool(row["revoked"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "last_report_at": row["last_report_at"].isoformat() if row["last_report_at"] is not None else None,
    }


def _record_to_project_binding(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "conductor_id": str(row["conductor_id"]),
        "user_id": str(row["user_id"]),
        "instance_id": str(row["instance_id"]),
        "name": str(row["name"]),
        "linear_project": str(row["linear_project"]),
        "project_slug": str(row["project_slug"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "pipeline_profile": str(row["pipeline_profile"]),
        "process_status": str(row["process_status"]),
        "constraint_labels": list(_pg_json_value(row["constraint_labels"], [])),
        "repo_source": _pg_json_value(row["repo_source"], {}),
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else "",
    }


def _record_to_dispatch(row: Any) -> dict[str, Any]:
    return {
        "dispatch_id": str(row["id"]),
        "project_binding_id": str(row["project_binding_id"]),
        "user_id": str(row["user_id"]),
        "issue_id": str(row["issue_id"]),
        "issue_identifier": str(row["issue_identifier"]),
        "issue_title": str(row["issue_title"]),
        "issue_description": str(row["issue_description"]),
        "pipeline_intent": _pg_json_value(row["pipeline_intent"], {}),
        "linear_workspace_id": str(row["workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "agent_session_id": str(row["agent_session_id"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "issue_delegate_id": str(row["issue_delegate_id"]),
        "status": str(row["status"]),
        "reason": str(row["reason"]),
        "leased_runtime_id": row["leased_conductor_id"],
        "leased_conductor_id": row["leased_conductor_id"],
        "leased_until": row["leased_until"].isoformat() if row["leased_until"] is not None else None,
        "fencing_token": int(row["fencing_token"] or 0),
        "graph_id": str(row["graph_id"]),
        "node_id": str(row["node_id"]),
        "attempt_id": str(row["attempt_id"]),
        "mode": str(row["mode"]),
        "attempt_status": str(row["attempt_status"]),
        "graph_revision": int(row["graph_revision"] or 0),
        "policy_revision": int(row["policy_revision"] or 0),
        "lease_id": str(row["lease_id"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else "",
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] is not None else None,
    }


def _record_to_runtime_command(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "runtime_id": str(row["runtime_id"]),
        "command": dict(_pg_json_value(row["command_json"], {})),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
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


def _pg_json_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def _row_count(result: str) -> int:
    try:
        return int(str(result).rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return 0
