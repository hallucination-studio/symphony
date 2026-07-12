from __future__ import annotations

from collections.abc import Iterable


BACKGROUND_HEALTH_STATEMENTS: Iterable[str] = (
    """
    CREATE TABLE IF NOT EXISTS background_job_failures (
        job_name TEXT PRIMARY KEY,
        failure_id TEXT NOT NULL,
        error_type TEXT NOT NULL,
        error_code TEXT NOT NULL,
        sanitized_reason TEXT NOT NULL,
        action_required TEXT NOT NULL,
        retryable BOOLEAN NOT NULL,
        attempt_number BIGINT NOT NULL,
        next_action TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
)
