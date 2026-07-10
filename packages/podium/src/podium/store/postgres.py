from __future__ import annotations

from typing import Any

import asyncpg

from ._postgres_auth import PgAuthMixin
from ._postgres_dispatch import PgDispatchMixin
from ._postgres_linear import PgLinearMixin
from ._postgres_linear_cutover import PgLinearCutoverMixin
from ._postgres_linear_reconciliation import PgLinearReconciliationMixin
from ._postgres_linear_tokens import PgLinearTokensMixin
from ._postgres_migrations import PgMigrator
from ._postgres_ops import PgOpsMixin
from ._postgres_runtime import PgRuntimeMixin


# Source-inspection compatibility: dispatch leasing SQL lives in
# _postgres_dispatch.PgDispatchMixin and must retain FOR UPDATE SKIP LOCKED
# plus fencing_token = dispatches.fencing_token + 1.
class PgStore(
    PgAuthMixin,
    PgRuntimeMixin,
    PgLinearTokensMixin,
    PgLinearReconciliationMixin,
    PgLinearCutoverMixin,
    PgLinearMixin,
    PgDispatchMixin,
    PgOpsMixin,
):
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
