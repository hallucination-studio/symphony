from __future__ import annotations

from collections.abc import Iterable


POSTGRES_MIGRATION_STATEMENTS: Iterable[str] = (
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL
            )
            """,
            "ALTER TABLE users DROP COLUMN IF EXISTS linear_app_json",
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
                managed_run_profile TEXT NOT NULL DEFAULT 'default',
                project_binding_id TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS enrollment_tokens (
                token_hash TEXT PRIMARY KEY,
                runtime_group_id TEXT NOT NULL REFERENCES runtime_groups(id) ON DELETE CASCADE,
                conductor_id TEXT NOT NULL DEFAULT '',
                used BOOLEAN NOT NULL DEFAULT FALSE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS oauth_states (
                state TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                application_config_id TEXT NOT NULL DEFAULT '',
                application_config_version BIGINT NOT NULL DEFAULT 0,
                code_verifier_enc TEXT NOT NULL DEFAULT '',
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
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS public_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS enrollment_state TEXT NOT NULL DEFAULT 'pending'",
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS service_identity TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE conductors ADD COLUMN IF NOT EXISTS data_root TEXT NOT NULL DEFAULT ''",
            "CREATE UNIQUE INDEX IF NOT EXISTS conductors_public_id_unique ON conductors (public_id) WHERE public_id <> ''",
            "CREATE UNIQUE INDEX IF NOT EXISTS conductors_user_name_unique ON conductors (user_id, lower(name)) WHERE name <> ''",
            "ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS conductor_id TEXT NOT NULL DEFAULT ''",
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
                linear_project_id TEXT NOT NULL DEFAULT '',
                project_name TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                installation_id TEXT NOT NULL DEFAULT '',
                managed_run_profile TEXT NOT NULL DEFAULT 'default',
                process_status TEXT NOT NULL DEFAULT '',
                constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
                repo_source JSONB,
                state TEXT NOT NULL DEFAULT 'pending_ack',
                active BOOLEAN NOT NULL DEFAULT TRUE,
                config_version BIGINT NOT NULL DEFAULT 0,
                acknowledged_config_version BIGINT NOT NULL DEFAULT 0,
                candidate_installation_id TEXT NOT NULL DEFAULT '',
                candidate_agent_app_user_id TEXT NOT NULL DEFAULT '',
                candidate_config_version BIGINT NOT NULL DEFAULT 0,
                candidate_acknowledged_config_version BIGINT NOT NULL DEFAULT 0,
                label_id TEXT NOT NULL DEFAULT '',
                label_name TEXT NOT NULL DEFAULT '',
                replacement_conductor_id TEXT NOT NULL DEFAULT '',
                replacement_repo_source JSONB NOT NULL DEFAULT '{}'::jsonb,
                replacement_state TEXT NOT NULL DEFAULT '',
                replacement_binding_id TEXT NOT NULL DEFAULT '',
                error_code TEXT NOT NULL DEFAULT '',
                sanitized_reason TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL,
                UNIQUE(conductor_id)
            )
            """,
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS constraint_labels JSONB NOT NULL DEFAULT '[]'::jsonb",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS linear_project_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS project_name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS installation_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'pending_ack'",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS config_version BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS acknowledged_config_version BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS candidate_installation_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS candidate_agent_app_user_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS candidate_config_version BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS candidate_acknowledged_config_version BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS label_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS label_name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS replacement_conductor_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS replacement_repo_source JSONB NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS replacement_state TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS replacement_binding_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS error_code TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE project_bindings ADD COLUMN IF NOT EXISTS sanitized_reason TEXT NOT NULL DEFAULT ''",
            "CREATE UNIQUE INDEX IF NOT EXISTS project_bindings_conductor_unique ON project_bindings (conductor_id) WHERE active = TRUE",
            "CREATE UNIQUE INDEX IF NOT EXISTS project_bindings_project_unique ON project_bindings (user_id, linear_project_id) WHERE active = TRUE",
            """
            CREATE TABLE IF NOT EXISTS dispatches (
                id TEXT PRIMARY KEY,
                project_binding_id TEXT NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                issue_id TEXT NOT NULL,
                issue_identifier TEXT NOT NULL DEFAULT '',
                issue_title TEXT NOT NULL DEFAULT '',
                issue_description TEXT NOT NULL DEFAULT '',
                managed_run_intent JSONB NOT NULL DEFAULT '{}'::jsonb,
                intake_key TEXT NOT NULL DEFAULT '',
                workspace_id TEXT NOT NULL DEFAULT '',
                project_slug TEXT NOT NULL DEFAULT '',
                agent_app_user_id TEXT NOT NULL DEFAULT '',
                issue_delegate_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                leased_conductor_id TEXT REFERENCES conductors(id) ON DELETE SET NULL,
                leased_until TIMESTAMPTZ,
                fencing_token BIGINT NOT NULL DEFAULT 0,
                run_id TEXT NOT NULL DEFAULT '',
                parent_issue_id TEXT NOT NULL DEFAULT '',
                active_work_item_id TEXT NOT NULL DEFAULT '',
                managed_run_state TEXT NOT NULL DEFAULT '',
                plan_version BIGINT NOT NULL DEFAULT 0,
                backend_session_id TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ
            )
            """,
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_title TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_description TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS managed_run_intent JSONB NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS intake_key TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS agent_app_user_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS issue_delegate_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS parent_issue_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS active_work_item_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS managed_run_state TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS plan_version BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS backend_session_id TEXT NOT NULL DEFAULT ''",
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_intake_unique
            ON dispatches (project_binding_id, intake_key)
            WHERE intake_key <> ''
            """,
            "DROP INDEX IF EXISTS dispatches_binding_session_unique",
            "DROP INDEX IF EXISTS dispatches_binding_issue_empty_session_unique",
            "ALTER TABLE dispatches DROP COLUMN IF EXISTS agent_session_id",
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
            CREATE TABLE IF NOT EXISTS runtime_configs (
                runtime_group_id TEXT PRIMARY KEY,
                config_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS managed_run_views (
                runtime_group_id TEXT PRIMARY KEY,
                view_json JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_commands (
                id BIGSERIAL PRIMARY KEY,
                runtime_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                dedupe_key TEXT NOT NULL DEFAULT '',
                command_json JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                status TEXT NOT NULL DEFAULT 'queued',
                lease_expires_at TIMESTAMPTZ,
                fencing_token BIGINT NOT NULL DEFAULT 0,
                completed_at TIMESTAMPTZ,
                result_json JSONB NOT NULL DEFAULT '{}'::jsonb
            )
            """,
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS dedupe_key TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued'",
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ",
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0",
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ",
            "ALTER TABLE runtime_commands ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb",
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_commands_dedupe_unique ON runtime_commands (runtime_id, dedupe_key) WHERE dedupe_key <> ''",
            "CREATE INDEX IF NOT EXISTS runtime_commands_poll_index ON runtime_commands (runtime_id, status, id)",
            """
            CREATE TABLE IF NOT EXISTS linear_reconciliation_state (
                binding_id TEXT PRIMARY KEY,
                state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            "DROP TABLE IF EXISTS linear_poll_state",
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
