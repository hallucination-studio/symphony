from __future__ import annotations

from collections.abc import Iterable


LINEAR_RECONCILIATION_STATEMENTS: Iterable[str] = (
    "ALTER TABLE linear_reconciliation_state ADD COLUMN IF NOT EXISTS state_json JSONB NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE linear_reconciliation_state DROP COLUMN IF EXISTS cursor_text",
    "ALTER TABLE linear_reconciliation_state DROP COLUMN IF EXISTS last_success_at",
    "ALTER TABLE linear_reconciliation_state DROP COLUMN IF EXISTS last_error",
    "ALTER TABLE linear_reconciliation_state DROP COLUMN IF EXISTS last_issue_count",
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
