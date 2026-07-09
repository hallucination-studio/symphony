from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _pg_json_value


class PgLinearMixin:
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
