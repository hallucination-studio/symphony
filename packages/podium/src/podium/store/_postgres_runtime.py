from __future__ import annotations

from datetime import datetime
from typing import Any

from ._postgres_records import (
    _pg_datetime,
    _pg_json,
    _pg_json_value,
    _record_to_conductor,
    _record_to_runtime,
    _record_to_runtime_command,
    _record_to_runtime_group,
)


class PgRuntimeMixin:
    async def upsert_runtime_group(self, group: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO runtime_groups (
              id, linear_workspace_id, project_slug, linear_agent_app_user_id, managed_run_profile, project_binding_id, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,now())
            ON CONFLICT (id) DO UPDATE SET
              linear_workspace_id = EXCLUDED.linear_workspace_id,
              project_slug = EXCLUDED.project_slug,
              linear_agent_app_user_id = EXCLUDED.linear_agent_app_user_id,
              managed_run_profile = EXCLUDED.managed_run_profile,
              project_binding_id = EXCLUDED.project_binding_id,
              updated_at = now()
            """,
            str(group["id"]),
            str(group.get("linear_workspace_id") or ""),
            str(group.get("project_slug") or ""),
            str(group.get("linear_agent_app_user_id") or ""),
            str(group.get("managed_run_profile") or "default"),
            str(group.get("project_binding_id") or ""),
        )

    async def get_runtime_group(self, group_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM runtime_groups WHERE id = $1", group_id)
        return _record_to_runtime_group(row) if row is not None else None

    async def list_runtime_groups(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM runtime_groups ORDER BY id")
        return [_record_to_runtime_group(row) for row in rows]

    async def save_enrollment_token(
        self,
        token_hash: str,
        *,
        runtime_group_id: str,
        conductor_id: str,
        expires_at: str,
    ) -> None:
        await self.pool.execute(
            """
            INSERT INTO enrollment_tokens (token_hash, runtime_group_id, conductor_id, used, expires_at, created_at)
            VALUES ($1,$2,$3,FALSE,$4::timestamptz,now())
            ON CONFLICT (token_hash) DO UPDATE SET
              runtime_group_id = EXCLUDED.runtime_group_id,
              conductor_id = EXCLUDED.conductor_id,
              used = FALSE,
              expires_at = EXCLUDED.expires_at,
              created_at = now()
            """,
            token_hash,
            runtime_group_id,
            conductor_id,
            _pg_datetime(expires_at),
        )

    async def consume_enrollment_token(self, token_hash: str) -> tuple[dict[str, Any] | None, str | None]:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow("SELECT runtime_group_id, conductor_id, used, expires_at FROM enrollment_tokens WHERE token_hash = $1 FOR UPDATE", token_hash)
            if row is None:
                return None, "invalid_enrollment_token"
            if bool(row["used"]):
                return None, "enrollment_token_used"
            if row["expires_at"] < datetime.now(row["expires_at"].tzinfo):
                return None, "enrollment_token_expired"
            await connection.execute("UPDATE enrollment_tokens SET used = TRUE WHERE token_hash = $1", token_hash)
        return {
            "runtime_group_id": str(row["runtime_group_id"]),
            "conductor_id": str(row["conductor_id"]),
            "used": True,
            "expires_at": row["expires_at"].isoformat(),
        }, None

    async def has_pending_enrollment(self, runtime_group_id: str) -> bool:
        value = await self.pool.fetchval(
            "SELECT EXISTS (SELECT 1 FROM enrollment_tokens WHERE runtime_group_id = $1 AND used = FALSE AND expires_at >= now())",
            runtime_group_id,
        )
        return bool(value)

    async def upsert_conductor(self, conductor: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO conductors (
              id, user_id, hostname, label, version, conductor_id, runtime_group_id,
              name, public_id, enrollment_state, service_identity, data_root,
              runtime_token_hash, proxy_token_hash, disabled, revoked, created_at, last_report_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              hostname = EXCLUDED.hostname,
              label = EXCLUDED.label,
              version = EXCLUDED.version,
              runtime_group_id = EXCLUDED.runtime_group_id,
              name = EXCLUDED.name,
              public_id = EXCLUDED.public_id,
              enrollment_state = EXCLUDED.enrollment_state,
              service_identity = EXCLUDED.service_identity,
              data_root = EXCLUDED.data_root,
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
            str(conductor.get("name") or ""),
            str(conductor.get("public_id") or ""),
            str(conductor.get("enrollment_state") or "pending"),
            str(conductor.get("service_identity") or ""),
            str(conductor.get("data_root") or ""),
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
            f"SELECT * FROM conductors WHERE {column} = $1",
            token_hash,
        )
        return _record_to_runtime(row) if row is not None else None

    async def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM conductors WHERE id = $1",
            runtime_id,
        )
        return _record_to_runtime(row) if row is not None else None

    async def list_conductors_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM conductors WHERE user_id = $1 ORDER BY created_at, id", user_id)
        return [_record_to_conductor(row) for row in rows]

    async def list_all_conductors(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM conductors ORDER BY created_at, id")
        return [_record_to_conductor(row) for row in rows]

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

    async def append_runtime_command_once(
        self, runtime_id: str, dedupe_key: str, command: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            """
            INSERT INTO runtime_commands (runtime_id, dedupe_key, command_json, created_at)
            VALUES ($1,$2,$3::jsonb,now())
            ON CONFLICT (runtime_id, dedupe_key) WHERE dedupe_key <> '' DO NOTHING
            RETURNING id, runtime_id, command_json, created_at
            """,
            runtime_id,
            dedupe_key,
            _pg_json(command),
        )
        if row is None:
            row = await self.pool.fetchrow(
                """
                SELECT id, runtime_id, command_json, created_at FROM runtime_commands
                WHERE runtime_id = $1 AND dedupe_key = $2
                """,
                runtime_id,
                dedupe_key,
            )
            return _record_to_runtime_command(row)
        await self.pool.execute("SELECT pg_notify($1, $2)", f"runtime_commands_{runtime_id}", str(row["id"]))
        return _record_to_runtime_command(row)

    async def next_runtime_command(self, runtime_id: str, *, after_id: int = 0) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT id, runtime_id, command_json, created_at FROM runtime_commands WHERE runtime_id = $1 AND id > $2 ORDER BY id LIMIT 1",
            runtime_id,
            after_id,
        )
        return _record_to_runtime_command(row) if row is not None else None
