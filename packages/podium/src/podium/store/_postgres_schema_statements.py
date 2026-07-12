from __future__ import annotations

from collections.abc import Iterable


POSTGRES_SCHEMA_STATEMENTS: Iterable[str] = (
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL
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
                name TEXT NOT NULL DEFAULT '',
                public_id TEXT NOT NULL DEFAULT '',
                enrollment_state TEXT NOT NULL DEFAULT 'pending',
                service_identity TEXT NOT NULL DEFAULT '',
                data_root TEXT NOT NULL DEFAULT '',
                runtime_token_hash TEXT NOT NULL,
                proxy_token_hash TEXT NOT NULL,
                disabled BOOLEAN NOT NULL DEFAULT FALSE,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL,
                last_report_at TIMESTAMPTZ
            )
            """,
            "CREATE UNIQUE INDEX IF NOT EXISTS conductors_public_id_unique ON conductors (public_id) WHERE public_id <> ''",
            "CREATE UNIQUE INDEX IF NOT EXISTS conductors_user_name_unique ON conductors (user_id, lower(name)) WHERE name <> ''",
            """
            CREATE TABLE IF NOT EXISTS enrollment_tokens (
                token_hash TEXT PRIMARY KEY,
                conductor_id TEXT NOT NULL REFERENCES conductors(id) ON DELETE CASCADE,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
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
                blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb,
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
            """
            CREATE UNIQUE INDEX IF NOT EXISTS dispatches_binding_intake_unique
            ON dispatches (project_binding_id, intake_key)
            WHERE intake_key <> ''
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
            CREATE TABLE IF NOT EXISTS managed_run_views (
                conductor_id TEXT PRIMARY KEY REFERENCES conductors(id) ON DELETE CASCADE,
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
            "CREATE UNIQUE INDEX IF NOT EXISTS runtime_commands_dedupe_unique ON runtime_commands (runtime_id, dedupe_key) WHERE dedupe_key <> ''",
            "CREATE INDEX IF NOT EXISTS runtime_commands_poll_index ON runtime_commands (runtime_id, status, id)",
            """
            CREATE TABLE IF NOT EXISTS linear_reconciliation_state (
                binding_id TEXT PRIMARY KEY,
                state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
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
        reconciliation_error_code TEXT NOT NULL DEFAULT '',
        reconciliation_error TEXT NOT NULL DEFAULT '',
        reconciliation_retry_count BIGINT NOT NULL DEFAULT 0,
        reconciliation_next_retry_at TIMESTAMPTZ,
        error_code TEXT NOT NULL DEFAULT '',
        sanitized_reason TEXT NOT NULL DEFAULT '',
        retryable BOOLEAN NOT NULL DEFAULT FALSE,
        action_required TEXT NOT NULL DEFAULT '',
        next_action TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
    )
    """,
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
            """
    CREATE UNIQUE INDEX IF NOT EXISTS linear_workspace_installations_active_unique
    ON linear_workspace_installations (user_id)
    WHERE active = TRUE
    """,
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
