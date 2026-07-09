from __future__ import annotations

from .conductor_pipeline_store_common import *


class RuntimeMixin:
    def apply_runtime_config(self, envelope: RuntimeConfigEnvelope) -> bool:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT version FROM runtime_config WHERE id = 1").fetchone()
            current_version = int(row["version"]) if row is not None else 0
            if envelope.version <= current_version:
                return False
            connection.execute(
                """
                INSERT INTO runtime_config (id, version, payload_json, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  version = excluded.version,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (envelope.version, _json_dumps(envelope.to_dict()), _now()),
            )
        return True

    def active_runtime_config(self) -> RuntimeConfigEnvelope:
        with self.connect() as connection:
            row = connection.execute("SELECT payload_json FROM runtime_config WHERE id = 1").fetchone()
        if row is None:
            policy = SchedulerPolicy(
                policy_id="local-default",
                version=1,
                effective_at=_now(),
                capacity=SchedulerCapacity(global_limit=None, by_mode={}),
            )
            return RuntimeConfigEnvelope(runtime_group_id="", version=1, scheduler_policy=policy, profiles={})
        return RuntimeConfigEnvelope.from_dict(_json_loads(row["payload_json"]))

    def active_runtime_config_source(self) -> str:
        with self.connect() as connection:
            row = connection.execute("SELECT 1 FROM runtime_config WHERE id = 1").fetchone()
        return "podium_pushed" if row is not None else "local_default"

    def record_scheduler_tick_policy(
        self,
        envelope: RuntimeConfigEnvelope,
        *,
        policy_source: str,
        at: datetime | None = None,
    ) -> dict[str, Any]:
        payload = {
            "policy_id": envelope.scheduler_policy.policy_id,
            "policy_version": envelope.scheduler_policy.version,
            "policy_source": policy_source,
            "runtime_config_version": envelope.version,
            "recorded_at": _format_time(at or datetime.now(timezone.utc)),
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO scheduler_tick_policy (id, payload_json, updated_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (_json_dumps(payload), payload["recorded_at"]),
            )
        return payload

    def latest_scheduler_tick_policy(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute("SELECT payload_json FROM scheduler_tick_policy WHERE id = 1").fetchone()
        if row is None:
            return {
                "policy_id": "",
                "policy_version": 0,
                "policy_source": "no_scheduler_tick",
                "runtime_config_version": 0,
                "recorded_at": "",
            }
        return _json_loads(row["payload_json"])
