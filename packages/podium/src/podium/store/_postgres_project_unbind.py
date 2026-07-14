from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _record_to_project_binding


class PgProjectUnbindMixin:
    async def claim_project_unbind(
        self,
        binding_id: str,
        user_id: str,
        conductor_id: str,
        *,
        replacement_conductor_id: str = "",
        replacement_repo_source: dict[str, Any] | None = None,
        updated_at: str,
    ) -> tuple[dict[str, Any] | None, bool]:
        keys = [binding_id]
        if replacement_conductor_id:
            keys.append(target_lock_key(replacement_conductor_id))
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await lock_advisory_keys(connection, *keys)
                current = await _locked_binding(
                    connection,
                    binding_id,
                    user_id,
                    conductor_id,
                )
                if current is None or not current["active"]:
                    return current, False
                pending = await _claim_pending_unbind(
                    connection,
                    current,
                    replacement_conductor_id=replacement_conductor_id,
                    replacement_repo_source=replacement_repo_source or {},
                    updated_at=updated_at,
                )
                if pending is None:
                    return current, False
                command_id = await _insert_unconfigure_command(
                    connection,
                    conductor_id,
                    pending,
                )
        return pending, command_id is not None

    async def complete_project_unbind(
        self,
        binding_id: str,
        *,
        conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        acknowledged_config_version: int,
        updated_at: str,
    ) -> dict[str, Any] | None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await lock_advisory_keys(connection, binding_id)
                row = await connection.fetchrow(
                    """
                    UPDATE project_bindings SET
                      state = 'unbound', active = FALSE,
                      acknowledged_config_version = $5, process_status = '',
                      error_code = '', sanitized_reason = '',
                      updated_at = $6::timestamptz
                    WHERE id = $1 AND conductor_id = $2
                      AND state = $3 AND config_version = $4
                    RETURNING *
                    """,
                    binding_id,
                    conductor_id,
                    expected_state,
                    expected_config_version,
                    acknowledged_config_version,
                    _pg_datetime(updated_at),
                )
        return _record_to_project_binding(row) if row is not None else None

    async def record_project_unbind_error(
        self,
        binding_id: str,
        *,
        conductor_id: str,
        expected_state: str,
        expected_config_version: int,
        error_code: str,
        sanitized_reason: str,
        updated_at: str,
    ) -> dict[str, Any] | None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await lock_advisory_keys(connection, binding_id)
                row = await connection.fetchrow(
                    """
                    UPDATE project_bindings SET
                      error_code = $5, sanitized_reason = $6,
                      updated_at = $7::timestamptz
                    WHERE id = $1 AND conductor_id = $2
                      AND state = $3 AND config_version = $4
                    RETURNING *
                    """,
                    binding_id,
                    conductor_id,
                    expected_state,
                    expected_config_version,
                    error_code,
                    sanitized_reason,
                    _pg_datetime(updated_at),
                )
        return _record_to_project_binding(row) if row is not None else None


async def _locked_binding(
    connection: Any,
    binding_id: str,
    user_id: str,
    conductor_id: str,
) -> dict[str, Any] | None:
    row = await connection.fetchrow(
        """
        SELECT * FROM project_bindings
        WHERE id = $1 AND user_id = $2 AND conductor_id = $3
        FOR UPDATE
        """,
        binding_id,
        user_id,
        conductor_id,
    )
    return _record_to_project_binding(row) if row is not None else None


async def _claim_pending_unbind(
    connection: Any,
    current: dict[str, Any],
    *,
    replacement_conductor_id: str,
    replacement_repo_source: dict[str, Any],
    updated_at: str,
) -> dict[str, Any] | None:
    existing_target = str(current.get("replacement_conductor_id") or "")
    if replacement_conductor_id and existing_target not in {"", replacement_conductor_id}:
        return None
    if replacement_conductor_id and not existing_target:
        target_active = await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM project_bindings WHERE conductor_id = $1 AND active = TRUE)",
            replacement_conductor_id,
        )
        if target_active:
            return None
    version_increment = current["state"] != "pending_unbind"
    if version_increment and await _has_open_dispatches(connection, str(current["id"])):
        return None
    row = await connection.fetchrow(
        """
        UPDATE project_bindings SET
          state = 'pending_unbind',
          config_version = config_version + CASE WHEN $4 THEN 1 ELSE 0 END,
          replacement_conductor_id = CASE WHEN $2 <> '' THEN $2 ELSE replacement_conductor_id END,
          replacement_repo_source = CASE WHEN $2 <> '' THEN $3::jsonb ELSE replacement_repo_source END,
          replacement_state = CASE WHEN $2 <> '' THEN 'pending_unbind' ELSE replacement_state END,
          replacement_binding_id = CASE WHEN $2 <> '' THEN '' ELSE replacement_binding_id END,
          error_code = '', sanitized_reason = '', updated_at = $5::timestamptz
        WHERE id = $1
        RETURNING *
        """,
        str(current["id"]),
        replacement_conductor_id,
        _pg_json(replacement_repo_source),
        version_increment,
        _pg_datetime(updated_at),
    )
    return _record_to_project_binding(row)


async def _has_open_dispatches(connection: Any, binding_id: str) -> bool:
    count = await connection.fetchval(
        """
        SELECT count(*) FROM dispatches
        WHERE project_binding_id = $1
          AND status NOT IN ('completed', 'failed', 'cancelled', 'canceled')
        """,
        binding_id,
    )
    return bool(count)


async def _insert_unconfigure_command(
    connection: Any,
    conductor_id: str,
    binding: dict[str, Any],
) -> int | None:
    binding_id = str(binding["id"])
    config_version = int(binding["config_version"])
    command = {
        "type": "project.unconfigure",
        "binding_id": binding_id,
        "config_version": config_version,
        "delete_repository": False,
    }
    row = await connection.fetchrow(
        """
        INSERT INTO runtime_commands (runtime_id, dedupe_key, command_json, created_at)
        VALUES ($1,$2,$3::jsonb,now())
        ON CONFLICT (runtime_id, dedupe_key) WHERE dedupe_key <> '' DO NOTHING
        RETURNING id
        """,
        conductor_id,
        f"project.unconfigure:{binding_id}:{config_version}",
        _pg_json(command),
    )
    return int(row["id"]) if row is not None else None


def target_lock_key(conductor_id: str) -> str:
    return f"project-binding-target:{conductor_id}"


def project_selection_lock_key(user_id: str) -> str:
    return f"linear-project-selection:{user_id}"


async def lock_advisory_keys(connection: Any, *keys: str) -> None:
    for key in sorted(set(keys)):
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            key,
        )
