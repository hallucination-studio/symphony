from __future__ import annotations

from collections.abc import Iterable


class PgMigrator:
    """Handwritten Podium PostgreSQL schema."""

    def statements(self) -> Iterable[str]:
        return (
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                linear_app_json JSONB
            )
            """,
            "CREATE SEQUENCE IF NOT EXISTS podium_user_id_seq",
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_groups (
                id TEXT PRIMARY KEY,
                linear_workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                linear_agent_app_user_id TEXT NOT NULL DEFAULT '',
                pipeline_profile TEXT NOT NULL DEFAULT 'default',
                project_binding_id TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS enrollment_tokens (
                token_hash TEXT PRIMARY KEY,
                runtime_group_id TEXT NOT NULL REFERENCES runtime_groups(id) ON DELETE CASCADE,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS linear_installations (
                workspace_id TEXT PRIMARY KEY,
                access_token_enc TEXT NOT NULL,
                scope JSONB,
                actor TEXT NOT NULL DEFAULT '',
                expires_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE linear_installations ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT ''",
            """
            CREATE TABLE IF NOT EXISTS oauth_states (
                state TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS conductors (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                hostname TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL DEFAULT '',
                version TEXT NOT NULL DEFAULT '',
                conductor_id TEXT NOT NULL DEFAULT '',
                runtime_group_id TEXT NOT NULL DEFAULT '',
                runtime_token_hash TEXT NOT NULL,
                proxy_token_hash TEXT NOT NULL,
                disabled BOOLEAN NOT NULL DEFAULT FALSE,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL,
                last_report_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS runtime_group_id TEXT NOT NULL DEFAULT ''",
            """
            CREATE TABLE IF NOT EXISTS runtime_presence (
                runtime_id TEXT PRIMARY KEY REFERENCES conductors(id) ON DELETE CASCADE,
                last_seen_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS project_bindings (
                id TEXT PRIMARY KEY,
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                linear_project TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                pipeline_profile TEXT NOT NULL DEFAULT 'default',
                process_status TEXT NOT NULL DEFAULT '',
                constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
                repo_source JSONB,
                updated_at TIMESTAMPTZ NOT NULL,
                UNIQUE(conductor_id, instance_id)
            )
            """,
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb",
            """
            CREATE TABLE IF NOT EXISTS dispatches (
                id TEXT PRIMARY KEY,
                project_binding_id TEXT NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                issue_id TEXT NOT NULL,
                issue_identifier TEXT NOT NULL DEFAULT '',
                issue_title TEXT NOT NULL DEFAULT '',
                issue_description TEXT NOT NULL DEFAULT '',
                pipeline_intent JSONB NOT NULL DEFAULT '{}'::jsonb,
                workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_session_id TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                issue_delegate_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                leased_conductor_id TEXT REFERENCES conductors(id) ON DELETE SET NULL,
                leased_until TIMESTAMPTZ,
                fencing_token BIGINT NOT NULL DEFAULT 0,
                graph_id TEXT NOT NULL DEFAULT '',
                node_id TEXT NOT NULL DEFAULT '',
                attempt_id TEXT NOT NULL DEFAULT '',
                mode TEXT NOT NULL DEFAULT '',
                attempt_status TEXT NOT NULL DEFAULT '',
                graph_revision BIGINT NOT NULL DEFAULT 0,
                policy_revision BIGINT NOT NULL DEFAULT 0,
                lease_id TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_title TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_description TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS pipeline_intent JSONB NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS agent_app_user_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_delegate_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS graph_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS node_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS attempt_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS attempt_status TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS graph_revision BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS policy_revision BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS lease_id TEXT NOT NULL DEFAULT ''",
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_session_unique
            ON dispatches (project_binding_id, agent_session_id)
            WHERE agent_session_id <> ''
            """,
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_issue_empty_session_unique
            ON dispatches (project_binding_id, issue_id)
            WHERE agent_session_id = ''
            """,
            """
            CREATE TABLE IF NOT EXISTS metrics_snapshots (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                captured_at TIMESTAMPTZ NOT NULL,
                metrics_json JSONB NOT NULL,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS instance_log_tails (
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                tail_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY(conductor_id, instance_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS log_fetch_results (
                request_id TEXT PRIMARY KEY,
                result_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_configs (
                runtime_group_id TEXT PRIMARY KEY,
                config_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS pipeline_views (
                runtime_group_id TEXT PRIMARY KEY,
                view_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_commands (
                id BIGSERIAL PRIMARY KEY,
                runtime_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                command_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS linear_poll_state (
                binding_id TEXT PRIMARY KEY,
                cursor_text TEXT NOT NULL DEFAULT '',
                last_success_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                last_issue_count BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS onboarding_state (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                completed_steps_json JSONB NOT NULL,
                metadata_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS smoke_results (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                result_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS proxy_audit_events (
                id BIGSERIAL PRIMARY KEY,
                runtime_id TEXT,
                workspace_id TEXT NOT NULL DEFAULT '',
                operation_name TEXT,
                allowed BOOLEAN NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL
            )
            """,
        )
