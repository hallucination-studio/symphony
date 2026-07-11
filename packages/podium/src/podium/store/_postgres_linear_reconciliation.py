from __future__ import annotations

from typing import Any

from ._postgres_dispatch import DISPATCH_INSERT_SQL, _dispatch_values
from ._postgres_records import _pg_datetime, _pg_json, _pg_json_value


STATE_UPSERT_SQL = """
INSERT INTO linear_reconciliation_state (binding_id, state_json, updated_at)
VALUES ($1,$2::jsonb,now())
ON CONFLICT (binding_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = now()
"""

OBSERVATION_UPSERT_SQL = """
INSERT INTO linear_issue_observations (
  binding_id, issue_id, issue_identifier, delegated, delegation_epoch, last_updated_at, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6::timestamptz,now())
ON CONFLICT (binding_id, issue_id) DO UPDATE SET
  issue_identifier = EXCLUDED.issue_identifier,
  delegated = EXCLUDED.delegated,
  delegation_epoch = EXCLUDED.delegation_epoch,
  last_updated_at = EXCLUDED.last_updated_at,
  updated_at = now()
"""


class PgLinearReconciliationMixin:
    async def get_linear_reconciliation_state(self, binding_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT state_json FROM linear_reconciliation_state WHERE binding_id = $1",
            binding_id,
        )
        if row is None:
            return None
        state = _pg_json_value(row["state_json"], {})
        return dict(state) if isinstance(state, dict) else None

    async def get_linear_issue_observation(self, binding_id: str, issue_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM linear_issue_observations WHERE binding_id = $1 AND issue_id = $2",
            binding_id,
            issue_id,
        )
        if row is None:
            return None
        return _observation_record(row)

    async def get_linear_issue_observations(
        self,
        binding_id: str,
        issue_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM linear_issue_observations WHERE binding_id = $1 AND issue_id = ANY($2::text[])",
            binding_id,
            issue_ids,
        )
        return {str(row["issue_id"]): _observation_record(row) for row in rows}

    async def commit_linear_reconciliation_page(
        self,
        binding_id: str,
        *,
        expected_state: dict[str, Any] | None,
        expected_installation_id: str,
        expected_agent_app_user_id: str,
        state: dict[str, Any],
        observations: list[dict[str, Any]],
        dispatches: list[dict[str, Any]],
    ) -> int | None:
        inserted = 0
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
                    binding_id,
                )
                if not await _locked_binding_matches(
                    connection,
                    binding_id,
                    expected_installation_id=expected_installation_id,
                    expected_agent_app_user_id=expected_agent_app_user_id,
                ):
                    return None
                current = await _locked_reconciliation_state(connection, binding_id)
                if current != expected_state:
                    return None
                for observation in observations:
                    await connection.execute(OBSERVATION_UPSERT_SQL, *_observation_values(observation))
                for dispatch in dispatches:
                    inserted += int(
                        await connection.fetchrow(DISPATCH_INSERT_SQL, *_dispatch_values(dispatch)) is not None
                    )
                await connection.execute(
                    STATE_UPSERT_SQL,
                    binding_id,
                    _pg_json({**state, "binding_id": binding_id}),
                )
        return inserted


async def _locked_binding_matches(
    connection: Any,
    binding_id: str,
    *,
    expected_installation_id: str,
    expected_agent_app_user_id: str,
) -> bool:
    row = await connection.fetchrow(
        """
        SELECT active, state, installation_id, agent_app_user_id
        FROM project_bindings
        WHERE id = $1
        FOR UPDATE
        """,
        binding_id,
    )
    return bool(
        row is not None
        and row["active"]
        and str(row["state"]) == "ready"
        and expected_installation_id
        and str(row["installation_id"]) == expected_installation_id
        and expected_agent_app_user_id
        and str(row["agent_app_user_id"]) == expected_agent_app_user_id
    )


async def _locked_reconciliation_state(connection: Any, binding_id: str) -> dict[str, Any] | None:
    row = await connection.fetchrow(
        "SELECT state_json FROM linear_reconciliation_state WHERE binding_id = $1 FOR UPDATE",
        binding_id,
    )
    if row is None:
        return None
    state = _pg_json_value(row["state_json"], {})
    return dict(state) if isinstance(state, dict) else None


def _observation_record(row: Any) -> dict[str, Any]:
    return {
        "binding_id": str(row["binding_id"]),
        "issue_id": str(row["issue_id"]),
        "issue_identifier": str(row["issue_identifier"]),
        "delegated": bool(row["delegated"]),
        "delegation_epoch": int(row["delegation_epoch"]),
        "last_updated_at": row["last_updated_at"].isoformat(),
    }


def _observation_values(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(row["binding_id"]),
        str(row["issue_id"]),
        str(row.get("issue_identifier") or ""),
        bool(row.get("delegated")),
        int(row.get("delegation_epoch") or 0),
        _pg_datetime(row.get("last_updated_at")),
    )
