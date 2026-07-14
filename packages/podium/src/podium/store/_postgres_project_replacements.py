from __future__ import annotations

from typing import Any

from ._postgres_dispatch import _upsert_project_binding_on
from ._postgres_project_unbind import (
    lock_advisory_keys,
    project_selection_lock_key,
    target_lock_key,
)
from ._postgres_records import _pg_datetime, _record_to_project_binding


class PgProjectReplacementsMixin:
    async def create_project_binding(
        self,
        binding: dict[str, Any],
        *,
        replacement_owner_binding_id: str = "",
    ) -> tuple[dict[str, Any] | None, str]:
        conductor_id = str(binding["conductor_id"])
        user_id = str(binding["user_id"])
        linear_project_id = str(binding.get("linear_project_id") or "")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await lock_advisory_keys(
                    connection,
                    str(binding["id"]),
                    project_selection_lock_key(user_id),
                    target_lock_key(conductor_id),
                    f"project-binding-project:{user_id}:{linear_project_id}",
                )
                selected = await connection.fetchrow(
                    """
                    SELECT linear_project_id FROM linear_selected_projects
                    WHERE user_id = $1 AND linear_project_id = $2
                    FOR UPDATE
                    """,
                    user_id,
                    linear_project_id,
                )
                if selected is None:
                    return None, "linear_project_not_selected"
                reservation = await connection.fetchrow(
                    """
                    SELECT id FROM project_bindings
                    WHERE replacement_conductor_id = $1
                      AND replacement_state IN ('pending_unbind', 'pending_ack', 'failed')
                    ORDER BY config_version DESC, updated_at DESC, id DESC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    conductor_id,
                )
                if reservation is not None and str(reservation["id"]) != replacement_owner_binding_id:
                    return None, "replacement_conductor_reserved"
                conductor_owner = await connection.fetchrow(
                    "SELECT id FROM project_bindings WHERE conductor_id = $1 AND active = TRUE FOR UPDATE",
                    conductor_id,
                )
                if conductor_owner is not None:
                    return None, "conductor_already_bound"
                project_owner = await connection.fetchrow(
                    """
                    SELECT id FROM project_bindings
                    WHERE user_id = $1 AND linear_project_id = $2 AND active = TRUE
                    FOR UPDATE
                    """,
                    user_id,
                    linear_project_id,
                )
                if project_owner is not None:
                    return None, "linear_project_already_bound"
                created = await _upsert_project_binding_on(
                    connection,
                    binding,
                    require_inactive=True,
                )
                if created is None:
                    return None, "conductor_already_bound"
        return created, ""

    async def transition_project_replacement(
        self,
        binding_id: str,
        *,
        replacement_conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        expected_updated_at: str,
        expected_replacement_binding_id: str,
        replacement_state: str,
        replacement_binding_id: str,
        error_code: str,
        sanitized_reason: str,
        updated_at: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            UPDATE project_bindings SET
              replacement_state = $7,
              replacement_binding_id = $8,
              error_code = $9,
              sanitized_reason = $10,
              updated_at = $11::timestamptz
            WHERE id = $1
              AND replacement_conductor_id = $2
              AND replacement_state = $3
              AND config_version = $4
              AND updated_at = $5::timestamptz
              AND replacement_binding_id = $6
            RETURNING *
            """,
            binding_id,
            replacement_conductor_id,
            expected_state,
            expected_config_version,
            _pg_datetime(expected_updated_at),
            expected_replacement_binding_id,
            replacement_state,
            replacement_binding_id,
            error_code,
            sanitized_reason,
            _pg_datetime(updated_at),
        )
        return _record_to_project_binding(row) if row is not None else None

    async def get_project_binding_replacement_for_conductor(
        self,
        user_id: str,
        conductor_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT * FROM project_bindings
            WHERE user_id = $1 AND replacement_conductor_id = $2
            ORDER BY
              CASE WHEN replacement_state IN ('pending_unbind', 'pending_ack', 'failed') THEN 0 ELSE 1 END,
              config_version DESC, updated_at DESC, id DESC
            LIMIT 1
            """,
            user_id,
            conductor_id,
        )
        return _record_to_project_binding(row) if row is not None else None

    async def get_project_binding_replacement_for_new_binding(
        self,
        binding_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT * FROM project_bindings
            WHERE replacement_binding_id = $1
              AND replacement_state IN ('pending_ack', 'failed')
            ORDER BY config_version DESC, updated_at DESC, id DESC
            LIMIT 1
            """,
            binding_id,
        )
        return _record_to_project_binding(row) if row is not None else None

    async def get_project_replacement(
        self,
        user_id: str,
        old_conductor_id: str,
        linear_project_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT * FROM project_bindings
            WHERE user_id = $1
              AND conductor_id = $2
              AND linear_project_id = $3
              AND replacement_conductor_id <> ''
            ORDER BY config_version DESC, updated_at DESC, id DESC
            LIMIT 1
            """,
            user_id,
            old_conductor_id,
            linear_project_id,
        )
        return _record_to_project_binding(row) if row is not None else None
