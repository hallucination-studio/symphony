from __future__ import annotations

from collections.abc import Iterable


LINEAR_RECONCILIATION_STATEMENTS: Iterable[str] = (
    """
    CREATE TABLE IF NOT EXISTS linear_issue_observations (
        binding_id TEXT NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL DEFAULT '',
        delegated BOOLEAN NOT NULL DEFAULT FALSE,
        delegation_epoch BIGINT NOT NULL DEFAULT 0,
        last_updated_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(binding_id, issue_id)
    )
    """,
)
