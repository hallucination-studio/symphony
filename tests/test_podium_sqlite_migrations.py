from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from podium.conductor_bindings import DesiredBinding
from podium.linear_models import InstallationMetadata, InstallationStatus, LinearProject
from podium.store.bindings import BindingRepository
from podium.store.linear import LinearRepository
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
    assert "selected" not in {
        row["name"]
        for row in reopened.connection.execute("PRAGMA table_info(linear_projects)")
    }


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


def test_v5_removes_selection_and_preserves_v4_project_binding(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = SQLiteStore(path)
    apply_migrations(store.connection, migrations=MIGRATIONS[:4])
    linear = LinearRepository(store.connection)
    linear.save_installation(
        InstallationMetadata(
            "installation-1",
            "organization-1",
            "Workspace",
            "app-user-1",
            ("app:assignable", "read", "write"),
            None,
            InstallationStatus.DISCONNECTED,
            100,
            None,
        )
    )
    linear.replace_projects(
        "installation-1",
        [LinearProject("project-1", "organization-1", "", "Runtime", "runtime")],
    )
    store.connection.execute(
        "UPDATE linear_projects SET selected = 1 WHERE project_id = 'project-1'"
    )
    BindingRepository(store.connection).save(
        DesiredBinding("binding-1", "project-1", "conductor-1", 1)
    )

    apply_migrations(store.connection)
    store.close()
    reopened = SQLiteStore(path)
    reopened.initialize()
    linear = LinearRepository(reopened.connection)

    assert "selected" not in {
        row["name"]
        for row in reopened.connection.execute("PRAGMA table_info(linear_projects)")
    }
    assert [(project.project_id, project.bound) for project in linear.projects()] == [
        ("project-1", True)
    ]
    assert BindingRepository(reopened.connection).active()[0].binding_id == "binding-1"
    assert reopened.connection.execute("PRAGMA foreign_key_check").fetchall() == []
    reopened.close()
