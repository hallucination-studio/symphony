from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from podium.store.sqlite import SQLiteStore


def open_store(path: Path, *, timeout: int = 100) -> SQLiteStore:
    return SQLiteStore(path, busy_timeout_ms=timeout)


def test_negative_busy_timeout_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="busy_timeout_ms_must_be_non_negative"):
        open_store(tmp_path / "podium.db", timeout=-1)


def test_configuration_and_atomic_page_survive_reopen(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = open_store(path)
    store.initialize()
    store.add_binding("binding-1")
    assert store.connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert store.connection.execute("PRAGMA busy_timeout").fetchone()[0] == 100

    assert store.commit_page(
        "binding-1",
        expected_state=None,
        state={"cursor": "page-2"},
        observations=[{"issue_id": "issue-1", "delegated": 1, "delegation_epoch": 3}],
        dispatches=[{"id": "dispatch-1", "intake_key": "issue-1:3"}],
    ) == 1
    store.close()

    reopened = open_store(path)
    assert reopened.snapshot("binding-1") == {
        "state": {"cursor": "page-2"},
        "observations": [{"issue_id": "issue-1", "delegated": 1, "delegation_epoch": 3}],
        "dispatches": [{"id": "dispatch-1", "intake_key": "issue-1:3"}],
    }


def test_failed_page_rolls_back_every_fact(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.initialize()
    store.add_binding("binding-1")
    with pytest.raises(sqlite3.IntegrityError):
        store.commit_page(
            "binding-1",
            expected_state=None,
            state={"cursor": "bad"},
            observations=[{"issue_id": "issue-1", "delegated": 1, "delegation_epoch": 1}],
            dispatches=[{"id": "dispatch-1", "intake_key": None}],
        )
    assert store.snapshot("binding-1") == {"state": None, "observations": [], "dispatches": []}


def test_single_writer_lock_times_out_explicitly(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    first = open_store(path)
    first.initialize()
    first.add_binding("binding-1")
    second = open_store(path, timeout=50)
    first.connection.execute("BEGIN IMMEDIATE")
    started = time.monotonic()
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        second.commit_page("binding-1", expected_state=None, state={}, observations=[], dispatches=[])
    assert 0.04 <= time.monotonic() - started < 1
    first.connection.rollback()


def test_corruption_fails_without_recreating_database(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    content = b"not a sqlite database"
    path.write_bytes(content)
    with pytest.raises(sqlite3.DatabaseError):
        open_store(path)
    assert path.read_bytes() == content


def test_foreign_key_violation_is_not_silenced(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.initialize()
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        store.commit_page("missing", expected_state=None, state={}, observations=[], dispatches=[])


def test_checkpoint_compare_and_swap_prevents_duplicate_dispatch(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.initialize()
    store.add_binding("binding-1")
    page = {
        "expected_state": None,
        "state": {"cursor": "page-2"},
        "observations": [{"issue_id": "issue-1", "delegated": 1, "delegation_epoch": 1}],
        "dispatches": [{"id": "dispatch-1", "intake_key": "issue-1:1"}],
    }
    assert store.commit_page("binding-1", **page) == 1
    assert store.commit_page("binding-1", **page) is None
    assert len(store.snapshot("binding-1")["dispatches"]) == 1


def test_disk_full_fails_and_rolls_back_page(tmp_path: Path) -> None:
    store = open_store(tmp_path / "podium.db")
    store.initialize()
    store.add_binding("binding-1")
    page_count = store.connection.execute("PRAGMA page_count").fetchone()[0]
    store.connection.execute(f"PRAGMA max_page_count = {page_count}")

    with pytest.raises(sqlite3.OperationalError, match="full"):
        store.commit_page(
            "binding-1",
            expected_state=None,
            state={"cursor": "x" * 100_000},
            observations=[],
            dispatches=[],
        )
    assert store.snapshot("binding-1")["state"] is None


def test_uncommitted_page_is_rolled_back_when_connection_dies(tmp_path: Path) -> None:
    path = tmp_path / "podium.db"
    store = open_store(path)
    store.initialize()
    store.add_binding("binding-1")
    store.connection.execute("BEGIN IMMEDIATE")
    store.connection.execute(
        "INSERT INTO issue_observations VALUES (?, ?, ?, ?)",
        ("binding-1", "issue-1", 1, 1),
    )
    store.close()

    reopened = open_store(path)
    assert reopened.snapshot("binding-1") == {
        "state": None,
        "observations": [],
        "dispatches": [],
    }
