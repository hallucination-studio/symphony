from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from podium.store.migrations import MIGRATIONS, Migration, apply_migrations
from podium.store.schema import SQLITE_FEASIBILITY_SCHEMA
from podium.store.sqlite import SQLiteStore


def test_fresh_database_applies_every_migration_and_connection_pragma(tmp_path: Path) -> None:
    store = SQLiteStore(tmp_path / "podium.db", busy_timeout_ms=125)
    store.initialize()

    assert store.connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert store.connection.execute("PRAGMA busy_timeout").fetchone()[0] == 125
    assert [
        row[0]
        for row in store.connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
    ] == [migration.version for migration in MIGRATIONS]


def test_existing_feasibility_database_upgrades_and_reopens_idempotently(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    connection = sqlite3.connect(path, isolation_level=None)
    connection.executescript(SQLITE_FEASIBILITY_SCHEMA)
    connection.close()

    first = SQLiteStore(path)
    first.initialize()
    first.close()
    reopened = SQLiteStore(path)
    reopened.initialize()

    assert [
        row[0] for row in reopened.connection.execute("SELECT version FROM schema_migrations")
    ] == [migration.version for migration in MIGRATIONS]


def test_failed_migration_rolls_back_its_schema_and_version(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "podium.db", isolation_level=None)
    migrations = (
        Migration(1, ("CREATE TABLE stable (id TEXT PRIMARY KEY)",)),
        Migration(
            2,
            (
                "CREATE TABLE must_rollback (id TEXT PRIMARY KEY)",
                "INSERT INTO missing_table VALUES (1)",
            ),
        ),
    )

    with pytest.raises(sqlite3.OperationalError, match="missing_table"):
        apply_migrations(connection, migrations=migrations)

    assert connection.execute("SELECT version FROM schema_migrations").fetchall() == [(1,)]
    assert connection.execute(
        "SELECT name FROM sqlite_master WHERE name = 'must_rollback'"
    ).fetchone() is None
