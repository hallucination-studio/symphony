from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from .conductor_models import utc_now_iso
from .conductor_store import ConductorStore


class ConductorSmokeCheckStore:
    def __init__(self, store: ConductorStore) -> None:
        self.store = store
        self._init_schema()

    def get(self, smoke_check_id: str) -> dict[str, Any] | None:
        with self.store.connect() as connection:
            row = connection.execute(
                "SELECT * FROM smoke_check_results WHERE smoke_check_id = ?",
                (smoke_check_id,),
            ).fetchone()
        return _record(row) if row is not None else None

    def save_result(self, command: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        now = utc_now_iso()
        with self.store.connect() as connection:
            connection.execute(
                """
                INSERT INTO smoke_check_results (
                  smoke_check_id, binding_id, command_json, result_json,
                  delivery_status, delivery_attempts, delivery_error_code,
                  delivery_error_reason, retryable, action_required, next_action,
                  next_attempt_at, created_at, updated_at, delivered_at
                ) VALUES (?, ?, ?, ?, 'pending', 0, '', '', 1, 'post_smoke_result',
                          'post_smoke_result', ?, ?, ?, NULL)
                ON CONFLICT(smoke_check_id) DO NOTHING
                """,
                (
                    str(command["smoke_check_id"]),
                    str(command["binding_id"]),
                    _json(command),
                    _json(result),
                    now,
                    now,
                    now,
                ),
            )
        saved = self.get(str(command["smoke_check_id"]))
        if saved is None:
            raise RuntimeError("smoke_result_persistence_failed")
        return saved

    def begin_delivery(self, smoke_check_id: str) -> dict[str, Any]:
        with self.store.connect() as connection:
            connection.execute(
                """
                UPDATE smoke_check_results
                SET delivery_status = 'posting', delivery_attempts = delivery_attempts + 1,
                    delivery_error_code = '', delivery_error_reason = '',
                    action_required = '', next_action = '', next_attempt_at = NULL,
                    updated_at = ?
                WHERE smoke_check_id = ? AND delivery_status <> 'delivered'
                """,
                (utc_now_iso(), smoke_check_id),
            )
        row = self.get(smoke_check_id)
        if row is None:
            raise KeyError(smoke_check_id)
        return row

    def mark_delivered(self, smoke_check_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.store.connect() as connection:
            connection.execute(
                """
                UPDATE smoke_check_results
                SET delivery_status = 'delivered', delivery_error_code = '',
                    delivery_error_reason = '', retryable = 0, action_required = '',
                    next_action = '', next_attempt_at = NULL, delivered_at = ?, updated_at = ?
                WHERE smoke_check_id = ?
                """,
                (now, now, smoke_check_id),
            )
        return self._required(smoke_check_id)

    def mark_delivery_failed(
        self,
        smoke_check_id: str,
        *,
        error_code: str,
        reason: str,
        retryable: bool,
        action_required: str,
        next_action: str,
    ) -> dict[str, Any]:
        current = self._required(smoke_check_id)
        next_attempt = _next_attempt(int(current["delivery_attempts"])) if retryable else None
        with self.store.connect() as connection:
            connection.execute(
                """
                UPDATE smoke_check_results
                SET delivery_status = ?, delivery_error_code = ?, delivery_error_reason = ?,
                    retryable = ?, action_required = ?, next_action = ?, next_attempt_at = ?,
                    updated_at = ? WHERE smoke_check_id = ?
                """,
                (
                    "retryable" if retryable else "rejected",
                    error_code,
                    reason,
                    1 if retryable else 0,
                    action_required,
                    next_action,
                    next_attempt,
                    utc_now_iso(),
                    smoke_check_id,
                ),
            )
        return self._required(smoke_check_id)

    def list_pending(self, *, force: bool = False) -> list[dict[str, Any]]:
        with self.store.connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM smoke_check_results
                WHERE delivery_status IN ('pending', 'posting', 'retryable')
                  AND (? = 1 OR next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY created_at, smoke_check_id
                """,
                (1 if force else 0, utc_now_iso()),
            ).fetchall()
        return [_record(row) for row in rows]

    def list_public(self) -> list[dict[str, Any]]:
        with self.store.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM smoke_check_results ORDER BY created_at DESC, smoke_check_id DESC LIMIT 100"
            ).fetchall()
        return [_public(_record(row)) for row in rows]

    def _required(self, smoke_check_id: str) -> dict[str, Any]:
        row = self.get(smoke_check_id)
        if row is None:
            raise KeyError(smoke_check_id)
        return row

    def _init_schema(self) -> None:
        with self.store.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS smoke_check_results (
                  smoke_check_id TEXT PRIMARY KEY,
                  binding_id TEXT NOT NULL,
                  command_json TEXT NOT NULL,
                  result_json TEXT NOT NULL,
                  delivery_status TEXT NOT NULL,
                  delivery_attempts INTEGER NOT NULL DEFAULT 0,
                  delivery_error_code TEXT NOT NULL DEFAULT '',
                  delivery_error_reason TEXT NOT NULL DEFAULT '',
                  retryable INTEGER NOT NULL DEFAULT 1,
                  action_required TEXT NOT NULL DEFAULT '',
                  next_action TEXT NOT NULL DEFAULT '',
                  next_attempt_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  delivered_at TEXT
                );
                CREATE INDEX IF NOT EXISTS smoke_check_results_delivery
                  ON smoke_check_results(delivery_status, next_attempt_at);
                """
            )


def _record(row: Any) -> dict[str, Any]:
    record = dict(row)
    record["command"] = json.loads(record.pop("command_json"))
    record["result"] = json.loads(record.pop("result_json"))
    record["delivery_attempts"] = int(record["delivery_attempts"] or 0)
    record["retryable"] = bool(record["retryable"])
    return record


def _public(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "command"}


def _next_attempt(attempt: int) -> str:
    delay = min(60, 5 * (2 ** max(0, attempt - 1)))
    return (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat().replace("+00:00", "Z")


def _json(value: dict[str, Any]) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)
