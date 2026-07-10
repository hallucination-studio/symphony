from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _record_to_user


class PgAuthMixin:
    async def next_user_id(self) -> str:
        value = await self.pool.fetchval("SELECT nextval('podium_user_id_seq')")
        return f"user_{int(value)}"

    async def create_user(self, user_id: str, *, email: str, password_hash: str, created_at: str) -> dict[str, Any]:
        row = await self.pool.fetchrow(
            """
            INSERT INTO users (id, email, password_hash, created_at)
            VALUES ($1, $2, $3, $4::timestamptz)
            RETURNING id, email, password_hash, created_at
            """,
            user_id,
            email,
            password_hash,
            _pg_datetime(created_at),
        )
        return _record_to_user(row)

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT id, email, password_hash, created_at FROM users WHERE id = $1", user_id)
        return _record_to_user(row) if row is not None else None

    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT id, email, password_hash, created_at FROM users WHERE email = $1", email)
        return _record_to_user(row) if row is not None else None

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
