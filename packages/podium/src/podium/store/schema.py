from __future__ import annotations

SQLITE_SCHEMA_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY
    )""",
    """CREATE TABLE IF NOT EXISTS reconciliation_state (
        binding_id TEXT PRIMARY KEY REFERENCES bindings(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS issue_observations (
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL,
        delegated INTEGER NOT NULL CHECK (delegated IN (0, 1)),
        delegation_epoch INTEGER NOT NULL CHECK (delegation_epoch >= 0),
        PRIMARY KEY (binding_id, issue_id)
    )""",
    """CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        intake_key TEXT NOT NULL,
        UNIQUE (binding_id, intake_key)
    )""",
    """CREATE TABLE IF NOT EXISTS linear_installations (
        installation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        app_user_id TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
        CHECK (
            (access_token IS NULL AND refresh_token IS NULL AND expires_at IS NULL
             AND status = 'disconnected')
            OR
            (access_token IS NOT NULL AND refresh_token IS NOT NULL AND expires_at IS NOT NULL
             AND length(access_token) > 0 AND length(refresh_token) > 0
             AND status = 'connected')
        )
    )""",
)

SQLITE_FEASIBILITY_SCHEMA = ";\n".join(SQLITE_SCHEMA_STATEMENTS) + ";\n"

LINEAR_METADATA_STATEMENTS = (
    "ALTER TABLE linear_installations RENAME TO linear_installations_v1",
    """CREATE TABLE linear_installations (
        installation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        organization_name TEXT NOT NULL DEFAULT '',
        app_user_id TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        status TEXT NOT NULL CHECK (status IN (
            'connected', 'disconnected',
            'credentials_missing_for_existing_installation', 'reauthorization_required'
        )),
        last_verified_at INTEGER,
        error_code TEXT,
        CHECK (
            (access_token IS NULL AND refresh_token IS NULL AND status != 'connected')
            OR
            (access_token IS NOT NULL AND refresh_token IS NOT NULL AND expires_at IS NOT NULL
             AND length(access_token) > 0 AND length(refresh_token) > 0
             AND status = 'connected')
        )
    )""",
    """INSERT INTO linear_installations (
        installation_id, organization_id, app_user_id, granted_scopes,
        access_token, refresh_token, expires_at, status
    ) SELECT installation_id, organization_id, app_user_id,
        '["' || replace(granted_scopes, ',', '","') || '"]',
        access_token, refresh_token, expires_at, status
    FROM linear_installations_v1""",
    "DROP TABLE linear_installations_v1",
    """CREATE TABLE linear_projects (
        project_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES linear_installations(installation_id)
            ON DELETE CASCADE,
        organization_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1))
    )""",
)

BINDING_REPORT_STATEMENTS = (
    """CREATE TABLE conductor_bindings (
        binding_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES linear_projects(project_id) ON DELETE CASCADE,
        conductor_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    )""",
    """CREATE UNIQUE INDEX active_binding_project_unique
    ON conductor_bindings(project_id) WHERE active = 1""",
    """CREATE UNIQUE INDEX active_binding_conductor_unique
    ON conductor_bindings(conductor_id) WHERE active = 1""",
    """CREATE TABLE runtime_reports (
        binding_id TEXT PRIMARY KEY REFERENCES conductor_bindings(binding_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        instance_id TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 128),
        status TEXT NOT NULL CHECK (status IN ('starting', 'ready', 'degraded', 'stopped')),
        heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= 0),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128)
    )""",
)
