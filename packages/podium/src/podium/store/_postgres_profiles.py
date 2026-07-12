from __future__ import annotations

from typing import Any

from ..podium_shared import utc_now_iso
from ._postgres_records import _pg_datetime, _pg_json, _pg_json_value


RUNTIME_PROFILE_UPSERT_SQL = """
INSERT INTO runtime_profiles (
  id, workspace_id, name, runtime_kind, config_format, config_document,
  config_sha256, state, created_by, created_at, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  runtime_kind = EXCLUDED.runtime_kind,
  config_format = EXCLUDED.config_format,
  config_document = EXCLUDED.config_document,
  config_sha256 = EXCLUDED.config_sha256,
  state = EXCLUDED.state,
  updated_at = EXCLUDED.updated_at
RETURNING *
"""

PERFORMER_PROFILE_UPSERT_SQL = """
INSERT INTO performer_profiles (
  id, workspace_id, name, performer_kind, runtime_profile_id, turn_policy,
  policy_sha256, state, created_by, created_at, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::timestamptz,$11::timestamptz)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  performer_kind = EXCLUDED.performer_kind,
  runtime_profile_id = EXCLUDED.runtime_profile_id,
  turn_policy = EXCLUDED.turn_policy,
  policy_sha256 = EXCLUDED.policy_sha256,
  state = EXCLUDED.state,
  updated_at = EXCLUDED.updated_at
RETURNING *
"""

PERFORMER_CREDENTIAL_UPSERT_SQL = """
INSERT INTO performer_credentials (
  id, workspace_id, name, performer_kind, auth_method, account_hint,
  local_ref, state, created_by, created_at, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  performer_kind = EXCLUDED.performer_kind,
  auth_method = EXCLUDED.auth_method,
  account_hint = EXCLUDED.account_hint,
  local_ref = EXCLUDED.local_ref,
  state = EXCLUDED.state,
  updated_at = EXCLUDED.updated_at
RETURNING *
"""

PERFORMER_BINDING_UPSERT_SQL = """
INSERT INTO performer_bindings (
  id, workspace_id, project_binding_id, performer_profile_id, credential_id,
  generation, state, error_code, sanitized_reason, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
ON CONFLICT (project_binding_id) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  performer_profile_id = EXCLUDED.performer_profile_id,
  credential_id = EXCLUDED.credential_id,
  generation = performer_bindings.generation + CASE
    WHEN performer_bindings.performer_profile_id <> EXCLUDED.performer_profile_id
      OR performer_bindings.credential_id <> EXCLUDED.credential_id
    THEN 1 ELSE 0 END,
  state = 'pending',
  error_code = '',
  sanitized_reason = '',
  updated_at = EXCLUDED.updated_at
RETURNING *
"""


class PgProfilesMixin:
    async def ensure_performer_binding(
        self,
        *,
        project_binding_id: str,
        workspace_id: str,
        runtime_profile: dict[str, Any],
        performer_profile: dict[str, Any],
        credentials: list[dict[str, Any]],
        selected_credential: dict[str, Any],
    ) -> dict[str, Any]:
        now = utc_now_iso()
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                runtime_before = await connection.fetchrow(
                    "SELECT config_sha256 FROM runtime_profiles WHERE id = $1 FOR UPDATE",
                    str(runtime_profile["id"]),
                )
                await connection.fetchrow(
                    RUNTIME_PROFILE_UPSERT_SQL,
                    *_runtime_profile_values(runtime_profile, workspace_id=workspace_id, now=now),
                )
                if runtime_before is not None and str(runtime_before["config_sha256"]) != str(runtime_profile["config_sha256"]):
                    await connection.execute(
                        """
                        UPDATE performer_bindings pb
                        SET generation = pb.generation + 1, updated_at = $2::timestamptz
                        FROM performer_profiles pp
                        WHERE pb.performer_profile_id = pp.id
                          AND pp.runtime_profile_id = $1
                        """,
                        str(runtime_profile["id"]),
                        _pg_datetime(now),
                    )

                performer_before = await connection.fetchrow(
                    "SELECT policy_sha256, runtime_profile_id FROM performer_profiles WHERE id = $1 FOR UPDATE",
                    str(performer_profile["id"]),
                )
                await connection.fetchrow(
                    PERFORMER_PROFILE_UPSERT_SQL,
                    *_performer_profile_values(performer_profile, workspace_id=workspace_id, now=now),
                )
                if performer_before is not None and (
                    str(performer_before["policy_sha256"]) != str(performer_profile["policy_sha256"])
                    or str(performer_before["runtime_profile_id"]) != str(performer_profile["runtime_profile_id"])
                ):
                    await connection.execute(
                        "UPDATE performer_bindings SET generation = generation + 1, updated_at = $2::timestamptz WHERE performer_profile_id = $1",
                        str(performer_profile["id"]),
                        _pg_datetime(now),
                    )

                for credential in credentials:
                    credential_before = await connection.fetchrow(
                        "SELECT local_ref, auth_method, state FROM performer_credentials WHERE id = $1 FOR UPDATE",
                        str(credential["id"]),
                    )
                    await connection.fetchrow(
                        PERFORMER_CREDENTIAL_UPSERT_SQL,
                        *_credential_values(credential, workspace_id=workspace_id, now=now),
                    )
                    if credential_before is not None and (
                        str(credential_before["local_ref"]) != str(credential["local_ref"])
                        or str(credential_before["auth_method"]) != str(credential["auth_method"])
                        or str(credential_before["state"]) != str(credential["state"])
                    ):
                        await connection.execute(
                            "UPDATE performer_bindings SET generation = generation + 1, updated_at = $2::timestamptz WHERE credential_id = $1",
                            str(credential["id"]),
                            _pg_datetime(now),
                        )

                binding = {
                    "id": f"performer-binding:{project_binding_id}",
                    "workspace_id": workspace_id,
                    "project_binding_id": project_binding_id,
                    "performer_profile_id": performer_profile["id"],
                    "credential_id": selected_credential["id"],
                    "generation": 1,
                    "state": "pending",
                    "error_code": "",
                    "sanitized_reason": "",
                    "updated_at": now,
                }
                await connection.fetchrow(
                    PERFORMER_BINDING_UPSERT_SQL,
                    *_performer_binding_values(binding),
                )
                await connection.execute(
                    "UPDATE project_bindings SET performer_binding_id = $2, updated_at = $3::timestamptz WHERE id = $1",
                    project_binding_id,
                    binding["id"],
                    _pg_datetime(now),
                )
                row = await connection.fetchrow(
                    """
                    SELECT
                      pb.id AS performer_binding_id,
                      pb.workspace_id,
                      pb.project_binding_id,
                      pb.performer_profile_id,
                      pb.credential_id,
                      pb.generation,
                      pb.state,
                      pb.error_code,
                      pb.sanitized_reason,
                      pp.performer_kind,
                      pp.turn_policy,
                      pp.policy_sha256,
                      rp.runtime_profile_id,
                      rp.runtime_kind,
                      rp.config_format,
                      rp.config_document,
                      rp.config_sha256,
                      pc.auth_method,
                      pc.account_hint,
                      pc.local_ref
                    FROM performer_bindings pb
                    JOIN performer_profiles pp ON pp.id = pb.performer_profile_id
                    JOIN runtime_profiles rp ON rp.id = pp.runtime_profile_id
                    JOIN performer_credentials pc ON pc.id = pb.credential_id
                    WHERE pb.project_binding_id = $1
                    """,
                    project_binding_id,
                )
        if row is None:
            raise RuntimeError("performer_binding_create_failed")
        return _record_to_performer_binding(row)

    async def get_performer_binding_for_project_binding(self, project_binding_id: str) -> dict[str, Any] | None:
        row = await self.pool.fetchrow(
            """
            SELECT
              pb.id AS performer_binding_id,
              pb.workspace_id,
              pb.project_binding_id,
              pb.performer_profile_id,
              pb.credential_id,
              pb.generation,
              pb.state,
              pb.error_code,
              pb.sanitized_reason,
              pp.performer_kind,
              pp.turn_policy,
              pp.policy_sha256,
              rp.runtime_profile_id,
              rp.runtime_kind,
              rp.config_format,
              rp.config_document,
              rp.config_sha256,
              pc.auth_method,
              pc.account_hint,
              pc.local_ref
            FROM performer_bindings pb
            JOIN performer_profiles pp ON pp.id = pb.performer_profile_id
            JOIN runtime_profiles rp ON rp.id = pp.runtime_profile_id
            JOIN performer_credentials pc ON pc.id = pb.credential_id
            WHERE pb.project_binding_id = $1
            """,
            project_binding_id,
        )
        return _record_to_performer_binding(row) if row is not None else None


def _runtime_profile_values(profile: dict[str, Any], *, workspace_id: str = "", now: str = "") -> tuple[Any, ...]:
    workspace_id = str(profile.get("workspace_id") or workspace_id)
    return (
        str(profile["id"]),
        workspace_id,
        str(profile.get("name") or "default"),
        str(profile.get("runtime_kind") or "codex"),
        str(profile.get("config_format") or "toml"),
        str(profile.get("config_document") or ""),
        str(profile.get("config_sha256") or ""),
        str(profile.get("state") or "active"),
        str(profile.get("created_by") or workspace_id),
        _pg_datetime(profile.get("created_at") or now),
        _pg_datetime(profile.get("updated_at") or now),
    )


def _performer_profile_values(profile: dict[str, Any], *, workspace_id: str = "", now: str = "") -> tuple[Any, ...]:
    workspace_id = str(profile.get("workspace_id") or workspace_id)
    return (
        str(profile["id"]),
        workspace_id,
        str(profile.get("name") or "default"),
        str(profile.get("performer_kind") or "codex"),
        str(profile["runtime_profile_id"]),
        _pg_json(profile.get("turn_policy") or {}),
        str(profile.get("policy_sha256") or ""),
        str(profile.get("state") or "active"),
        str(profile.get("created_by") or workspace_id),
        _pg_datetime(profile.get("created_at") or now),
        _pg_datetime(profile.get("updated_at") or now),
    )


def _credential_values(credential: dict[str, Any], *, workspace_id: str = "", now: str = "") -> tuple[Any, ...]:
    return (
        str(credential["id"]),
        str(credential.get("workspace_id") or workspace_id),
        str(credential.get("name") or credential["id"]),
        str(credential.get("performer_kind") or "codex"),
        str(credential.get("auth_method") or ""),
        str(credential.get("account_hint") or ""),
        str(credential.get("local_ref") or ""),
        str(credential.get("state") or "active"),
        str(credential.get("created_by") or credential.get("workspace_id") or workspace_id),
        _pg_datetime(credential.get("created_at") or now),
        _pg_datetime(credential.get("updated_at") or now),
    )


def _performer_binding_values(binding: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(binding["id"]),
        str(binding["workspace_id"]),
        str(binding["project_binding_id"]),
        str(binding["performer_profile_id"]),
        str(binding["credential_id"]),
        int(binding.get("generation") or 1),
        str(binding.get("state") or "pending"),
        str(binding.get("error_code") or ""),
        str(binding.get("sanitized_reason") or ""),
        _pg_datetime(binding.get("updated_at") or utc_now_iso()),
    )


def _record_to_performer_binding(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["performer_binding_id"]),
        "workspace_id": str(row["workspace_id"]),
        "project_binding_id": str(row["project_binding_id"]),
        "performer_profile_id": str(row["performer_profile_id"]),
        "credential_id": str(row["credential_id"]),
        "generation": int(row["generation"] or 1),
        "state": str(row["state"]),
        "error_code": str(row["error_code"]),
        "sanitized_reason": str(row["sanitized_reason"]),
        "performer_kind": str(row["performer_kind"]),
        "turn_policy": _pg_json_value(row["turn_policy"]) or {},
        "policy_sha256": str(row["policy_sha256"]),
        "runtime_profile_id": str(row["runtime_profile_id"]),
        "runtime_kind": str(row["runtime_kind"]),
        "config_format": str(row["config_format"]),
        "config_document": str(row["config_document"]),
        "config_sha256": str(row["config_sha256"]),
        "auth_method": str(row["auth_method"]),
        "account_hint": str(row["account_hint"]),
        "credential_ref": str(row["local_ref"]),
    }


__all__ = [
    "PERFORMER_BINDING_UPSERT_SQL",
    "PERFORMER_CREDENTIAL_UPSERT_SQL",
    "PERFORMER_PROFILE_UPSERT_SQL",
    "PgProfilesMixin",
    "RUNTIME_PROFILE_UPSERT_SQL",
    "_credential_values",
    "_performer_binding_values",
    "_performer_profile_values",
    "_runtime_profile_values",
]
