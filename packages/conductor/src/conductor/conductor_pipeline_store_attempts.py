from __future__ import annotations

from .conductor_pipeline_store_common import *


class AttemptsMixin:
    def update_node_state(
        self,
        node_id: str,
        state: GraphNodeState,
        *,
        verify_score: int | None = None,
        human_reason: Any = _UNCHANGED,
        rework_count: int | None = None,
        replan_depth: int | None = None,
    ) -> GraphNode:
        with self.connect() as connection:
            updated = self._update_node_state_on_connection(
                connection,
                node_id,
                state,
                verify_score=verify_score,
                human_reason=human_reason,
                rework_count=rework_count,
                replan_depth=replan_depth,
            )
        return updated

    def _update_node_state_on_connection(
        self,
        connection: sqlite3.Connection,
        node_id: str,
        state: GraphNodeState,
        *,
        verify_score: int | None = None,
        human_reason: Any = _UNCHANGED,
        rework_count: int | None = None,
        replan_depth: int | None = None,
    ) -> GraphNode:
        revision = self._current_graph_revision_on_connection(connection)
        topology_row = connection.execute(
            "SELECT payload_json FROM graph_nodes WHERE revision = ? AND node_id = ?",
            (revision, node_id),
        ).fetchone()
        runtime_row = connection.execute(
            "SELECT payload_json FROM node_runtime_state WHERE node_id = ?",
            (node_id,),
        ).fetchone()
        if topology_row is None:
            raise KeyError(node_id)
        node = _node_from_topology_and_runtime(
            _json_loads(topology_row["payload_json"]),
            _json_loads(runtime_row["payload_json"]) if runtime_row is not None else None,
        )
        updated = GraphNode(
            node_id=node.node_id,
            title=node.title,
            state=state,
            issue_id=node.issue_id,
            issue_identifier=node.issue_identifier,
            parent_node_id=node.parent_node_id,
            gate_snapshot_hash=node.gate_snapshot_hash,
            verify_score=verify_score if verify_score is not None else node.verify_score,
            rework_count=rework_count if rework_count is not None else node.rework_count,
            replan_depth=replan_depth if replan_depth is not None else node.replan_depth,
            superseded_by=node.superseded_by,
            human_reason=node.human_reason if human_reason is _UNCHANGED else human_reason,
        )
        connection.execute(
            """
            INSERT INTO node_runtime_state (node_id, payload_json)
            VALUES (?, ?)
            ON CONFLICT(node_id) DO UPDATE SET payload_json = excluded.payload_json
            """,
            (node_id, _json_dumps(_node_runtime_payload(updated))),
        )
        return updated

    def _current_graph_revision_on_connection(self, connection: sqlite3.Connection) -> int:
        row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
        return int(row["revision"]) if row is not None else 0

    def acquire_lease(
        self,
        mode: RuntimeMode,
        *,
        node_id: str,
        attempt_id: str,
        now: datetime,
        ttl_seconds: int = 300,
    ) -> WorkerLease:
        self.reclaim_expired_leases(now)
        lease = WorkerLease.create(
            lease_id=f"{node_id}-{mode.value}-{attempt_id}",
            mode=mode,
            node_id=node_id,
            attempt_id=attempt_id,
            acquired_at=now,
            ttl_seconds=ttl_seconds,
        )
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO worker_leases (lease_id, node_id, mode, payload_json, active)
                VALUES (?, ?, ?, ?, 1)
                """,
                (lease.lease_id, node_id, mode.value, _json_dumps(lease.to_dict())),
            )
        return lease

    def start_attempt(
        self,
        mode: RuntimeMode,
        *,
        node_id: str,
        attempt_id: str,
        now: datetime,
        ttl_seconds: int = 300,
        graph_revision: int | None = None,
        policy_revision: int | None = None,
        kind: str | None = None,
    ) -> WorkerLease:
        self._ensure_attempt_can_start(attempt_id)
        node = self.get_node(node_id)
        next_state = self._attempt_running_node_state(mode, node)
        lease = self.acquire_lease(mode, node_id=node_id, attempt_id=attempt_id, now=now, ttl_seconds=ttl_seconds)
        graph_revision = self.current_graph_revision() if graph_revision is None else graph_revision
        policy_revision = self.active_runtime_config().scheduler_policy.version if policy_revision is None else policy_revision
        attempt = AttemptRecord(
            attempt_id=attempt_id,
            node_id=node_id,
            mode=mode,
            state=AttemptState.RUNNING,
            graph_revision=graph_revision,
            policy_revision=policy_revision,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            gate_snapshot_hash=node.gate_snapshot_hash,
            started_at=_format_time(_utc(now)),
            kind=kind,
        )
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT OR REPLACE INTO attempts (attempt_id, node_id, mode, state, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (attempt.attempt_id, attempt.node_id, mode.value, attempt.state.value, _json_dumps(attempt.to_dict())),
            )
            updated = GraphNode(
                node_id=node.node_id,
                title=node.title,
                state=next_state,
                issue_id=node.issue_id,
                issue_identifier=node.issue_identifier,
                parent_node_id=node.parent_node_id,
                gate_snapshot_hash=node.gate_snapshot_hash,
                verify_score=node.verify_score,
                rework_count=node.rework_count,
                replan_depth=node.replan_depth,
                superseded_by=node.superseded_by,
                human_reason=node.human_reason,
            )
            connection.execute(
                """
                INSERT INTO node_runtime_state (node_id, payload_json)
                VALUES (?, ?)
                ON CONFLICT(node_id) DO UPDATE SET payload_json = excluded.payload_json
                """,
                (node_id, _json_dumps(_node_runtime_payload(updated))),
            )
        return lease

    def _ensure_attempt_can_start(self, attempt_id: str) -> None:
        try:
            existing_attempt = self.get_attempt(attempt_id)
        except KeyError:
            return
        if existing_attempt.state is not AttemptState.RUNNING:
            raise ValueError("terminal_attempt_immutable")
        raise ValueError("attempt_already_exists")

    def _attempt_running_node_state(self, mode: RuntimeMode, node: GraphNode) -> GraphNodeState:
        if mode is RuntimeMode.PLAN:
            return GraphNodeState.REPLANNING
        self._require_frozen_gate_for_attempt(node)
        if mode is RuntimeMode.EXECUTE:
            return GraphNodeState.EXECUTING
        self._require_verification_input_for_attempt(node)
        return GraphNodeState.VERIFYING

    def _require_frozen_gate_for_attempt(self, node: GraphNode) -> None:
        gate_hash = str(node.gate_snapshot_hash or "").strip()
        if not gate_hash:
            raise ValueError("frozen_gate_required")
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM gate_snapshots WHERE gate_hash = ? AND node_id = ?",
                (gate_hash, node.node_id),
            ).fetchone()
        if row is None:
            raise ValueError("frozen_gate_required")
        gate = GateSpecSnapshot.from_dict(_json_loads(row["payload_json"]))
        if gate.task_id != node.node_id or gate.hash != gate_hash or not gate.frozen:
            raise ValueError("frozen_gate_required")

    def _require_verification_input_for_attempt(self, node: GraphNode) -> None:
        snapshot = self.verification_input_for_node(node.node_id)
        if snapshot is None:
            raise ValueError("verification_input_required")
        if snapshot.task_id != node.node_id or snapshot.gate_snapshot_hash != (node.gate_snapshot_hash or ""):
            raise ValueError("verification_input_required")

    def get_attempt(self, attempt_id: str) -> AttemptRecord:
        with self.connect() as connection:
            row = connection.execute("SELECT payload_json FROM attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        if row is None:
            raise KeyError(attempt_id)
        return AttemptRecord.from_dict(_json_loads(row["payload_json"]))

    def record_attempt_process_pid(self, attempt_id: str, process_pid: int | None) -> None:
        if process_pid is None or process_pid <= 0:
            return
        attempt = self.get_attempt(attempt_id)
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=attempt.state,
            graph_revision=attempt.graph_revision,
            policy_revision=attempt.policy_revision,
            lease_id=attempt.lease_id,
            fencing_token=attempt.fencing_token,
            gate_snapshot_hash=attempt.gate_snapshot_hash,
            score=attempt.score,
            started_at=attempt.started_at,
            completed_at=attempt.completed_at,
            result_uri=attempt.result_uri,
            error=attempt.error,
            process_pid=process_pid,
            thread_id=attempt.thread_id,
            kind=attempt.kind,
        )
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE attempts
                SET payload_json = ?
                WHERE attempt_id = ?
                """,
                (_json_dumps(updated.to_dict()), updated.attempt_id),
            )

    def list_attempts(self) -> list[AttemptRecord]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM attempts ORDER BY rowid",
            ).fetchall()
        return [AttemptRecord.from_dict(_json_loads(row["payload_json"])) for row in rows]

    def latest_failed_verify_attempt_for_node(self, node_id: str) -> AttemptRecord | None:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM attempts
                WHERE node_id = ? AND mode = ? AND state = ?
                ORDER BY rowid DESC
                """,
                (node_id, RuntimeMode.VERIFY.value, AttemptState.SUCCEEDED.value),
            ).fetchall()
        for row in rows:
            attempt = AttemptRecord.from_dict(_json_loads(row["payload_json"]))
            if attempt.score is not None and attempt.score < PASS_THRESHOLD:
                return attempt
        return None

    def latest_thread_id_for_node(self, node_id: str) -> str | None:
        for attempt in reversed(self.list_attempts()):
            if attempt.node_id == node_id and attempt.thread_id:
                return attempt.thread_id
        return None

    def active_lease(self, node_id: str, mode: RuntimeMode) -> WorkerLease | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT payload_json FROM worker_leases
                WHERE node_id = ? AND mode = ? AND active = 1
                ORDER BY lease_id DESC
                LIMIT 1
                """,
                (node_id, mode.value),
            ).fetchone()
        return WorkerLease.from_dict(_json_loads(row["payload_json"])) if row is not None else None

    def list_active_leases(self) -> list[WorkerLease]:
        return self._active_leases()

    def validate_fencing_token(self, node_id: str, mode: RuntimeMode, fencing_token: str, *, at: datetime) -> bool:
        lease = self.active_lease(node_id, mode)
        return lease is not None and lease.is_active(at, fencing_token=fencing_token)
