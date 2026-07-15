from __future__ import annotations

SQLITE_FEASIBILITY_SCHEMA = """
CREATE TABLE bindings (
    id TEXT PRIMARY KEY
);
CREATE TABLE reconciliation_state (
    binding_id TEXT PRIMARY KEY REFERENCES bindings(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL
);
CREATE TABLE issue_observations (
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL,
    delegated INTEGER NOT NULL CHECK (delegated IN (0, 1)),
    delegation_epoch INTEGER NOT NULL CHECK (delegation_epoch >= 0),
    PRIMARY KEY (binding_id, issue_id)
);
CREATE TABLE dispatches (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    intake_key TEXT NOT NULL,
    UNIQUE (binding_id, intake_key)
);
CREATE TABLE linear_installations (
    installation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    app_user_id TEXT NOT NULL,
    granted_scopes TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
    CHECK (
        (access_token IS NULL AND refresh_token IS NULL AND expires_at IS NULL AND status = 'disconnected')
        OR
        (access_token IS NOT NULL AND refresh_token IS NOT NULL AND expires_at IS NOT NULL
         AND length(access_token) > 0 AND length(refresh_token) > 0 AND status = 'connected')
    )
);
"""
