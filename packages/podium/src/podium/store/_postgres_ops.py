from __future__ import annotations

from typing import Any

from ._postgres_records import _pg_datetime, _pg_json, _pg_json_value, _row_count


class PgOpsMixin:
    async def save_onboarding_state(self, user_id: str, completed_steps: list[str], metadata: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO onboarding_state (user_id, completed_steps_json, metadata_json, updated_at)
            VALUES ($1,$2::jsonb,$3::jsonb,now())
            ON CONFLICT (user_id) DO UPDATE SET
              completed_steps_json = EXCLUDED.completed_steps_json,
              metadata_json = EXCLUDED.metadata_json,
              updated_at = EXCLUDED.updated_at
            """,
            user_id,
            _pg_json(completed_steps),
            _pg_json(metadata),
        )

    async def get_onboarding_state(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT completed_steps_json, metadata_json, updated_at FROM onboarding_state WHERE user_id = $1", user_id)
        if row is None:
            return None
        return {
            "completed_steps": list(_pg_json_value(row["completed_steps_json"], [])),
            "metadata": dict(_pg_json_value(row["metadata_json"], {})),
            "updated_at": row["updated_at"].isoformat(),
        }

    async def save_smoke_result(self, user_id: str, result: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO smoke_results (user_id, result_json, updated_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (user_id) DO UPDATE SET result_json = EXCLUDED.result_json, updated_at = now()
            """,
            user_id,
            _pg_json(result),
        )

    async def compare_and_save_smoke_result(
        self,
        user_id: str,
        expected_revision: int,
        result: dict[str, Any],
    ) -> bool:
        updated = await self.pool.execute(
            """
            UPDATE smoke_results SET result_json = $3::jsonb, updated_at = now()
            WHERE user_id = $1 AND COALESCE(result_json->>'revision', '0') = $2
            """,
            user_id,
            str(expected_revision),
            _pg_json(result),
        )
        if _row_count(updated) == 1:
            return True
        if expected_revision != 0:
            return False
        inserted = await self.pool.execute(
            """
            INSERT INTO smoke_results (user_id, result_json, updated_at)
            VALUES ($1,$2::jsonb,now()) ON CONFLICT (user_id) DO NOTHING
            """,
            user_id,
            _pg_json(result),
        )
        return _row_count(inserted) == 1

    async def get_smoke_result(self, user_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT result_json FROM smoke_results WHERE user_id = $1", user_id)
        return dict(_pg_json_value(row["result_json"], {})) if row is not None else None

    async def upsert_metrics_snapshot(self, conductor_id: str, instance_id: str, metrics: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO metrics_snapshots (conductor_id, instance_id, captured_at, metrics_json)
            VALUES ($1,$2,$3::timestamptz,$4::jsonb)
            ON CONFLICT (conductor_id, instance_id) DO UPDATE SET captured_at = EXCLUDED.captured_at, metrics_json = EXCLUDED.metrics_json
            """,
            conductor_id,
            instance_id,
            _pg_datetime(metrics.get("captured_at")),
            _pg_json(metrics),
        )

    async def get_metrics_snapshot(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT metrics_json FROM metrics_snapshots WHERE conductor_id = $1 AND instance_id = $2", conductor_id, instance_id)
        return dict(_pg_json_value(row["metrics_json"], {})) if row is not None else None

    async def upsert_instance_log_tail(self, conductor_id: str, instance_id: str, tail: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO instance_log_tails (conductor_id, instance_id, tail_json, updated_at)
            VALUES ($1,$2,$3::jsonb,$4::timestamptz)
            ON CONFLICT (conductor_id, instance_id) DO UPDATE SET tail_json = EXCLUDED.tail_json, updated_at = EXCLUDED.updated_at
            """,
            conductor_id,
            instance_id,
            _pg_json(tail),
            _pg_datetime(tail.get("updated_at")),
        )

    async def get_instance_log_tail(self, conductor_id: str, instance_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT tail_json FROM instance_log_tails WHERE conductor_id = $1 AND instance_id = $2", conductor_id, instance_id)
        return dict(_pg_json_value(row["tail_json"], {})) if row is not None else None

    async def save_managed_run_view(self, runtime_group_id: str, view: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO managed_run_views (runtime_group_id, view_json, updated_at)
            VALUES ($1,$2::jsonb,now())
            ON CONFLICT (runtime_group_id) DO UPDATE SET view_json = EXCLUDED.view_json, updated_at = now()
            """,
            runtime_group_id,
            _pg_json(view),
        )

    async def get_managed_run_view(self, runtime_group_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow("SELECT view_json FROM managed_run_views WHERE runtime_group_id = $1", runtime_group_id)
        return dict(_pg_json_value(row["view_json"], {})) if row is not None else None
