from __future__ import annotations

from collections.abc import Iterable

from ._postgres_health_statements import BACKGROUND_HEALTH_STATEMENTS
from ._postgres_linear_installation_statements import LINEAR_INSTALLATION_STATEMENTS
from ._postgres_linear_reconciliation_statements import LINEAR_RECONCILIATION_STATEMENTS
from ._postgres_schema_statements import POSTGRES_SCHEMA_STATEMENTS


class PgSchema:
    """Fresh Podium PostgreSQL schema for the hard cutover."""

    def statements(self) -> Iterable[str]:
        return (
            *POSTGRES_SCHEMA_STATEMENTS,
            *BACKGROUND_HEALTH_STATEMENTS,
            *LINEAR_INSTALLATION_STATEMENTS,
            *LINEAR_RECONCILIATION_STATEMENTS,
        )
