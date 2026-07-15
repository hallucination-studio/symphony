from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .schema import SQLITE_FEASIBILITY_SCHEMA


class SQLiteStore:
    def __init__(self, path: Path, *, busy_timeout_ms: int = 250) -> None:
        if busy_timeout_ms < 0:
            raise ValueError("busy_timeout_ms_must_be_non_negative")
        self.connection = sqlite3.connect(
            path, timeout=busy_timeout_ms / 1000, isolation_level=None
        )
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
        self.connection.execute("PRAGMA journal_mode = WAL")

    def close(self) -> None:
        self.connection.close()

    def initialize(self) -> None:
        self.connection.executescript(SQLITE_FEASIBILITY_SCHEMA)

    def add_binding(self, binding_id: str) -> None:
        self.connection.execute("INSERT INTO bindings (id) VALUES (?)", (binding_id,))

    def state(self, binding_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT state_json FROM reconciliation_state WHERE binding_id = ?", (binding_id,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def snapshot(self, binding_id: str) -> dict[str, Any]:
        observations = self.connection.execute(
            "SELECT issue_id, delegated, delegation_epoch FROM issue_observations WHERE binding_id = ? ORDER BY issue_id",
            (binding_id,),
        ).fetchall()
        dispatches = self.connection.execute(
            "SELECT id, intake_key FROM dispatches WHERE binding_id = ? ORDER BY id", (binding_id,)
        ).fetchall()
        return {
            "state": self.state(binding_id),
            "observations": [dict(row) for row in observations],
            "dispatches": [dict(row) for row in dispatches],
        }

    def commit_page(
        self,
        binding_id: str,
        *,
        expected_state: dict[str, Any] | None,
        state: dict[str, Any],
        observations: list[dict[str, Any]],
        dispatches: list[dict[str, Any]],
    ) -> int | None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if self.state(binding_id) != expected_state:
                return None
            for observation in observations:
                self.connection.execute(
                    """INSERT INTO issue_observations
                    (binding_id, issue_id, delegated, delegation_epoch) VALUES (?, ?, ?, ?)
                    ON CONFLICT(binding_id, issue_id) DO UPDATE SET
                    delegated = excluded.delegated, delegation_epoch = excluded.delegation_epoch""",
                    (
                        binding_id,
                        observation["issue_id"],
                        observation["delegated"],
                        observation["delegation_epoch"],
                    ),
                )
            inserted = 0
            for dispatch in dispatches:
                cursor = self.connection.execute(
                    """INSERT INTO dispatches (id, binding_id, intake_key) VALUES (?, ?, ?)
                    ON CONFLICT(binding_id, intake_key) DO NOTHING""",
                    (dispatch["id"], binding_id, dispatch["intake_key"]),
                )
                inserted += cursor.rowcount
            self.connection.execute(
                """INSERT INTO reconciliation_state (binding_id, state_json) VALUES (?, ?)
                ON CONFLICT(binding_id) DO UPDATE SET state_json = excluded.state_json""",
                (binding_id, json.dumps(state, separators=(",", ":"), sort_keys=True)),
            )
        return inserted
