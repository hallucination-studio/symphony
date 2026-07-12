from __future__ import annotations

from collections.abc import Iterable

from ._postgres_schema_statements import POSTGRES_SCHEMA_STATEMENTS


class PgSchema:
    """Fresh Podium PostgreSQL schema for the hard cutover."""

    def statements(self) -> Iterable[str]:
        return POSTGRES_SCHEMA_STATEMENTS
