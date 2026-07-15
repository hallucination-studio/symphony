from __future__ import annotations

import sqlite3
from typing import Any


def read_failures(
    connection: sqlite3.Connection, *, limit: int
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT failure_id, retry_count, last_reason, next_action, next_attempt_at
        FROM background_failures ORDER BY failure_id LIMIT ?""",
        (limit,),
    ).fetchall()
    return [
        {
            "kind": "active",
            "error_code": row["failure_id"],
            "correlation_id": row["failure_id"],
            "sanitized_reason": row["last_reason"],
            "retry_count": row["retry_count"],
            "next_action": row["next_action"],
            "next_attempt_at": row["next_attempt_at"],
        }
        for row in rows
    ]
