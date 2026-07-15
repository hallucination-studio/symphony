from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from .schema import (
    BINDING_REPORT_STATEMENTS,
    LINEAR_METADATA_STATEMENTS,
    SQLITE_SCHEMA_STATEMENTS,
)


@dataclass(frozen=True)
class Migration:
    version: int
    statements: tuple[str, ...]


MIGRATIONS = (
    Migration(1, SQLITE_SCHEMA_STATEMENTS),
    Migration(2, LINEAR_METADATA_STATEMENTS),
    Migration(3, BINDING_REPORT_STATEMENTS),
)


def apply_migrations(
    connection: sqlite3.Connection,
    *,
    migrations: tuple[Migration, ...] = MIGRATIONS,
) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    applied = {
        row[0] for row in connection.execute("SELECT version FROM schema_migrations")
    }
    for migration in migrations:
        if migration.version in applied:
            continue
        try:
            connection.execute("BEGIN IMMEDIATE")
            for statement in migration.statements:
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations (version) VALUES (?)",
                (migration.version,),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
