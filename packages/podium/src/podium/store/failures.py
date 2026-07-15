from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True)
class BackgroundFailure:
    failure_id: str
    retry_count: int
    last_reason: str
    next_action: str
    next_attempt_at: int | None

    def __post_init__(self) -> None:
        if re.fullmatch(r"[a-z][a-z0-9_]{0,127}", self.failure_id) is None:
            raise ValueError("background_failure_id_invalid")
        if (
            isinstance(self.retry_count, bool)
            or not isinstance(self.retry_count, int)
            or self.retry_count < 0
        ):
            raise ValueError("background_failure_retry_count_invalid")
        if re.fullmatch(r"[a-z][a-z0-9_]{0,499}", self.last_reason) is None:
            raise ValueError("background_failure_reason_invalid")
        if re.fullmatch(r"[a-z][a-z0-9_]{0,127}", self.next_action) is None:
            raise ValueError("background_failure_next_action_invalid")
        if self.next_attempt_at is not None and (
            isinstance(self.next_attempt_at, bool)
            or not isinstance(self.next_attempt_at, int)
            or self.next_attempt_at < 0
        ):
            raise ValueError("background_failure_next_attempt_invalid")


class FailureRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def save(self, failure: BackgroundFailure) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.execute(
                """INSERT INTO background_failures (
                    failure_id, retry_count, last_reason, next_action, next_attempt_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(failure_id) DO UPDATE SET
                    retry_count = excluded.retry_count,
                    last_reason = excluded.last_reason,
                    next_action = excluded.next_action,
                    next_attempt_at = excluded.next_attempt_at""",
                (
                    failure.failure_id,
                    failure.retry_count,
                    failure.last_reason,
                    failure.next_action,
                    failure.next_attempt_at,
                ),
            )

    def get(self, failure_id: str) -> BackgroundFailure | None:
        row = self.connection.execute(
            "SELECT * FROM background_failures WHERE failure_id = ?", (failure_id,)
        ).fetchone()
        return BackgroundFailure(**dict(row)) if row is not None else None
