from __future__ import annotations

from collections.abc import Iterable

from ._postgres_linear_installation_statements import LINEAR_INSTALLATION_STATEMENTS
from ._postgres_linear_reconciliation_statements import LINEAR_RECONCILIATION_STATEMENTS
from ._postgres_migration_statements import POSTGRES_MIGRATION_STATEMENTS


class PgMigrator:
    """Handwritten Podium PostgreSQL schema."""

    def statements(self) -> Iterable[str]:
        return (
            *POSTGRES_MIGRATION_STATEMENTS,
            *LINEAR_INSTALLATION_STATEMENTS,
            *LINEAR_RECONCILIATION_STATEMENTS,
        )
