from __future__ import annotations

from collections.abc import Iterable


LINEAR_INSTALLATION_STATEMENTS: Iterable[str] = (
    """
    CREATE TABLE IF NOT EXISTS linear_application_configs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        version BIGINT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret_enc TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(user_id, source, version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS linear_application_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        config_id TEXT NOT NULL REFERENCES linear_application_configs(id) ON DELETE RESTRICT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS linear_workspace_installations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        application_config_id TEXT NOT NULL REFERENCES linear_application_configs(id) ON DELETE RESTRICT,
        application_config_version BIGINT NOT NULL,
        application_source TEXT NOT NULL,
        state TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        access_token_enc TEXT NOT NULL,
        refresh_token_enc TEXT NOT NULL,
        token_type TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        scope JSONB NOT NULL,
        expires_at TIMESTAMPTZ,
        linear_organization_id TEXT NOT NULL DEFAULT '',
        organization_url_key TEXT NOT NULL DEFAULT '',
        organization_name TEXT NOT NULL DEFAULT '',
        app_user_id TEXT NOT NULL DEFAULT '',
        projects_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        reconciliation_state TEXT NOT NULL DEFAULT 'pending',
        last_reconciliation_at TIMESTAMPTZ,
        reconciliation_error TEXT NOT NULL DEFAULT '',
        reconciliation_retry_count BIGINT NOT NULL DEFAULT 0,
        error_code TEXT NOT NULL DEFAULT '',
        sanitized_reason TEXT NOT NULL DEFAULT '',
        retryable BOOLEAN NOT NULL DEFAULT FALSE,
        action_required TEXT NOT NULL DEFAULT '',
        next_action TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
    )
    """,
    "ALTER TABLE linear_workspace_installations ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE linear_workspace_installations ADD COLUMN IF NOT EXISTS reconciliation_state TEXT NOT NULL DEFAULT 'pending'",
    "ALTER TABLE linear_workspace_installations ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ",
    "ALTER TABLE linear_workspace_installations ADD COLUMN IF NOT EXISTS reconciliation_error TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE linear_workspace_installations ADD COLUMN IF NOT EXISTS reconciliation_retry_count BIGINT NOT NULL DEFAULT 0",
    """
    CREATE TABLE IF NOT EXISTS linear_selected_projects (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        linear_organization_id TEXT NOT NULL,
        linear_project_id TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        project_name TEXT NOT NULL,
        access_state TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, linear_project_id)
    )
    """,
    "ALTER TABLE linear_application_configs DROP COLUMN IF EXISTS webhook_secret_enc",
    "ALTER TABLE linear_application_configs DROP COLUMN IF EXISTS webhook_url",
    "ALTER TABLE linear_workspace_installations DROP COLUMN IF EXISTS supports_agent_sessions",
    "ALTER TABLE linear_workspace_installations DROP COLUMN IF EXISTS webhook_state",
    "ALTER TABLE linear_workspace_installations DROP COLUMN IF EXISTS last_webhook_at",
    "DROP TABLE IF EXISTS linear_webhook_deliveries",
    """
    CREATE UNIQUE INDEX IF NOT EXISTS linear_workspace_installations_active_unique
    ON linear_workspace_installations (user_id)
    WHERE active = TRUE
    """,
    "ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS application_config_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS application_config_version BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS code_verifier_enc TEXT NOT NULL DEFAULT ''",
)
