from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _record_to_dispatch, _record_to_project_binding, _row_count


DISPATCH_INSERT_SQL = """
INSERT INTO dispatches (
  id, project_binding_id, user_id, issue_id, issue_identifier, issue_title, issue_description,
  managed_run_intent, intake_key, workspace_id, project_slug, status, reason,
  agent_app_user_id, issue_delegate_id, blocked_by, leased_conductor_id, leased_until, fencing_token,
  run_id, parent_issue_id, active_work_item_id, managed_run_state, plan_version, backend_session_id,
  created_at, updated_at, completed_at
)
VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::timestamptz,$19,
  $20,$21,$22,$23,$24,$25,$26::timestamptz,$27::timestamptz,$28::timestamptz
)
ON CONFLICT DO NOTHING
RETURNING id
"""

LEASE_DISPATCH_SQL = """
WITH candidate AS (
    SELECT id
    FROM dispatches
    WHERE project_binding_id = ANY($2::text[])
    AND COALESCE(jsonb_array_length(blocked_by), 0) = 0
    AND reason <> 'linear_blocker_check_failed'
    AND (status = 'queued' OR (status = 'leased' AND leased_until < now()))
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE dispatches
SET status = 'leased',
    leased_conductor_id = $1,
    leased_until = $3::timestamptz,
    fencing_token = dispatches.fencing_token + 1,
    updated_at = now()
FROM candidate
WHERE dispatches.id = candidate.id
RETURNING dispatches.*
"""

PROJECT_BINDING_UPSERT_SQL = """
INSERT INTO project_bindings (
  id, conductor_id, user_id, instance_id, name, linear_project, project_slug,
  linear_project_id, project_name, agent_app_user_id, installation_id,
  process_status,
  constraint_labels, repo_source, state, active, config_version, acknowledged_config_version,
  candidate_installation_id, candidate_agent_app_user_id, candidate_config_version,
  candidate_acknowledged_config_version, label_id, label_name,
  replacement_conductor_id, replacement_repo_source, replacement_state,
  replacement_binding_id, error_code, sanitized_reason, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28,$29,$30,$31::timestamptz)
ON CONFLICT (id) DO UPDATE SET
  instance_id = EXCLUDED.instance_id,
  name = EXCLUDED.name,
  linear_project = EXCLUDED.linear_project,
  project_slug = EXCLUDED.project_slug,
  linear_project_id = EXCLUDED.linear_project_id,
  project_name = EXCLUDED.project_name,
  agent_app_user_id = EXCLUDED.agent_app_user_id,
  installation_id = EXCLUDED.installation_id,
  process_status = EXCLUDED.process_status,
  constraint_labels = EXCLUDED.constraint_labels,
  repo_source = EXCLUDED.repo_source,
  state = EXCLUDED.state,
  active = EXCLUDED.active,
  config_version = EXCLUDED.config_version,
  acknowledged_config_version = EXCLUDED.acknowledged_config_version,
  candidate_installation_id = EXCLUDED.candidate_installation_id,
  candidate_agent_app_user_id = EXCLUDED.candidate_agent_app_user_id,
  candidate_config_version = EXCLUDED.candidate_config_version,
  candidate_acknowledged_config_version = EXCLUDED.candidate_acknowledged_config_version,
  label_id = EXCLUDED.label_id,
  label_name = EXCLUDED.label_name,
  replacement_conductor_id = EXCLUDED.replacement_conductor_id,
  replacement_repo_source = EXCLUDED.replacement_repo_source,
  replacement_state = EXCLUDED.replacement_state,
  replacement_binding_id = EXCLUDED.replacement_binding_id,
  error_code = EXCLUDED.error_code,
  sanitized_reason = EXCLUDED.sanitized_reason,
  updated_at = EXCLUDED.updated_at
WHERE NOT $32::boolean OR project_bindings.active = FALSE
RETURNING *
"""

def _dispatch_values(dispatch: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(dispatch["dispatch_id"]),
        str(dispatch["project_binding_id"]),
        str(dispatch["user_id"]),
        str(dispatch["issue_id"]),
        str(dispatch.get("issue_identifier") or ""),
        str(dispatch.get("issue_title") or ""),
        str(dispatch.get("issue_description") or ""),
        _pg_json(dispatch.get("managed_run_intent") or {}),
        str(dispatch.get("intake_key") or ""),
        str(dispatch.get("linear_workspace_id") or dispatch.get("workspace_id") or ""),
        str(dispatch.get("project_slug") or ""),
        str(dispatch.get("status") or "queued"),
        str(dispatch.get("reason") or ""),
        str(dispatch.get("agent_app_user_id") or ""),
        str(dispatch.get("issue_delegate_id") or ""),
        _pg_json(_blocker_ids(dispatch.get("blocked_by"))),
        dispatch.get("leased_runtime_id") or dispatch.get("leased_conductor_id"),
        _pg_datetime(dispatch.get("leased_until")),
        int(dispatch.get("fencing_token") or 0),
        str(dispatch.get("run_id") or ""),
        str(dispatch.get("parent_issue_id") or ""),
        str(dispatch.get("active_work_item_id") or ""),
        str(dispatch.get("managed_run_state") or ""),
        int(dispatch.get("plan_version") or 0),
        str(dispatch.get("backend_session_id") or ""),
        _pg_datetime(dispatch.get("created_at")),
        _pg_datetime(dispatch.get("updated_at") or dispatch.get("created_at")),
        _pg_datetime(dispatch.get("completed_at")),
    )


class PgDispatchMixin:
    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        await _upsert_project_binding_on(self.pool, binding)

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM project_bindings WHERE conductor_id = $1 ORDER BY id", conductor_id)
        return [_record_to_project_binding(row) for row in rows]

    async def get_project_binding(self, binding_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT * FROM project_bindings WHERE id = $1", binding_id)
        return _record_to_project_binding(row) if row is not None else None

    async def list_project_bindings_for_user(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM project_bindings WHERE user_id = $1 AND active = TRUE ORDER BY id",
            user_id,
        )
        return [_record_to_project_binding(row) for row in rows]

    async def count_open_dispatches_for_user(self, user_id: str) -> int:
        value = await self.pool.fetchval(
            """
            SELECT count(*) FROM dispatches
            WHERE user_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled', 'canceled')
            """,
            user_id,
        )
        return int(value or 0)

    async def get_active_project_binding_for_project(
        self,
        user_id: str,
        linear_project_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM project_bindings WHERE user_id = $1 AND linear_project_id = $2 AND active = TRUE",
            user_id,
            linear_project_id,
        )
        return _record_to_project_binding(row) if row is not None else None

    async def get_ready_project_binding_for_installation(
        self,
        user_id: str,
        linear_project_id: str,
        *,
        installation_id: str,
        agent_app_user_id: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT * FROM project_bindings
            WHERE user_id = $1
              AND linear_project_id = $2
              AND active = TRUE
              AND state = 'ready'
              AND installation_id <> ''
              AND installation_id = $3
              AND agent_app_user_id <> ''
              AND agent_app_user_id = $4
            LIMIT 1
            """,
            user_id,
            linear_project_id,
            installation_id,
            agent_app_user_id,
        )
        return _record_to_project_binding(row) if row is not None else None

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                LEASE_DISPATCH_SQL,
                conductor_id,
                list(binding_ids),
                _pg_datetime(lease_until),
            )
        return _record_to_dispatch(row) if row is not None else None

    async def list_dispatches_requiring_blocker_recheck(self, binding_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """
            SELECT * FROM dispatches
            WHERE project_binding_id = $1
              AND status = 'queued'
              AND (
                COALESCE(jsonb_array_length(blocked_by), 0) > 0
                OR reason = 'linear_blocker_check_failed'
              )
            ORDER BY created_at ASC
            """,
            binding_id,
        )
        return [_record_to_dispatch(row) for row in rows]

    async def update_dispatch_blockers(
        self,
        dispatch_id: str,
        blocker_ids: list[str],
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            UPDATE dispatches
            SET blocked_by = $2::jsonb,
                reason = $3,
                updated_at = now()
            WHERE id = $1 AND status = 'queued'
            RETURNING *
            """,
            dispatch_id,
            _pg_json(_blocker_ids(blocker_ids)),
            reason,
        )
        return _record_to_dispatch(row) if row is not None else None

    async def requeue_dispatch_for_blockers(
        self,
        conductor_id: str,
        dispatch_id: str,
        fencing_token: int,
        blocker_ids: list[str],
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            UPDATE dispatches
            SET status = 'queued',
                leased_conductor_id = NULL,
                leased_until = NULL,
                blocked_by = $4::jsonb,
                reason = $5,
                updated_at = now()
            WHERE id = $2
              AND leased_conductor_id = $1
              AND fencing_token = $3::bigint
              AND status = 'leased'
            RETURNING *
            """,
            conductor_id,
            dispatch_id,
            fencing_token,
            _pg_json(_blocker_ids(blocker_ids)),
            reason,
        )
        return _record_to_dispatch(row) if row is not None else None

    async def ack_dispatch(
        self,
        conductor_id: str,
        dispatch_id: str,
        status: str,
        *,
        fencing_token: int | None,
        reason: str = "",
        managed_run: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        managed_run = managed_run or {}
        row = await self.pool.fetchrow(
            """
            UPDATE dispatches
            SET status = $3,
                reason = $4,
                completed_at = $5::timestamptz,
                run_id = COALESCE($7, run_id),
                parent_issue_id = COALESCE($8, parent_issue_id),
                active_work_item_id = COALESCE($9, active_work_item_id),
                managed_run_state = COALESCE($10, managed_run_state),
                plan_version = COALESCE($11, plan_version),
                backend_session_id = COALESCE($12, backend_session_id),
                updated_at = now()
            WHERE id = $2 AND leased_conductor_id = $1 AND fencing_token = $6::bigint
            RETURNING *
            """,
            conductor_id,
            dispatch_id,
            status,
            reason,
            _pg_datetime(completed_at),
            fencing_token,
            managed_run.get("run_id"),
            managed_run.get("parent_issue_id"),
            managed_run.get("active_work_item_id"),
            managed_run.get("managed_run_state"),
            managed_run.get("plan_version"),
            managed_run.get("backend_session_id"),
        )
        return _record_to_dispatch(row) if row is not None else None

    async def reap_expired_dispatch_leases(self) -> int:
        result = await self.pool.execute(
            """
            UPDATE dispatches
            SET status = 'queued', leased_conductor_id = NULL, leased_until = NULL, updated_at = now()
            WHERE status = 'leased' AND leased_until < now()
            """
        )
        return _row_count(result)


def _binding_values(binding: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(binding["id"]), str(binding["conductor_id"]), str(binding["user_id"]),
        str(binding["instance_id"]), str(binding.get("name") or ""),
        str(binding.get("linear_project") or ""), str(binding.get("project_slug") or ""),
        str(binding.get("linear_project_id") or ""), str(binding.get("project_name") or ""),
        str(binding.get("agent_app_user_id") or ""), str(binding.get("installation_id") or ""),
        str(binding.get("process_status") or ""),
        _pg_json(binding.get("constraint_labels") or []), _pg_json(binding.get("repo_source") or {}),
        str(binding.get("state") or "pending_ack"), bool(binding.get("active", True)),
        int(binding.get("config_version") or 0), int(binding.get("acknowledged_config_version") or 0),
        str(binding.get("candidate_installation_id") or ""),
        str(binding.get("candidate_agent_app_user_id") or ""), int(binding.get("candidate_config_version") or 0),
        int(binding.get("candidate_acknowledged_config_version") or 0), str(binding.get("label_id") or ""),
        str(binding.get("label_name") or ""), str(binding.get("replacement_conductor_id") or ""),
        _pg_json(binding.get("replacement_repo_source") or {}), str(binding.get("replacement_state") or ""),
        str(binding.get("replacement_binding_id") or ""), str(binding.get("error_code") or ""),
        str(binding.get("sanitized_reason") or ""), _pg_datetime(binding.get("updated_at")),
    )


def _blocker_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({item for item in value if isinstance(item, str) and item})


async def _upsert_project_binding_on(
    connection: Any,
    binding: dict[str, Any],
    *,
    require_inactive: bool = False,
) -> dict[str, Any] | None:
    row = await connection.fetchrow(
        PROJECT_BINDING_UPSERT_SQL,
        *_binding_values(binding),
        require_inactive,
    )
    if row is None:
        return None
    return _record_to_project_binding(row)
