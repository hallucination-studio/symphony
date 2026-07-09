from __future__ import annotations

from .conductor_pipeline_store_common import *


class LeasesMixin:
    def reclaim_expired_leases(self, at: datetime) -> int:
        count = 0
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT lease_id, payload_json FROM worker_leases WHERE active = 1").fetchall()
            for row in rows:
                lease = WorkerLease.from_dict(_json_loads(row["payload_json"]))
                if not lease.is_active(at, fencing_token=lease.fencing_token):
                    connection.execute("UPDATE worker_leases SET active = 0 WHERE lease_id = ?", (lease.lease_id,))
                    self._timeout_running_attempt_for_expired_lease(connection, lease, at=at)
                    count += 1
        return count

    def _timeout_running_attempt_for_expired_lease(
        self,
        connection: sqlite3.Connection,
        lease: WorkerLease,
        *,
        at: datetime,
    ) -> None:
        row = connection.execute(
            "SELECT payload_json FROM attempts WHERE attempt_id = ?",
            (lease.attempt_id,),
        ).fetchone()
        if row is None:
            return
        attempt = AttemptRecord.from_dict(_json_loads(row["payload_json"]))
        if attempt.state is not AttemptState.RUNNING:
            return
        error = "worker lease expired before attempt result was published"
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=AttemptState.TIMED_OUT,
            graph_revision=attempt.graph_revision,
            policy_revision=attempt.policy_revision,
            lease_id=attempt.lease_id,
            fencing_token=attempt.fencing_token,
            gate_snapshot_hash=attempt.gate_snapshot_hash,
            score=attempt.score,
            started_at=attempt.started_at,
            completed_at=_format_time(_utc(at)),
            result_uri=attempt.result_uri,
            error=error,
            process_pid=attempt.process_pid,
            thread_id=attempt.thread_id,
            kind=attempt.kind,
        )
        connection.execute(
            """
            UPDATE attempts
            SET state = ?, payload_json = ?
            WHERE attempt_id = ?
            """,
            (AttemptState.TIMED_OUT.value, _json_dumps(updated.to_dict()), updated.attempt_id),
        )
        runtime_row = connection.execute(
            "SELECT payload_json FROM node_runtime_state WHERE node_id = ?",
            (attempt.node_id,),
        ).fetchone()
        if attempt.mode is RuntimeMode.PLAN:
            retry_state = GraphNodeState.REPLANNING
        elif attempt.mode is RuntimeMode.VERIFY:
            retry_state = GraphNodeState.VERIFYING
        else:
            retry_state = GraphNodeState.READY
        self._update_node_state_on_connection(
            connection,
            attempt.node_id,
            retry_state,
            human_reason=None,
        )

    def heartbeat_lease(
        self,
        lease_id: str,
        fencing_token: str,
        *,
        at: datetime,
        ttl_seconds: int = 300,
    ) -> bool:
        heartbeat_at = _format_time(_utc(at))
        expires_at = _format_time(_utc(at) + timedelta(seconds=ttl_seconds))
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM worker_leases WHERE lease_id = ? AND active = 1",
                (lease_id,),
            ).fetchone()
            if row is None:
                return False
            lease = WorkerLease.from_dict(_json_loads(row["payload_json"]))
            if not lease.is_active(at, fencing_token=fencing_token):
                return False
            updated = WorkerLease(
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                mode=lease.mode,
                node_id=lease.node_id,
                attempt_id=lease.attempt_id,
                acquired_at=lease.acquired_at,
                heartbeat_at=heartbeat_at,
                expires_at=expires_at,
            )
            connection.execute(
                "UPDATE worker_leases SET payload_json = ? WHERE lease_id = ?",
                (_json_dumps(updated.to_dict()), lease_id),
            )
        return True

    def publish_verification_input(self, snapshot: VerificationInputSnapshot) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO verification_inputs (execute_attempt_id, node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (snapshot.execute_attempt_id, snapshot.task_id, _json_dumps(snapshot.to_dict()), _now()),
            )

    def has_verification_input_for_node(self, node_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM verification_inputs WHERE node_id = ? LIMIT 1",
                (node_id,),
            ).fetchone()
        return row is not None

    def verification_input_for_node(self, node_id: str) -> VerificationInputSnapshot | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT payload_json FROM verification_inputs
                WHERE node_id = ?
                ORDER BY created_at DESC, execute_attempt_id DESC
                LIMIT 1
                """,
                (node_id,),
            ).fetchone()
        return VerificationInputSnapshot.from_dict(_json_loads(row["payload_json"])) if row is not None else None
