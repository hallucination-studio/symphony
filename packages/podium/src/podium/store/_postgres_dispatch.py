from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _record_to_dispatch, _record_to_project_binding, _row_count


class PgDispatchMixin:
    async def upsert_project_binding(self, binding: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO project_bindings (
              id, conductor_id, user_id, instance_id, name, linear_project, project_slug,
              agent_app_user_id, pipeline_profile, process_status, constraint_labels, repo_source, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              linear_project = EXCLUDED.linear_project,
              project_slug = EXCLUDED.project_slug,
              agent_app_user_id = EXCLUDED.agent_app_user_id,
              pipeline_profile = EXCLUDED.pipeline_profile,
              process_status = EXCLUDED.process_status,
              constraint_labels = EXCLUDED.constraint_labels,
              repo_source = EXCLUDED.repo_source,
              updated_at = EXCLUDED.updated_at
            """,
            str(binding["id"]),
            str(binding["conductor_id"]),
            str(binding["user_id"]),
            str(binding["instance_id"]),
            str(binding.get("name") or ""),
            str(binding.get("linear_project") or ""),
            str(binding.get("project_slug") or ""),
            str(binding.get("agent_app_user_id") or ""),
            str(binding.get("pipeline_profile") or "default"),
            str(binding.get("process_status") or ""),
            _pg_json(binding.get("constraint_labels") or []),
            _pg_json(binding.get("repo_source") or {}),
            _pg_datetime(binding.get("updated_at")),
        )
        await self.upsert_runtime_group(
            {
                "id": str(binding["id"]),
                "linear_workspace_id": str(binding["user_id"]),
                "project_slug": str(binding.get("project_slug") or ""),
                "linear_agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
                "pipeline_profile": str(binding.get("pipeline_profile") or "default"),
                "project_binding_id": str(binding["id"]),
            }
        )

    async def list_project_bindings_for_conductor(self, conductor_id: str) -> list[dict[str, Any]]:
        rows = await self.pool.fetch("SELECT * FROM project_bindings WHERE conductor_id = $1 ORDER BY id", conductor_id)
        return [_record_to_project_binding(row) for row in rows]

    async def list_project_bindings_for_route(self, *, user_id: str, project_slug: str, agent_app_user_ids: list[str]) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """
            SELECT * FROM project_bindings
            WHERE user_id = $1
              AND project_slug = $2
              AND (agent_app_user_id = '' OR agent_app_user_id = ANY($3::text[]))
            ORDER BY id
            """,
            user_id,
            project_slug,
            list(agent_app_user_ids),
        )
        return [_record_to_project_binding(row) for row in rows]

    async def upsert_dispatch(self, dispatch: dict[str, Any]) -> bool:
        row = await self.pool.fetchrow(
            """
            INSERT INTO dispatches (
              id, project_binding_id, user_id, issue_id, issue_identifier, issue_title, issue_description,
              pipeline_intent, workspace_id, project_slug, agent_session_id, status, reason,
              agent_app_user_id, issue_delegate_id, leased_conductor_id, leased_until, fencing_token,
              graph_id, node_id, attempt_id, mode, attempt_status, graph_revision, policy_revision, lease_id,
              created_at, updated_at, completed_at
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18,
              $19,$20,$21,$22,$23,$24,$25,$26,$27::timestamptz,$28::timestamptz,$29::timestamptz
            )
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            str(dispatch["dispatch_id"]),
            str(dispatch["project_binding_id"]),
            str(dispatch["user_id"]),
            str(dispatch["issue_id"]),
            str(dispatch.get("issue_identifier") or ""),
            str(dispatch.get("issue_title") or ""),
            str(dispatch.get("issue_description") or ""),
            _pg_json(dispatch.get("pipeline_intent") or {}),
            str(dispatch.get("linear_workspace_id") or dispatch.get("workspace_id") or ""),
            str(dispatch.get("project_slug") or ""),
            str(dispatch.get("agent_session_id") or ""),
            str(dispatch.get("status") or "queued"),
            str(dispatch.get("reason") or ""),
            str(dispatch.get("agent_app_user_id") or ""),
            str(dispatch.get("issue_delegate_id") or ""),
            dispatch.get("leased_runtime_id") or dispatch.get("leased_conductor_id"),
            _pg_datetime(dispatch.get("leased_until")),
            int(dispatch.get("fencing_token") or 0),
            str(dispatch.get("graph_id") or ""),
            str(dispatch.get("node_id") or ""),
            str(dispatch.get("attempt_id") or ""),
            str(dispatch.get("mode") or ""),
            str(dispatch.get("attempt_status") or ""),
            int(dispatch.get("graph_revision") or 0),
            int(dispatch.get("policy_revision") or 0),
            str(dispatch.get("lease_id") or ""),
            _pg_datetime(dispatch.get("created_at")),
            _pg_datetime(dispatch.get("updated_at") or dispatch.get("created_at")),
            _pg_datetime(dispatch.get("completed_at")),
        )
        return row is not None

    async def lease_dispatch(self, conductor_id: str, *, binding_ids: list[str], lease_until: str) -> dict[str, Any] | None:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                WITH candidate AS (
                  SELECT id
                  FROM dispatches
                  WHERE project_binding_id = ANY($2::text[])
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
                """,
                conductor_id,
                list(binding_ids),
                _pg_datetime(lease_until),
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
        pipeline: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any] | None:
        pipeline = pipeline or {}
        row = await self.pool.fetchrow(
            """
            UPDATE dispatches
            SET status = $3,
                reason = $4,
                completed_at = $5::timestamptz,
                graph_id = COALESCE($7, graph_id),
                node_id = COALESCE($8, node_id),
                attempt_id = COALESCE($9, attempt_id),
                mode = COALESCE($10, mode),
                attempt_status = COALESCE($11, attempt_status),
                graph_revision = COALESCE($12, graph_revision),
                policy_revision = COALESCE($13, policy_revision),
                lease_id = COALESCE($14, lease_id),
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
            pipeline.get("graph_id"),
            pipeline.get("node_id"),
            pipeline.get("attempt_id"),
            pipeline.get("mode"),
            pipeline.get("attempt_status"),
            pipeline.get("graph_revision"),
            pipeline.get("policy_revision"),
            pipeline.get("lease_id"),
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
