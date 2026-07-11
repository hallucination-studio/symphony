from __future__ import annotations

from typing import Any
from uuid import uuid4


RECORD_BACKGROUND_JOB_FAILURE_SQL = """
INSERT INTO background_job_failures (
  job_name, failure_id, error_type, error_code, sanitized_reason, action_required,
  retryable, attempt_number, next_action, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,now())
ON CONFLICT (job_name) DO UPDATE SET
  failure_id = EXCLUDED.failure_id,
  error_type = EXCLUDED.error_type,
  error_code = EXCLUDED.error_code,
  sanitized_reason = EXCLUDED.sanitized_reason,
  action_required = EXCLUDED.action_required,
  retryable = EXCLUDED.retryable,
  attempt_number = background_job_failures.attempt_number + 1,
  next_action = EXCLUDED.next_action,
  updated_at = now()
RETURNING *
"""


class PgHealthMixin:
    async def record_background_job_failure(
        self,
        job_name: str,
        failure: dict[str, Any],
    ) -> dict[str, Any]:
        row = await _record_background_job_failure(
            self.pool,
            job_name,
            uuid4().hex,
            failure,
        )
        return _background_job_failure(row)

    async def probe_background_job_failure_store(self) -> None:
        async with self.pool.acquire() as connection:
            transaction = connection.transaction()
            await transaction.start()
            try:
                job_name = f"__health_probe__:{uuid4().hex}"
                failure = _probe_failure()
                await _record_background_job_failure(connection, job_name, uuid4().hex, failure)
                await _record_background_job_failure(connection, job_name, uuid4().hex, failure)
            finally:
                await transaction.rollback()

    async def get_background_job_failure(self, job_name: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM background_job_failures WHERE job_name = $1",
            job_name,
        )
        return _background_job_failure(row) if row is not None else None

    async def clear_background_job_failure(
        self,
        job_name: str,
        failure_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            DELETE FROM background_job_failures
            WHERE job_name = $1 AND failure_id = $2
            RETURNING *
            """,
            job_name,
            failure_id,
        )
        return _background_job_failure(row) if row is not None else None


def _background_job_failure(row: Any) -> dict[str, Any]:
    return {
        "failure_id": str(row["failure_id"]),
        "error_type": str(row["error_type"]),
        "error_code": str(row["error_code"]),
        "sanitized_reason": str(row["sanitized_reason"]),
        "action_required": str(row["action_required"]),
        "retryable": bool(row["retryable"]),
        "attempt_number": int(row["attempt_number"]),
        "next_action": str(row["next_action"]),
    }


async def _record_background_job_failure(
    connection: Any,
    job_name: str,
    failure_id: str,
    failure: dict[str, Any],
) -> Any:
    return await connection.fetchrow(
        RECORD_BACKGROUND_JOB_FAILURE_SQL,
        job_name,
        failure_id,
        str(failure["error_type"]),
        str(failure["error_code"]),
        str(failure["sanitized_reason"]),
        str(failure["action_required"]),
        bool(failure["retryable"]),
        str(failure["next_action"]),
    )


def _probe_failure() -> dict[str, Any]:
    return {
        "error_type": "HealthStoreProbe",
        "error_code": "background_health_store_probe",
        "sanitized_reason": "Background health store probe",
        "action_required": "",
        "retryable": True,
        "next_action": "",
    }
