from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _pg_json_value


class PgLinearMixin:
    @asynccontextmanager
    async def linear_installation_token_lock(self, installation_id: str):
        async with self.pool.acquire() as connection:
            await connection.execute("SELECT pg_advisory_lock(hashtext($1))", installation_id)
            try:
                yield
            finally:
                await connection.execute("SELECT pg_advisory_unlock(hashtext($1))", installation_id)

    async def disconnect_workspace_installation(self, user_id: str, installation_id: str) -> None:
        await self.pool.execute(
            """
            UPDATE linear_workspace_installations
            SET active = FALSE, state = 'disconnected', updated_at = now()
            WHERE user_id = $1 AND id = $2 AND active = TRUE
            """,
            user_id,
            installation_id,
        )

    async def save_linear_application_config(self, config: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO linear_application_configs (
              id, user_id, source, version, client_id, client_secret_enc, callback_url, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
            ON CONFLICT (id) DO NOTHING
            """,
            str(config["id"]),
            str(config["user_id"]),
            str(config["source"]),
            int(config["version"]),
            str(config["client_id"]),
            str(config["client_secret_enc"]),
            str(config["callback_url"]),
            _pg_datetime(config.get("created_at")),
        )

    async def get_linear_application_config(self, config_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM linear_application_configs WHERE id = $1", config_id)
        return _linear_application_config(row) if row is not None else None

    async def list_linear_application_configs(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_application_configs WHERE user_id = $1 ORDER BY created_at, id",
            user_id,
        )
        return [_linear_application_config(row) for row in rows]

    async def set_linear_application_preference(self, user_id: str, config_id: str) -> None:
        await self.pool.execute(
            """
            INSERT INTO linear_application_preferences (user_id, config_id, updated_at)
            VALUES ($1,$2,now())
            ON CONFLICT (user_id) DO UPDATE SET config_id = EXCLUDED.config_id, updated_at = now()
            """,
            user_id,
            config_id,
        )

    async def get_linear_application_preference(self, user_id: str) -> str | None:
        value = await self.pool.fetchval(
            "SELECT config_id FROM linear_application_preferences WHERE user_id = $1",
            user_id,
        )
        return str(value) if value else None

    async def save_workspace_installation(self, installation: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO linear_workspace_installations (
              id, user_id, application_config_id, application_config_version, application_source,
              state, active, access_token_enc, refresh_token_enc, token_type, actor, scope, expires_at,
              linear_organization_id, organization_url_key, organization_name, app_user_id, projects_json,
              reconciliation_state, last_reconciliation_at, reconciliation_error_code,
              reconciliation_error, reconciliation_retry_count, reconciliation_next_retry_at,
              error_code, sanitized_reason, retryable,
              action_required, next_action, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$14,$15,$16,$17,
              $18::jsonb,$19,$20::timestamptz,$21,$22,$23,$24::timestamptz,$25,$26,$27,$28,$29,
              $30::timestamptz,$31::timestamptz
            )
            ON CONFLICT (id) DO UPDATE SET
              application_config_id = EXCLUDED.application_config_id,
              application_config_version = EXCLUDED.application_config_version,
              application_source = EXCLUDED.application_source,
              state = EXCLUDED.state, active = EXCLUDED.active,
              access_token_enc = EXCLUDED.access_token_enc,
              refresh_token_enc = EXCLUDED.refresh_token_enc,
              token_type = EXCLUDED.token_type, actor = EXCLUDED.actor,
              scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at,
              linear_organization_id = EXCLUDED.linear_organization_id,
              organization_url_key = EXCLUDED.organization_url_key,
              organization_name = EXCLUDED.organization_name,
              app_user_id = EXCLUDED.app_user_id, projects_json = EXCLUDED.projects_json,
              error_code = EXCLUDED.error_code,
              sanitized_reason = EXCLUDED.sanitized_reason, retryable = EXCLUDED.retryable,
              action_required = EXCLUDED.action_required, next_action = EXCLUDED.next_action,
              reconciliation_state = EXCLUDED.reconciliation_state,
              last_reconciliation_at = EXCLUDED.last_reconciliation_at,
              reconciliation_error_code = EXCLUDED.reconciliation_error_code,
              reconciliation_error = EXCLUDED.reconciliation_error,
              reconciliation_retry_count = EXCLUDED.reconciliation_retry_count,
              reconciliation_next_retry_at = EXCLUDED.reconciliation_next_retry_at,
              updated_at = EXCLUDED.updated_at
            """,
            *_installation_values(installation),
        )

    async def update_workspace_installation_reconciliation(
        self,
        user_id: str,
        installation_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            UPDATE linear_workspace_installations SET
              reconciliation_state = $3,
              last_reconciliation_at = $4::timestamptz,
              reconciliation_error_code = $5,
              reconciliation_error = $6,
              reconciliation_retry_count = $7,
              reconciliation_next_retry_at = $8::timestamptz,
              updated_at = $9::timestamptz
            WHERE user_id = $1 AND id = $2 AND active = TRUE
              AND ($10::timestamptz IS NULL OR updated_at = $10::timestamptz)
            RETURNING *
            """,
            user_id,
            installation_id,
            str(changes.get("reconciliation_state") or "pending"),
            _pg_datetime(changes.get("last_reconciliation_at")),
            str(changes.get("reconciliation_error_code") or ""),
            str(changes.get("reconciliation_error") or ""),
            int(changes.get("reconciliation_retry_count") or 0),
            _pg_datetime(changes.get("reconciliation_next_retry_at")),
            _pg_datetime(changes.get("updated_at")),
            _pg_datetime(changes.get("expected_updated_at")),
        )
        return _workspace_installation(row) if row is not None else None

    async def list_workspace_installations(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_workspace_installations WHERE user_id = $1 ORDER BY created_at, id",
            user_id,
        )
        return [_workspace_installation(row) for row in rows]

    async def activate_workspace_installation(self, user_id: str, installation_id: str) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE linear_workspace_installations SET active = FALSE, state = 'retired', updated_at = now() WHERE user_id = $1 AND active = TRUE",
                    user_id,
                )
                await connection.execute(
                    "UPDATE linear_workspace_installations SET active = TRUE, state = 'ready', updated_at = now() WHERE user_id = $1 AND id = $2",
                    user_id,
                    installation_id,
                )

    async def get_active_workspace_installation(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM linear_workspace_installations WHERE user_id = $1 AND active = TRUE",
            user_id,
        )
        return _workspace_installation(row) if row is not None else None

    async def get_candidate_workspace_installation(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT * FROM linear_workspace_installations
            WHERE user_id = $1 AND active = FALSE AND state IN ('accepted', 'draining', 'preparing', 'failed')
            ORDER BY created_at DESC, id DESC LIMIT 1
            """,
            user_id,
        )
        return _workspace_installation(row) if row is not None else None

    async def find_active_workspace_installation(self, linear_organization_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM linear_workspace_installations WHERE linear_organization_id = $1 AND active = TRUE",
            linear_organization_id,
        )
        return _workspace_installation(row) if row is not None else None

    async def list_active_workspace_installations(self) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_workspace_installations WHERE active = TRUE ORDER BY user_id"
        )
        return [_workspace_installation(row) for row in rows]

    async def replace_selected_linear_projects(self, user_id: str, projects: list[dict[str, Any]]) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM linear_selected_projects WHERE user_id = $1", user_id)
                for project in projects:
                    await connection.execute(
                        """
                        INSERT INTO linear_selected_projects (
                          user_id, linear_organization_id, linear_project_id,
                          project_slug, project_name, access_state, updated_at
                        ) VALUES ($1,$2,$3,$4,$5,$6,now())
                        """,
                        user_id,
                        str(project["linear_organization_id"]),
                        str(project["linear_project_id"]),
                        str(project["project_slug"]),
                        str(project["project_name"]),
                        str(project["access_state"]),
                    )

    async def list_selected_linear_projects(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_selected_projects WHERE user_id = $1 ORDER BY linear_project_id",
            user_id,
        )
        return [
            {
                "user_id": str(row["user_id"]),
                "linear_organization_id": str(row["linear_organization_id"]),
                "linear_project_id": str(row["linear_project_id"]),
                "project_slug": str(row["project_slug"]),
                "project_name": str(row["project_name"]),
                "access_state": str(row["access_state"]),
            }
            for row in rows
        ]

    async def save_oauth_state(self, state: str, record: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO oauth_states (
              state, workspace_id, application_config_id, application_config_version,
              code_verifier_enc, expires_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,now())
            ON CONFLICT (state) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              application_config_id = EXCLUDED.application_config_id,
              application_config_version = EXCLUDED.application_config_version,
              code_verifier_enc = EXCLUDED.code_verifier_enc,
              expires_at = EXCLUDED.expires_at,
              created_at = now()
            """,
            state,
            str(record["workspace_id"]),
            str(record["application_config_id"]),
            int(record["application_config_version"]),
            str(record["code_verifier_enc"]),
            _pg_datetime(record.get("expires_at")),
        )

    async def consume_oauth_state(self, state: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            DELETE FROM oauth_states WHERE state = $1 AND expires_at >= now()
            RETURNING workspace_id, application_config_id, application_config_version,
              code_verifier_enc, expires_at
            """,
            state,
        )
        if row is None:
            return None
        return {
            "state": state,
            "workspace_id": str(row["workspace_id"]),
            "application_config_id": str(row["application_config_id"]),
            "application_config_version": int(row["application_config_version"]),
            "code_verifier_enc": str(row["code_verifier_enc"]),
            "expires_at": row["expires_at"].isoformat(),
        }

    async def insert_proxy_audit_event(self, event: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO proxy_audit_events (runtime_id, workspace_id, operation_name, allowed, reason, metadata_json, created_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
            """,
            event.get("runtime_id"),
            str(event.get("workspace_id") or ""),
            event.get("operation_name"),
            bool(event.get("allowed")),
            str(event.get("reason") or ""),
            _pg_json(event.get("metadata") or {}),
            _pg_datetime(event.get("timestamp") or event.get("created_at") or ""),
        )


def _linear_application_config(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "user_id": str(row["user_id"]),
        "source": str(row["source"]),
        "version": int(row["version"]),
        "client_id": str(row["client_id"]),
        "client_secret_enc": str(row["client_secret_enc"]),
        "callback_url": str(row["callback_url"]),
        "created_at": row["created_at"].isoformat(),
    }


def _installation_values(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(row["id"]), str(row["user_id"]), str(row["application_config_id"]),
        int(row["application_config_version"]), str(row["application_source"]), str(row["state"]),
        bool(row.get("active")), str(row.get("access_token_enc") or ""), str(row.get("refresh_token_enc") or ""),
        str(row.get("token_type") or ""), str(row.get("actor") or ""),
        _pg_json(row.get("scope") or []), _pg_datetime(row.get("expires_at")),
        str(row.get("linear_organization_id") or ""), str(row.get("organization_url_key") or ""),
        str(row.get("organization_name") or ""), str(row.get("app_user_id") or ""),
        _pg_json(row.get("projects") or []),
        str(row.get("reconciliation_state") or "pending"), _pg_datetime(row.get("last_reconciliation_at")),
        str(row.get("reconciliation_error_code") or ""), str(row.get("reconciliation_error") or ""),
        int(row.get("reconciliation_retry_count") or 0), _pg_datetime(row.get("reconciliation_next_retry_at")),
        str(row.get("error_code") or ""), str(row.get("sanitized_reason") or ""), bool(row.get("retryable")),
        str(row.get("action_required") or ""), str(row.get("next_action") or ""),
        _pg_datetime(row.get("created_at")), _pg_datetime(row.get("updated_at")),
    )


def _workspace_installation(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]), "user_id": str(row["user_id"]),
        "application_config_id": str(row["application_config_id"]),
        "application_config_version": int(row["application_config_version"]),
        "application_source": str(row["application_source"]), "state": str(row["state"]),
        "active": bool(row["active"]), "access_token_enc": str(row["access_token_enc"]),
        "refresh_token_enc": str(row["refresh_token_enc"]), "token_type": str(row["token_type"]),
        "actor": str(row["actor"]),
        "scope": _pg_json_value(row["scope"], []),
        "expires_at": row["expires_at"].isoformat() if row["expires_at"] is not None else None,
        "linear_organization_id": str(row["linear_organization_id"]),
        "organization_url_key": str(row["organization_url_key"]), "organization_name": str(row["organization_name"]),
        "app_user_id": str(row["app_user_id"]),
        "projects": _pg_json_value(row["projects_json"], []),
        "reconciliation_state": str(row["reconciliation_state"]),
        "last_reconciliation_at": (
            row["last_reconciliation_at"].isoformat() if row["last_reconciliation_at"] is not None else None
        ),
        "reconciliation_error_code": str(row["reconciliation_error_code"]),
        "reconciliation_error": str(row["reconciliation_error"]),
        "reconciliation_retry_count": int(row["reconciliation_retry_count"]),
        "reconciliation_next_retry_at": (
            row["reconciliation_next_retry_at"].isoformat()
            if row["reconciliation_next_retry_at"] is not None else None
        ),
        "error_code": str(row["error_code"]),
        "sanitized_reason": str(row["sanitized_reason"]), "retryable": bool(row["retryable"]),
        "action_required": str(row["action_required"]), "next_action": str(row["next_action"]),
        "created_at": row["created_at"].isoformat(), "updated_at": row["updated_at"].isoformat(),
    }
