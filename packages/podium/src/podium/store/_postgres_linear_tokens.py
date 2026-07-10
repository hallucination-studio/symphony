from __future__ import annotations

from contextlib import asynccontextmanager


class PgLinearTokensMixin:
    @asynccontextmanager
    async def linear_installation_token_lock(self, installation_id: str):
        async with self.pool.acquire() as connection:
            await connection.execute("SELECT pg_advisory_lock(hashtext($1))", installation_id)
            try:
                yield
            finally:
                await connection.execute("SELECT pg_advisory_unlock(hashtext($1))", installation_id)

    async def disconnect_workspace_installation(self, user_id: str, installation_id: str) -> None:
        await self.pool.execute(
            """
            UPDATE linear_workspace_installations
            SET active = FALSE, state = 'disconnected', updated_at = now()
            WHERE user_id = $1 AND id = $2 AND active = TRUE
            """,
            user_id,
            installation_id,
        )
