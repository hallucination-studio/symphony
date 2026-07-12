from __future__ import annotations

from typing import Any

import asyncpg

from ._postgres_auth import PgAuthMixin
from ._postgres_dispatch import PgDispatchMixin
from ._postgres_health import PgHealthMixin
from ._postgres_linear import PgLinearMixin
from ._postgres_linear_cutover import PgLinearCutoverMixin
from ._postgres_linear_reconciliation import PgLinearReconciliationMixin
from ._postgres_schema import PgSchema
from ._postgres_ops import PgOpsMixin
from ._postgres_project_replacements import PgProjectReplacementsMixin
from ._postgres_project_unbind import PgProjectUnbindMixin
from ._postgres_runtime import PgRuntimeMixin


class PgStore(
    PgAuthMixin,
    PgHealthMixin,
    PgRuntimeMixin,
    PgLinearReconciliationMixin,
    PgLinearCutoverMixin,
    PgLinearMixin,
    PgDispatchMixin,
    PgProjectUnbindMixin,
    PgProjectReplacementsMixin,
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

    async def ensure_schema(self, schema: PgSchema | None = None) -> None:
        async with self.pool.acquire() as connection:
            for statement in (schema or PgSchema()).statements():
                await connection.execute(statement)

    async def close(self) -> None:
        if self._owns_pool:
            await self.pool.close()
