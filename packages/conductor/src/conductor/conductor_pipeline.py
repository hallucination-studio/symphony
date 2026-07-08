from __future__ import annotations

import json
import hashlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    ExecuteAttemptRequest,
    PASS_THRESHOLD,
    DependencySatisfactionPolicy,
    GateSpecSnapshot,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanAttemptRequest,
    PlanAttemptResult,
    PipelineModeView,
    PipelineView,
    PlanProposal,
    PlanValidator,
    PlanValidatorError,
    PredictedCall,
    RUNTIME_BACKENDS_BY_MODE,
    RuntimeConfigEnvelope,
    RuntimeMode,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptResult,
    VerifyAttemptRequest,
    WorkerLease,
)

from .runtime_backends import prepare_backend_environment


@dataclass(frozen=True)
class GraphRevision:
    graph_id: str
    revision: int
    plan_attempt_id: str
    root_node_id: str


_UNCHANGED = object()


class ConductorPipelineStore:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        self.db_path = data_root / "pipeline.db"
        self.artifact_root = data_root / "artifacts"
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runtime_config (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  version INTEGER NOT NULL,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS graph_revisions (
                  revision INTEGER PRIMARY KEY,
                  graph_id TEXT NOT NULL,
                  plan_attempt_id TEXT NOT NULL,
                  root_node_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS graph_nodes (
                  revision INTEGER NOT NULL,
                  node_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  PRIMARY KEY (revision, node_id)
                );
                CREATE TABLE IF NOT EXISTS node_runtime_state (
                  node_id TEXT PRIMARY KEY,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS graph_edges (
                  revision INTEGER NOT NULL,
                  blocker_node_id TEXT NOT NULL,
                  blocked_node_id TEXT NOT NULL,
                  PRIMARY KEY (revision, blocker_node_id, blocked_node_id)
                );
                CREATE TABLE IF NOT EXISTS dispatch_context (
                  node_id TEXT PRIMARY KEY,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS gate_snapshots (
                  gate_hash TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS worker_leases (
                  lease_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  active INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attempts (
                  attempt_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  state TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS verification_inputs (
                  execute_attempt_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_output_manifests (
                  verify_attempt_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS integration_queue (
                  integration_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  verify_attempt_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS repository_integrations (
                  graph_id TEXT NOT NULL,
                  repository_path TEXT NOT NULL,
                  integrated_revision TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (graph_id, repository_path)
                );
                CREATE TABLE IF NOT EXISTS human_waits (
                  wait_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  resolved_at TEXT
                );
                CREATE TABLE IF NOT EXISTS runtime_waits (
                  wait_id TEXT PRIMARY KEY,
                  attempt_id TEXT NOT NULL,
                  node_id TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  status TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  resolved_at TEXT
                );
                CREATE TABLE IF NOT EXISTS linear_projections (
                  projection_id TEXT PRIMARY KEY,
                  node_id TEXT NOT NULL,
                  linear_issue_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                """
            )
            self._migrate_graph_nodes_primary_key(connection)
            self._migrate_node_runtime_state(connection)

    def _migrate_graph_nodes_primary_key(self, connection: sqlite3.Connection) -> None:
        columns = connection.execute("PRAGMA table_info(graph_nodes)").fetchall()
        primary_key_columns = [str(row[1]) for row in columns if int(row[5] or 0) > 0]
        if primary_key_columns == ["revision", "node_id"]:
            return
        if not primary_key_columns:
            return
        connection.execute("ALTER TABLE graph_nodes RENAME TO graph_nodes_legacy")
        connection.execute(
            """
            CREATE TABLE graph_nodes (
              revision INTEGER NOT NULL,
              node_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (revision, node_id)
            )
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO graph_nodes (revision, node_id, payload_json)
            SELECT revision, node_id, payload_json FROM graph_nodes_legacy
            """
        )
        connection.execute("DROP TABLE graph_nodes_legacy")

    def _migrate_node_runtime_state(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS node_runtime_state (
              node_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            )
            """
        )
        rows = connection.execute("SELECT node_id, payload_json FROM graph_nodes ORDER BY revision, node_id").fetchall()
        for row in rows:
            row_node_id = str(row["node_id"] if isinstance(row, sqlite3.Row) else row[0])
            row_payload = str(row["payload_json"] if isinstance(row, sqlite3.Row) else row[1])
            payload = _json_loads(row_payload)
            node = GraphNode.from_dict(payload)
            connection.execute(
                """
                INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
                VALUES (?, ?)
                """,
                (row_node_id, _json_dumps(_node_runtime_payload(node))),
            )

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

    def commit_plan(self, proposal: PlanProposal) -> GraphRevision:
        errors = PlanValidator().validate(proposal)
        if errors:
            names = ", ".join(sorted(error.value for error in errors))
            raise ValueError(f"invalid plan proposal: {names}")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
            revision = int(row["revision"]) + 1
            connection.execute(
                """
                INSERT INTO graph_revisions (revision, graph_id, plan_attempt_id, root_node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    revision,
                    proposal.graph_id,
                    proposal.plan_attempt_id,
                    proposal.root_node_id,
                    _json_dumps(proposal.to_dict()),
                    _now(),
                ),
            )
            for node in proposal.nodes:
                connection.execute(
                    """
                    INSERT INTO graph_nodes (revision, node_id, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (revision, node.node_id, _json_dumps(_node_topology_payload(node))),
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
                    VALUES (?, ?)
                    """,
                    (node.node_id, _json_dumps(_node_runtime_payload(node))),
                )
            for source, target in proposal.blocks:
                connection.execute(
                    """
                    INSERT INTO graph_edges (revision, blocker_node_id, blocked_node_id)
                    VALUES (?, ?, ?)
                    """,
                    (revision, source, target),
                )
            for gate in proposal.gates:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO gate_snapshots (gate_hash, node_id, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (gate.hash, gate.task_id, _json_dumps(gate.to_dict())),
                )
        return GraphRevision(
            graph_id=proposal.graph_id,
            revision=revision,
            plan_attempt_id=proposal.plan_attempt_id,
            root_node_id=proposal.root_node_id,
        )

    def current_graph_revision(self) -> int:
        with self.connect() as connection:
            row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
        return int(row["revision"]) if row is not None else 0

    def current_graph_revision_record(self) -> GraphRevision | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT graph_id, revision, plan_attempt_id, root_node_id
                FROM graph_revisions
                ORDER BY revision DESC
                LIMIT 1
                """
            ).fetchone()
        if row is None:
            return None
        return GraphRevision(
            graph_id=str(row["graph_id"]),
            revision=int(row["revision"]),
            plan_attempt_id=str(row["plan_attempt_id"]),
            root_node_id=str(row["root_node_id"]),
        )

    def record_dispatch_context(self, node_id: str, context: dict[str, Any]) -> None:
        sanitized = {
            "node_id": node_id,
            "issue_id": str(context.get("issue_id") or ""),
            "issue_identifier": str(context.get("issue_identifier") or ""),
            "title": str(context.get("title") or ""),
            "description": _sanitize_error(str(context.get("description") or "")) if context.get("description") else "",
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO dispatch_context (node_id, payload_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (node_id, _json_dumps(sanitized), _now()),
            )

    def dispatch_context_for_node(self, node_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM dispatch_context WHERE node_id = ?",
                (node_id,),
            ).fetchone()
        if row is None:
            return {}
        return _json_loads(row["payload_json"])

    def get_node(self, node_id: str, *, revision: int | None = None) -> GraphNode:
        revision = self.current_graph_revision() if revision is None else revision
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = ? AND node_id = ?",
                (revision, node_id),
            ).fetchone()
            runtime_row = connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = ?",
                (node_id,),
            ).fetchone()
        if row is None:
            raise KeyError(node_id)
        runtime_payload = _json_loads(runtime_row["payload_json"]) if runtime_row is not None else None
        return _node_from_topology_and_runtime(_json_loads(row["payload_json"]), runtime_payload)

    def list_nodes(self) -> list[GraphNode]:
        revision = self.current_graph_revision()
        if revision <= 0:
            return []
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT graph_nodes.node_id, graph_nodes.payload_json AS topology_json, node_runtime_state.payload_json AS runtime_json
                FROM graph_nodes
                LEFT JOIN node_runtime_state ON node_runtime_state.node_id = graph_nodes.node_id
                WHERE graph_nodes.revision = ?
                ORDER BY graph_nodes.node_id
                """,
                (revision,),
            ).fetchall()
        return [
            _node_from_topology_and_runtime(
                _json_loads(row["topology_json"]),
                _json_loads(row["runtime_json"]) if row["runtime_json"] is not None else None,
            )
            for row in rows
        ]

    def blockers_for(self, node_id: str) -> list[str]:
        revision = self.current_graph_revision()
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT blocker_node_id FROM graph_edges
                WHERE revision = ? AND blocked_node_id = ?
                ORDER BY blocker_node_id
                """,
                (revision, node_id),
            ).fetchall()
        return [str(row["blocker_node_id"]) for row in rows]

    def dependents_for(self, node_id: str) -> list[str]:
        revision = self.current_graph_revision()
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT blocked_node_id FROM graph_edges
                WHERE revision = ? AND blocker_node_id = ?
                ORDER BY blocked_node_id
                """,
                (revision, node_id),
            ).fetchall()
        return [str(row["blocked_node_id"]) for row in rows]

    def current_blocks(self) -> list[tuple[str, str]]:
        revision = self.current_graph_revision()
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT blocker_node_id, blocked_node_id
                FROM graph_edges
                WHERE revision = ?
                ORDER BY rowid
                """,
                (revision,),
            ).fetchall()
        return [(str(row["blocker_node_id"]), str(row["blocked_node_id"])) for row in rows]

    def children_for(self, parent_node_id: str) -> list[GraphNode]:
        revision = self.current_graph_revision()
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT graph_nodes.payload_json AS topology_json, node_runtime_state.payload_json AS runtime_json
                FROM graph_nodes
                LEFT JOIN node_runtime_state ON node_runtime_state.node_id = graph_nodes.node_id
                WHERE graph_nodes.revision = ?
                ORDER BY graph_nodes.node_id
                """,
                (revision,),
            ).fetchall()
        return [
            node
            for row in rows
            for node in [
                _node_from_topology_and_runtime(
                    _json_loads(row["topology_json"]),
                    _json_loads(row["runtime_json"]) if row["runtime_json"] is not None else None,
                )
            ]
            if node.parent_node_id == parent_node_id
        ]

    def derive_parent_state(self, parent_node_id: str) -> GraphNodeState:
        children = self.children_for(parent_node_id)
        if not children:
            return self.get_node(parent_node_id).state
        if any(child.state is GraphNodeState.AWAITING_HUMAN for child in children):
            return GraphNodeState.AWAITING_HUMAN
        if any(child.state is GraphNodeState.FAILED for child in children):
            return GraphNodeState.FAILED
        if all(child.state in {GraphNodeState.VERIFY_PASSED, GraphNodeState.SUPERSEDED} for child in children):
            return GraphNodeState.VERIFY_PASSED
        return GraphNodeState.PLANNED

    def refresh_aggregate_parent_state(self, parent_node_id: str) -> GraphNode:
        children = self.children_for(parent_node_id)
        parent = self.get_node(parent_node_id)
        state = self.derive_parent_state(parent_node_id)
        verify_score = (
            min(int(child.verify_score or 0) for child in children if child.state is GraphNodeState.VERIFY_PASSED)
            if state is GraphNodeState.VERIFY_PASSED and children
            else None
        )
        return GraphNode(
            node_id=parent.node_id,
            title=parent.title,
            state=state,
            issue_id=parent.issue_id,
            issue_identifier=parent.issue_identifier,
            parent_node_id=parent.parent_node_id,
            gate_snapshot_hash=parent.gate_snapshot_hash,
            verify_score=verify_score,
            rework_count=parent.rework_count,
            superseded_by=list(parent.superseded_by),
            human_reason=parent.human_reason,
        )

    def gate_for_node(self, node_id: str) -> GateSpecSnapshot | None:
        try:
            node = self.get_node(node_id)
        except KeyError:
            return None
        if not node.gate_snapshot_hash:
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM gate_snapshots WHERE gate_hash = ?",
                (node.gate_snapshot_hash,),
            ).fetchone()
        return GateSpecSnapshot.from_dict(_json_loads(row["payload_json"])) if row is not None else None

    def update_node_state(
        self,
        node_id: str,
        state: GraphNodeState,
        *,
        verify_score: int | None = None,
        human_reason: Any = _UNCHANGED,
        rework_count: int | None = None,
    ) -> GraphNode:
        with self.connect() as connection:
            updated = self._update_node_state_on_connection(
                connection,
                node_id,
                state,
                verify_score=verify_score,
                human_reason=human_reason,
                rework_count=rework_count,
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
    ) -> WorkerLease:
        try:
            existing_attempt = self.get_attempt(attempt_id)
        except KeyError:
            existing_attempt = None
        if existing_attempt is not None:
            if existing_attempt.state is not AttemptState.RUNNING:
                raise ValueError("terminal_attempt_immutable")
            raise ValueError("attempt_already_exists")
        node = self.get_node(node_id)
        if mode is RuntimeMode.PLAN:
            next_state = GraphNodeState.REPLANNING
        elif mode is RuntimeMode.EXECUTE:
            self._require_frozen_gate_for_attempt(node)
            next_state = GraphNodeState.EXECUTING
        else:
            self._require_frozen_gate_for_attempt(node)
            self._require_verification_input_for_attempt(node)
            next_state = GraphNodeState.VERIFYING
        lease = self.acquire_lease(mode, node_id=node_id, attempt_id=attempt_id, now=now, ttl_seconds=ttl_seconds)
        graph_revision = self.current_graph_revision()
        policy_revision = self.active_runtime_config().scheduler_policy.version
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
        )
        connection.execute(
            """
            UPDATE attempts
            SET state = ?, payload_json = ?
            WHERE attempt_id = ?
            """,
            (AttemptState.TIMED_OUT.value, _json_dumps(updated.to_dict()), updated.attempt_id),
        )
        self._create_human_wait_on_connection(
            connection,
            attempt.node_id,
            reason=HumanEscalationReason.CAPACITY_STARVED,
            details={
                "mode": attempt.mode.value,
                "attempt_id": attempt.attempt_id,
                "lease_id": lease.lease_id,
                "error": error,
            },
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
                INSERT OR REPLACE INTO verification_inputs (execute_attempt_id, node_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (snapshot.execute_attempt_id, snapshot.task_id, _json_dumps(snapshot.to_dict())),
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
                ORDER BY execute_attempt_id DESC
                LIMIT 1
                """,
                (node_id,),
            ).fetchone()
        return VerificationInputSnapshot.from_dict(_json_loads(row["payload_json"])) if row is not None else None

    def publish_task_output_manifest(self, manifest: TaskOutputManifest) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO task_output_manifests (verify_attempt_id, node_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (manifest.verify_attempt_id, manifest.node_id, _json_dumps(manifest.to_dict())),
            )

    def enqueue_integration(self, manifest: TaskOutputManifest) -> dict[str, Any]:
        integration_id = f"integration-{manifest.node_id}-{manifest.verify_attempt_id}"
        payload = {
            "integration_id": integration_id,
            "node_id": manifest.node_id,
            "verify_attempt_id": manifest.verify_attempt_id,
            "gate_snapshot_hash": manifest.gate_snapshot_hash,
            "status": "queued",
            "integrated_revision": None,
            "created_at": _now(),
            "completed_at": None,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO integration_queue
                  (integration_id, node_id, verify_attempt_id, status, payload_json, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    integration_id,
                    manifest.node_id,
                    manifest.verify_attempt_id,
                    "queued",
                    _json_dumps(payload),
                    payload["created_at"],
                    None,
                ),
            )
        return payload

    def list_integration_queue(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM integration_queue ORDER BY created_at, integration_id",
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def current_integrated_revision(self, repository_path: Path | str) -> str | None:
        graph_id = self._current_graph_id()
        if not graph_id:
            return None
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT integrated_revision FROM repository_integrations
                WHERE graph_id = ? AND repository_path = ?
                """,
                (graph_id, _repository_integration_path(repository_path)),
            ).fetchone()
        if row is None:
            return None
        revision = str(row["integrated_revision"] or "").strip()
        return revision or None

    def _record_integrated_revision(self, repository_path: Path | str, integrated_revision: str) -> None:
        graph_id = self._current_graph_id()
        if not graph_id:
            return
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO repository_integrations (graph_id, repository_path, integrated_revision, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(graph_id, repository_path) DO UPDATE SET
                  integrated_revision = excluded.integrated_revision,
                  updated_at = excluded.updated_at
                """,
                (graph_id, _repository_integration_path(repository_path), integrated_revision, _now()),
            )

    def _current_graph_id(self) -> str:
        revision = self.current_graph_revision_record()
        return revision.graph_id if revision is not None else ""

    def process_queued_integrations(self, repository_path: Path, *, instance: Any | None = None) -> int:
        processed = 0
        for item in self.list_integration_queue():
            if item.get("status") != "queued":
                continue
            try:
                integrated_revision = self._integrate_manifest_patch(repository_path, str(item["verify_attempt_id"]))
            except Exception as exc:
                error = _sanitize_error(exc)
                completed = self.complete_integration(str(item["integration_id"]), status="conflict", error=error)
                _append_pipeline_log_event(
                    instance,
                    "pipeline_integration_conflicted",
                    graph_revision=self.current_graph_revision(),
                    policy_revision=self.active_runtime_config().scheduler_policy.version,
                    node_id=str(completed.get("node_id") or ""),
                    attempt_id=str(completed.get("verify_attempt_id") or ""),
                    mode=RuntimeMode.VERIFY.value,
                    lease_id="",
                    integration_id=str(completed.get("integration_id") or ""),
                    error_type=exc.__class__.__name__,
                    sanitized_reason=error,
                    action_required=HumanEscalationReason.LINEAR_SYNC_CONFLICT.value,
                )
                processed += 1
                continue
            completed = self.complete_integration(
                str(item["integration_id"]),
                status="integrated",
                integrated_revision=integrated_revision,
            )
            _append_pipeline_log_event(
                instance,
                "pipeline_integration_completed",
                graph_revision=self.current_graph_revision(),
                policy_revision=self.active_runtime_config().scheduler_policy.version,
                node_id=str(completed.get("node_id") or ""),
                attempt_id=str(completed.get("verify_attempt_id") or ""),
                mode=RuntimeMode.VERIFY.value,
                lease_id="",
                integration_id=str(completed.get("integration_id") or ""),
                integrated_revision=integrated_revision,
            )
            processed += 1
        return processed

    def _integrate_manifest_patch(self, repository_path: Path, verify_attempt_id: str) -> str:
        manifest = self._task_output_manifest_for_verify_attempt(verify_attempt_id)
        if manifest is None:
            raise ValueError("task output manifest not found")
        code = manifest.code
        base_revision = str(code.get("base_revision") or "").strip()
        patch_uri = str(code.get("patch_uri") or "").strip()
        expected_tree = str(code.get("expected_result_tree") or "").strip()
        patch_hash = str(code.get("patch_hash") or "").strip()
        if not base_revision or not patch_uri.startswith("file://") or not expected_tree:
            raise ValueError("manifest lacks integration inputs")
        patch_path = Path(patch_uri.removeprefix("file://"))
        if not patch_path.is_file():
            raise ValueError("integration patch unavailable")
        if patch_hash.startswith("sha256:"):
            actual_patch_hash = "sha256:" + hashlib.sha256(patch_path.read_bytes()).hexdigest()
            if actual_patch_hash != patch_hash:
                raise ValueError("patch_hash_mismatch")
        original_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
        integration_base = self.current_integrated_revision(repository_path) or original_revision
        try:
            self._verify_manifest_patch_against_base(
                repository_path,
                base_revision=base_revision,
                patch_path=patch_path,
                expected_tree=expected_tree,
                verify_attempt_id=verify_attempt_id,
            )
            _git(["checkout", "--quiet", integration_base], cwd=repository_path)
            try:
                _git(["apply", "--check", str(patch_path)], cwd=repository_path)
            except Exception as apply_exc:
                try:
                    _git(["apply", "--reverse", "--check", str(patch_path)], cwd=repository_path)
                except Exception:
                    raise apply_exc
                integrated_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
                self._record_integrated_revision(repository_path, integrated_revision)
                return integrated_revision
            _git(["apply", "--index", str(patch_path)], cwd=repository_path)
            _git(["write-tree"], cwd=repository_path).strip()
            _git(["commit", "--quiet", "-m", f"Integrate pipeline node {manifest.node_id}"], cwd=repository_path)
            integrated_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
            self._record_integrated_revision(repository_path, integrated_revision)
            return integrated_revision
        except Exception:
            _rollback_repository(repository_path, original_revision)
            raise

    def _verify_manifest_patch_against_base(
        self,
        repository_path: Path,
        *,
        base_revision: str,
        patch_path: Path,
        expected_tree: str,
        verify_attempt_id: str,
    ) -> None:
        worktree_parent = self.artifact_root / "integration-worktrees"
        worktree_parent.mkdir(parents=True, exist_ok=True)
        worktree_path = Path(
            tempfile.mkdtemp(prefix=f"{_safe_path_part(verify_attempt_id)}-", dir=str(worktree_parent))
        )
        try:
            shutil.rmtree(worktree_path)
            _git(["worktree", "add", "--detach", "--quiet", str(worktree_path), base_revision], cwd=repository_path)
            _git(["apply", "--index", str(patch_path)], cwd=worktree_path)
            actual_tree = _git(["write-tree"], cwd=worktree_path).strip()
            if actual_tree != expected_tree:
                raise ValueError("integrated tree mismatch")
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repository_path,
                check=False,
                capture_output=True,
                text=True,
            )
            shutil.rmtree(worktree_path, ignore_errors=True)
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=repository_path,
                check=False,
                capture_output=True,
                text=True,
            )

    def _task_output_manifest_for_verify_attempt(self, verify_attempt_id: str) -> TaskOutputManifest | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM task_output_manifests WHERE verify_attempt_id = ?",
                (verify_attempt_id,),
            ).fetchone()
        return TaskOutputManifest.from_dict(_json_loads(row["payload_json"])) if row is not None else None

    def complete_integration(
        self,
        integration_id: str,
        *,
        status: str,
        integrated_revision: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload_json FROM integration_queue WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
            if row is None:
                raise KeyError(integration_id)
            payload = _json_loads(row["payload_json"])
            payload.update(
                {
                    "status": status,
                    "integrated_revision": integrated_revision,
                    "error": error,
                    "completed_at": _now(),
                }
            )
            connection.execute(
                """
                UPDATE integration_queue
                SET status = ?, payload_json = ?, completed_at = ?
                WHERE integration_id = ?
                """,
                (status, _json_dumps(payload), payload["completed_at"], integration_id),
            )
            if status == "integrated" and integrated_revision:
                manifest_row = connection.execute(
                    "SELECT payload_json FROM task_output_manifests WHERE verify_attempt_id = ?",
                    (payload["verify_attempt_id"],),
                ).fetchone()
                if manifest_row is not None:
                    manifest_payload = _json_loads(manifest_row["payload_json"])
                    code = manifest_payload.get("code") if isinstance(manifest_payload.get("code"), dict) else {}
                    code["integrated_revision"] = integrated_revision
                    manifest_payload["code"] = code
                    connection.execute(
                        "UPDATE task_output_manifests SET payload_json = ? WHERE verify_attempt_id = ?",
                        (_json_dumps(manifest_payload), payload["verify_attempt_id"]),
                    )
            elif status in {"conflict", "failed"}:
                reason = HumanEscalationReason.LINEAR_SYNC_CONFLICT
                self._create_human_wait_on_connection(
                    connection,
                    str(payload["node_id"]),
                    reason=reason,
                    details={
                        "integration_id": integration_id,
                        "verify_attempt_id": payload["verify_attempt_id"],
                        "status": status,
                        "error": error,
                    },
                )
        return payload

    def list_task_output_manifests(self) -> list[TaskOutputManifest]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM task_output_manifests ORDER BY verify_attempt_id",
            ).fetchall()
        return [TaskOutputManifest.from_dict(_json_loads(row["payload_json"])) for row in rows]

    def integrated_manifest_for_node(self, node_id: str) -> TaskOutputManifest | None:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM task_output_manifests
                WHERE node_id = ?
                ORDER BY verify_attempt_id DESC
                """,
                (node_id,),
            ).fetchall()
        for row in rows:
            manifest = TaskOutputManifest.from_dict(_json_loads(row["payload_json"]))
            if str(manifest.code.get("integrated_revision") or "").strip():
                return manifest
        return None

    def integration_terminal_for_node(self, node_id: str) -> bool:
        if self.integrated_manifest_for_node(node_id) is not None:
            return True
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM integration_queue
                WHERE node_id = ?
                ORDER BY completed_at DESC, integration_id DESC
                """,
                (node_id,),
            ).fetchall()
        for row in rows:
            payload = _json_loads(row["payload_json"])
            if (
                payload.get("status") == "resolved"
                and str(payload.get("human_resolution") or "").strip()
                and str(payload.get("completed_at") or "").strip()
            ):
                return True
        return False

    def integrated_manifests_for_blockers(self, node_id: str) -> list[TaskOutputManifest]:
        manifests: list[TaskOutputManifest] = []
        for blocker_id in self.blockers_for(node_id):
            manifest = self.integrated_manifest_for_node(blocker_id)
            if manifest is not None:
                manifests.append(manifest)
        return manifests

    def create_human_wait(
        self,
        node_id: str,
        *,
        reason: str,
        child_issue_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        reason_enum = HumanEscalationReason(reason)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            payload = self._create_human_wait_on_connection(
                connection,
                node_id,
                reason=reason_enum,
                child_issue_id=child_issue_id,
                details=details,
            )
        return payload

    def _create_human_wait_on_connection(
        self,
        connection: sqlite3.Connection,
        node_id: str,
        *,
        reason: HumanEscalationReason,
        child_issue_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        wait_id = f"human-wait-{node_id}-{uuid4().hex}"
        payload = {
            "wait_id": wait_id,
            "node_id": node_id,
            "reason": reason.value,
            "child_issue_id": child_issue_id,
            "status": "waiting",
            "created_at": _now(),
            "resolved_at": None,
            "resolution": None,
            "details": dict(details or {}),
        }
        connection.execute(
            """
            INSERT INTO human_waits (wait_id, node_id, status, payload_json, created_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (wait_id, node_id, "waiting", _json_dumps(payload), payload["created_at"], None),
        )
        self._update_node_state_on_connection(
            connection,
            node_id,
            GraphNodeState.AWAITING_HUMAN,
            human_reason=reason,
        )
        return payload

    def resume_human_wait(self, wait_id: str, *, resolution: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM human_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload.update({"status": "resolved", "resolution": resolution, "resolved_at": _now()})
            connection.execute(
                "UPDATE human_waits SET status = ?, payload_json = ?, resolved_at = ? WHERE wait_id = ?",
                ("resolved", _json_dumps(payload), payload["resolved_at"], wait_id),
            )
            if payload.get("reason") == HumanEscalationReason.LINEAR_SYNC_CONFLICT.value:
                details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
                integration_id = str(details.get("integration_id") or "").strip()
                if integration_id:
                    integration_row = connection.execute(
                        "SELECT payload_json FROM integration_queue WHERE integration_id = ?",
                        (integration_id,),
                    ).fetchone()
                    if integration_row is not None:
                        integration_payload = _json_loads(integration_row["payload_json"])
                        integration_payload.update(
                            {
                                "status": "resolved",
                                "human_resolution": resolution,
                                "completed_at": payload["resolved_at"],
                            }
                        )
                        connection.execute(
                            """
                            UPDATE integration_queue
                            SET status = ?, payload_json = ?, completed_at = ?
                            WHERE integration_id = ?
                            """,
                            ("resolved", _json_dumps(integration_payload), payload["resolved_at"], integration_id),
                        )
            self._update_node_state_on_connection(
                connection,
                str(payload["node_id"]),
                _resume_state_for_human_wait(payload),
                human_reason=None,
            )
        return payload

    def attach_human_wait_child_issue(self, wait_id: str, *, child_issue_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM human_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload["child_issue_id"] = child_issue_id
            connection.execute(
                "UPDATE human_waits SET payload_json = ? WHERE wait_id = ?",
                (_json_dumps(payload), wait_id),
            )
        return payload

    def list_human_waits(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT payload_json FROM human_waits ORDER BY created_at, wait_id").fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def record_runtime_wait(
        self,
        *,
        attempt_id: str,
        node_id: str,
        mode: RuntimeMode,
        wait_kind: str,
        message: str | None = None,
        command: str | None = None,
        thread_id: str | None = None,
        turn_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        log_path: str | None = None,
    ) -> bool:
        wait_kind = _normalize_runtime_wait_kind(wait_kind)
        wait_id = f"runtime-wait-{attempt_id}-{wait_kind}"
        now = _now()
        sanitized_message = _sanitize_error(message or "") if message else None
        sanitized_command = _sanitize_error(command or "") if command else None
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            existing = _json_loads(row["payload_json"]) if row is not None else {}
            payload = {
                "wait_id": wait_id,
                "attempt_id": attempt_id,
                "node_id": node_id,
                "mode": mode.value,
                "wait_kind": wait_kind,
                "status": "waiting",
                "message": sanitized_message,
                "command": sanitized_command,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "log_path": log_path,
                "child_issue_id": existing.get("child_issue_id") or None,
                "created_at": existing.get("created_at") or now,
                "updated_at": now,
                "resolved_at": None,
                "resolution": None,
            }
            comparable_payload = {key: value for key, value in payload.items() if key != "updated_at"}
            comparable_existing = {key: value for key, value in existing.items() if key != "updated_at"}
            changed = comparable_payload != comparable_existing
            connection.execute(
                """
                INSERT INTO runtime_waits (
                  wait_id, attempt_id, node_id, mode, status, payload_json, created_at, updated_at, resolved_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(wait_id) DO UPDATE SET
                  node_id = excluded.node_id,
                  mode = excluded.mode,
                  status = excluded.status,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at,
                  resolved_at = excluded.resolved_at
                """,
                (
                    wait_id,
                    attempt_id,
                    node_id,
                    mode.value,
                    "waiting",
                    _json_dumps(payload),
                    payload["created_at"],
                    payload["updated_at"],
                    None,
                ),
            )
        return changed

    def resolve_runtime_waits_for_attempt(self, attempt_id: str, *, resolution: str) -> int:
        now = _now()
        resolved = 0
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT wait_id, payload_json FROM runtime_waits WHERE attempt_id = ? AND status = ?",
                (attempt_id, "waiting"),
            ).fetchall()
            for row in rows:
                payload = _json_loads(row["payload_json"])
                payload.update({"status": "resolved", "resolution": resolution, "resolved_at": now, "updated_at": now})
                connection.execute(
                    """
                    UPDATE runtime_waits
                    SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
                    WHERE wait_id = ?
                    """,
                    ("resolved", _json_dumps(payload), now, now, str(row["wait_id"])),
                )
                resolved += 1
        return resolved

    def resolve_runtime_wait(self, wait_id: str, *, resolution: str) -> dict[str, Any]:
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload.update({"status": "resolved", "resolution": resolution, "resolved_at": now, "updated_at": now})
            connection.execute(
                """
                UPDATE runtime_waits
                SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
                WHERE wait_id = ?
                """,
                ("resolved", _json_dumps(payload), now, now, wait_id),
            )
        return payload

    def list_runtime_waits(self, *, status: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as connection:
            if status is None:
                rows = connection.execute(
                    "SELECT payload_json FROM runtime_waits ORDER BY updated_at DESC, wait_id",
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT payload_json FROM runtime_waits WHERE status = ? ORDER BY updated_at DESC, wait_id",
                    (status,),
                ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def active_runtime_wait_for_node(self, node_id: str) -> dict[str, Any] | None:
        waits = [
            wait
            for wait in self.list_runtime_waits(status="waiting")
            if str(wait.get("node_id") or "") == node_id
        ]
        return waits[0] if waits else None

    def attach_runtime_wait_child_issue(self, wait_id: str, *, child_issue_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload["child_issue_id"] = child_issue_id
            payload["updated_at"] = _now()
            connection.execute(
                """
                UPDATE runtime_waits
                SET payload_json = ?, updated_at = ?
                WHERE wait_id = ?
                """,
                (_json_dumps(payload), payload["updated_at"], wait_id),
            )
        return payload

    def record_linear_projection(
        self,
        *,
        node_id: str,
        linear_issue_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        projection_id = f"{node_id}:{linear_issue_id}"
        payload = {
            "projection_id": projection_id,
            "node_id": node_id,
            "linear_issue_id": linear_issue_id,
            "metadata": metadata,
            "updated_at": _now(),
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO linear_projections (projection_id, node_id, linear_issue_id, payload_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(projection_id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (projection_id, node_id, linear_issue_id, _json_dumps(payload), payload["updated_at"]),
            )
        return payload

    def list_linear_projections(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM linear_projections ORDER BY projection_id",
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def prune_linear_projections_except(self, node_ids: set[str]) -> int:
        with self.connect() as connection:
            rows = connection.execute("SELECT projection_id, node_id FROM linear_projections").fetchall()
            stale_projection_ids = [
                str(row["projection_id"])
                for row in rows
                if str(row["node_id"] or "") not in node_ids
            ]
            if not stale_projection_ids:
                return 0
            connection.executemany(
                "DELETE FROM linear_projections WHERE projection_id = ?",
                [(projection_id,) for projection_id in stale_projection_ids],
            )
        return len(stale_projection_ids)

    def linear_projection_metadata(self, node: GraphNode, revision: GraphRevision) -> dict[str, Any]:
        runtime_wait = self.active_runtime_wait_for_node(node.node_id)
        metadata = {
            "graph_id": revision.graph_id,
            "node_id": node.node_id,
            "plan_attempt_id": revision.plan_attempt_id,
            "gate_snapshot_hash": node.gate_snapshot_hash,
            "conductor_revision": revision.revision,
            "operator_status": self._linear_operator_status(node, runtime_wait=runtime_wait),
        }
        if runtime_wait is not None:
            metadata["operator_wait_kind"] = runtime_wait.get("wait_kind")
        return metadata

    def _linear_operator_status(self, node: GraphNode, *, runtime_wait: dict[str, Any] | None = None) -> str:
        if runtime_wait is not None:
            return "waiting_for_runtime_input"
        active_human_waits = [
            wait
            for wait in self.list_human_waits()
            if str(wait.get("node_id") or "") == node.node_id and str(wait.get("status") or "waiting") == "waiting"
        ]
        if active_human_waits or node.state is GraphNodeState.AWAITING_HUMAN:
            return "awaiting_human_action"
        for mode in RuntimeMode:
            if self.active_lease(node.node_id, mode) is not None:
                return f"running_{mode.value}"
        return node.state.value

    def _current_linear_projections(self, nodes: list[GraphNode]) -> list[dict[str, Any]]:
        revision = self.current_graph_revision_record()
        if revision is None:
            return []
        nodes_by_id = {node.node_id: node for node in nodes}
        self.prune_linear_projections_except(set(nodes_by_id))
        projections: list[dict[str, Any]] = []
        for projection in self.list_linear_projections():
            node_id = str(projection.get("node_id") or "")
            node = nodes_by_id.get(node_id)
            if node is None:
                continue
            refreshed = dict(projection)
            refreshed["metadata"] = self.linear_projection_metadata(node, revision)
            projections.append(refreshed)
        return projections

    def reject_superseded_edges(self, edges: list[tuple[str, str]]) -> list[tuple[str, str]]:
        node_by_id = {node.node_id: node for node in self.list_nodes()}
        superseded_node_ids = {node_id for node_id, node in node_by_id.items() if node.state is GraphNodeState.SUPERSEDED}
        return [
            (source, target)
            for source, target in edges
            if source not in superseded_node_ids and target not in superseded_node_ids
        ]

    def ignore_missing_remote_edges(self, remote_edges: list[tuple[str, str]]) -> list[tuple[str, str]]:
        node_by_id = {node.node_id: node for node in self.list_nodes()}
        live_node_ids = {node_id for node_id, node in node_by_id.items() if node.state is not GraphNodeState.SUPERSEDED}
        current_edges = [
            (source_node_id, target_node_id)
            for source_node_id in live_node_ids
            for target_node_id in self.dependents_for(source_node_id)
            if target_node_id in live_node_ids
        ]
        return list(dict.fromkeys([*current_edges, *self.reject_superseded_edges(remote_edges)]))

    def merge_human_added_blocks(self, edges: list[tuple[str, str]], *, reason: str) -> GraphRevision | None:
        current = self.current_graph_revision_record()
        if current is None:
            return None
        normalized_edges = self.ignore_missing_remote_edges(edges)
        existing_all_edges = [
            (source, target)
            for node in self.list_nodes()
            for source in [node.node_id]
            for target in self.dependents_for(source)
        ]
        if sorted(existing_all_edges) == sorted(normalized_edges):
            return None
        nodes = self.list_nodes()
        node_ids = {node.node_id for node in nodes}
        if any(source not in node_ids or target not in node_ids or source == target for source, target in normalized_edges):
            raise ValueError("linear blocks include unknown or illegal graph node")
        if PlanValidator().validate(
            PlanProposal(
                graph_id=current.graph_id,
                plan_attempt_id=current.plan_attempt_id,
                root_node_id=current.root_node_id,
                nodes=nodes,
                blocks=normalized_edges,
                gates=[gate for node in nodes for gate in [self.gate_for_node(node.node_id)] if gate is not None],
                entry_node_ids=[node.node_id for node in nodes if node.node_id not in {target for _source, target in normalized_edges}],
                exit_node_ids=[node.node_id for node in nodes if node.node_id not in {source for source, _target in normalized_edges}],
            )
        ):
            raise ValueError("linear blocks do not form a valid pipeline graph")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM graph_revisions WHERE revision = ?", (current.revision,)).fetchone()
            proposal_payload = _json_loads(row["payload_json"]) if row is not None else {}
            proposal_payload["blocks"] = [[source, target] for source, target in normalized_edges]
            proposal_payload["linear_ingestion_reason"] = reason
            revision_row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
            revision = int(revision_row["revision"]) + 1
            connection.execute(
                """
                INSERT INTO graph_revisions (revision, graph_id, plan_attempt_id, root_node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    revision,
                    current.graph_id,
                    current.plan_attempt_id,
                    current.root_node_id,
                    _json_dumps(proposal_payload),
                    _now(),
                ),
            )
            for node in nodes:
                connection.execute(
                    """
                    INSERT INTO graph_nodes (revision, node_id, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (revision, node.node_id, _json_dumps(_node_topology_payload(node))),
                )
            for source, target in normalized_edges:
                connection.execute(
                    """
                    INSERT INTO graph_edges (revision, blocker_node_id, blocked_node_id)
                    VALUES (?, ?, ?)
                    """,
                    (revision, source, target),
                )
        return GraphRevision(
            graph_id=current.graph_id,
            revision=revision,
            plan_attempt_id=current.plan_attempt_id,
            root_node_id=current.root_node_id,
        )

    def replace_current_edges_from_linear(self, edges: list[tuple[str, str]], *, reason: str) -> GraphRevision | None:
        return self.merge_human_added_blocks(edges, reason=reason)

    def replace_node_with_subgraph(self, node_id: str, subgraph: PlanProposal) -> GraphRevision:
        errors = PlanValidator().validate(subgraph)
        if errors:
            names = ", ".join(sorted(error.value for error in errors))
            raise ValueError(f"invalid replacement subgraph: {names}")
        current_revision = self.current_graph_revision()
        if current_revision <= 0:
            raise KeyError(node_id)
        nodes = {node.node_id: node for node in self.list_nodes()}
        if node_id not in nodes:
            raise KeyError(node_id)
        upstream = self.blockers_for(node_id)
        downstream = self.dependents_for(node_id)
        replacement_ids = [node.node_id for node in subgraph.nodes]
        subgraph_node_ids = set(replacement_ids)
        if node_id in subgraph_node_ids:
            raise ValueError("replacement subgraph reuses superseded node_id")
        existing_conflicts = sorted(subgraph_node_ids.intersection(nodes) - {node_id})
        if existing_conflicts:
            raise ValueError(f"replacement subgraph reuses existing node_id: {', '.join(existing_conflicts)}")
        retained_nodes = [node for key, node in nodes.items() if key not in subgraph_node_ids]
        old = nodes[node_id]
        retained_nodes = [
            GraphNode(
                node_id=old.node_id,
                title=old.title,
                state=GraphNodeState.SUPERSEDED,
                issue_id=old.issue_id,
                issue_identifier=old.issue_identifier,
                parent_node_id=old.parent_node_id,
                gate_snapshot_hash=old.gate_snapshot_hash,
                verify_score=old.verify_score,
                rework_count=old.rework_count,
                superseded_by=replacement_ids,
                human_reason=old.human_reason,
            )
            if node.node_id == node_id
            else node
            for node in retained_nodes
        ]
        replacement_nodes = [
            GraphNode(
                node_id=node.node_id,
                title=node.title,
                state=node.state,
                issue_id=node.issue_id,
                issue_identifier=node.issue_identifier,
                parent_node_id=self._replacement_parent_node_id(
                    node.parent_node_id,
                    inherited_parent_id=old.parent_node_id,
                    subgraph_node_ids=subgraph_node_ids,
                ),
                gate_snapshot_hash=node.gate_snapshot_hash,
                verify_score=node.verify_score,
                rework_count=node.rework_count,
                superseded_by=list(node.superseded_by),
                human_reason=node.human_reason,
            )
            for node in subgraph.nodes
        ]
        existing_edges = [
            (source, target)
            for source in nodes
            for target in self.dependents_for(source)
            if source != node_id and target != node_id and source not in subgraph_node_ids and target not in subgraph_node_ids
        ]
        new_edges = list(dict.fromkeys(existing_edges + subgraph.blocks))
        for source in upstream:
            for entry in subgraph.entry_node_ids:
                new_edges.append((source, entry))
        for exit_node in subgraph.exit_node_ids:
            for target in downstream:
                new_edges.append((exit_node, target))
        new_edges = list(dict.fromkeys(new_edges))
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
            revision = int(row["revision"]) + 1
            proposal_payload = subgraph.to_dict()
            connection.execute(
                """
                INSERT INTO graph_revisions (revision, graph_id, plan_attempt_id, root_node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    revision,
                    subgraph.graph_id,
                    subgraph.plan_attempt_id,
                    subgraph.root_node_id,
                    _json_dumps(proposal_payload),
                    _now(),
                ),
            )
            for node in [*retained_nodes, *replacement_nodes]:
                connection.execute(
                    """
                    INSERT INTO graph_nodes (revision, node_id, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (revision, node.node_id, _json_dumps(_node_topology_payload(node))),
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
                    VALUES (?, ?)
                    """,
                    (node.node_id, _json_dumps(_node_runtime_payload(node))),
                )
            connection.execute(
                """
                INSERT INTO node_runtime_state (node_id, payload_json)
                VALUES (?, ?)
                ON CONFLICT(node_id) DO UPDATE SET payload_json = excluded.payload_json
                """,
                (node_id, _json_dumps(_node_runtime_payload(next(node for node in retained_nodes if node.node_id == node_id)))),
            )
            for source, target in new_edges:
                connection.execute(
                    """
                    INSERT INTO graph_edges (revision, blocker_node_id, blocked_node_id)
                    VALUES (?, ?, ?)
                    """,
                    (revision, source, target),
                )
            for gate in subgraph.gates:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO gate_snapshots (gate_hash, node_id, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (gate.hash, gate.task_id, _json_dumps(gate.to_dict())),
                )
        return GraphRevision(
            graph_id=subgraph.graph_id,
            revision=revision,
            plan_attempt_id=subgraph.plan_attempt_id,
            root_node_id=subgraph.root_node_id,
        )

    @staticmethod
    def _replacement_parent_node_id(
        candidate_parent_id: str | None,
        *,
        inherited_parent_id: str | None,
        subgraph_node_ids: set[str],
    ) -> str | None:
        if candidate_parent_id in subgraph_node_ids or candidate_parent_id == inherited_parent_id:
            return candidate_parent_id
        if candidate_parent_id:
            return inherited_parent_id
        return inherited_parent_id

    def complete_attempt_with_fencing(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        at: datetime,
    ) -> bool:
        if not self._result_fence_is_valid(result, at=at):
            return False
        node = self.get_node(result.node_id)
        attempt = self.get_attempt(result.attempt_id)
        if attempt.mode is not result.mode or attempt.state is not AttemptState.RUNNING:
            return False
        terminal_state = result.status
        if terminal_state is not AttemptState.SUCCEEDED:
            visible_error = _visible_attempt_error(result)
            self._finish_attempt(result, state=terminal_state, at=at, error=visible_error)
            self._deactivate_lease(result.lease_id)
            self._create_attempt_failure_human_wait(result, error=visible_error)
            return True
        if isinstance(result, PlanAttemptResult):
            if result.proposal is None:
                return False
            validation_errors = PlanValidator().validate(result.proposal)
            if node.state is GraphNodeState.REPLANNING and self.latest_failed_verify_attempt_for_node(result.node_id) is not None:
                if validation_errors:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                        error=_plan_validation_error_summary(validation_errors),
                    )
                try:
                    self.replace_node_with_subgraph(result.node_id, result.proposal)
                except ValueError as exc:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                        error=_sanitize_error(exc),
                    )
            else:
                if validation_errors:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=_plan_validation_human_reason(validation_errors),
                        error=_plan_validation_error_summary(validation_errors),
                    )
                try:
                    self.commit_plan(result.proposal)
                except ValueError as exc:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=HumanEscalationReason.PLAN_INVALID,
                        error=_sanitize_error(exc),
                    )
        elif isinstance(result, ExecuteAttemptResult):
            snapshot = VerificationInputSnapshot.from_dict(result.verification_input or {})
            if not self._verification_input_matches_execute_result(snapshot, result):
                return False
            self.publish_verification_input(snapshot)
            self.update_node_state(result.node_id, GraphNodeState.VERIFYING)
        elif isinstance(result, VerifyAttemptResult):
            passed = result.passed and result.score >= PASS_THRESHOLD
            if passed:
                snapshot = self.verification_input_for_node(result.node_id)
                if (
                    snapshot is None
                    or snapshot.task_id != result.node_id
                    or snapshot.execute_attempt_id != result.execute_attempt_id
                    or snapshot.gate_snapshot_hash != result.gate_snapshot_hash
                ):
                    return False
                self.update_node_state(result.node_id, GraphNodeState.VERIFY_PASSED, verify_score=result.score)
                code = snapshot.to_dict()
                code["gate_snapshot_hash"] = result.gate_snapshot_hash
                manifest = TaskOutputManifest(
                    node_id=result.node_id,
                    verify_attempt_id=result.attempt_id,
                    gate_snapshot_hash=result.gate_snapshot_hash,
                    score=result.score,
                    code=code,
                )
                self.publish_task_output_manifest(manifest)
                self.enqueue_integration(manifest)
            else:
                next_rework_count = node.rework_count + 1
                max_rework_attempts = self.active_runtime_config().scheduler_policy.max_rework_attempts
                self.update_node_state(
                    result.node_id,
                    GraphNodeState.REPLANNING if next_rework_count >= max_rework_attempts else GraphNodeState.REWORKING,
                    verify_score=result.score,
                    rework_count=next_rework_count,
                )
        else:
            return False
        self._finish_attempt(
            result,
            state=AttemptState.SUCCEEDED,
            at=at,
            score=getattr(result, "score", None),
            error=result.error,
        )
        self._deactivate_lease(result.lease_id)
        return True

    def _fail_plan_attempt_with_human_wait(
        self,
        result: PlanAttemptResult,
        *,
        at: datetime,
        reason: HumanEscalationReason,
        error: str,
    ) -> bool:
        self._finish_attempt(result, state=AttemptState.FAILED, at=at, error=error)
        self._deactivate_lease(result.lease_id)
        self.create_human_wait(
            result.node_id,
            reason=reason.value,
            details={
                "mode": result.mode.value,
                "attempt_id": result.attempt_id,
                "lease_id": result.lease_id,
                "error": error,
            },
        )
        return True

    def _verification_input_matches_execute_result(
        self,
        snapshot: VerificationInputSnapshot,
        result: ExecuteAttemptResult,
    ) -> bool:
        if snapshot.task_id != result.node_id:
            return False
        if snapshot.execute_attempt_id != result.attempt_id:
            return False
        if snapshot.gate_snapshot_hash != result.gate_snapshot_hash:
            return False
        required = [
            snapshot.base_revision,
            snapshot.patch_uri,
            snapshot.patch_hash,
            snapshot.expected_result_tree,
            snapshot.evidence_uri,
            snapshot.repository_path,
            snapshot.workspace_path,
        ]
        if any(not str(value).strip() for value in required):
            return False
        if not snapshot.patch_hash.startswith("sha256:"):
            return False
        return True

    def _result_fence_is_valid(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        at: datetime,
    ) -> bool:
        try:
            attempt = self.get_attempt(result.attempt_id)
        except KeyError:
            return False
        if attempt.state is not AttemptState.RUNNING:
            return False
        if attempt.node_id != result.node_id or attempt.mode is not result.mode:
            return False
        if result.policy_revision != attempt.policy_revision:
            return False
        node = self.get_node(result.node_id)
        if node.state is GraphNodeState.SUPERSEDED:
            return False
        if result.mode is not RuntimeMode.PLAN and (node.gate_snapshot_hash or "") != result.gate_snapshot_hash:
            return False
        lease = self.active_lease(result.node_id, result.mode)
        if lease is None or lease.lease_id != result.lease_id or lease.attempt_id != result.attempt_id:
            return False
        return lease.is_active(at, fencing_token=result.fencing_token)

    def _finish_attempt(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        state: AttemptState,
        at: datetime,
        score: int | None = None,
        error: str | None = None,
    ) -> None:
        attempt = self.get_attempt(result.attempt_id)
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=state,
            graph_revision=attempt.graph_revision,
            policy_revision=attempt.policy_revision,
            lease_id=attempt.lease_id,
            fencing_token=attempt.fencing_token,
            gate_snapshot_hash=result.gate_snapshot_hash or attempt.gate_snapshot_hash,
            score=score,
            started_at=attempt.started_at,
            completed_at=_format_time(_utc(at)),
            result_uri=attempt.result_uri,
            error=error,
            process_pid=attempt.process_pid,
        )
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE attempts
                SET state = ?, payload_json = ?
                WHERE attempt_id = ?
                """,
                (state.value, _json_dumps(updated.to_dict()), updated.attempt_id),
            )
        self.resolve_runtime_waits_for_attempt(updated.attempt_id, resolution=f"attempt {state.value}")

    def _deactivate_lease(self, lease_id: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE worker_leases SET active = 0 WHERE lease_id = ?", (lease_id,))

    def _create_attempt_failure_human_wait(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        error: str | None = None,
    ) -> None:
        visible_error = error if error is not None else _visible_attempt_error(result)
        if isinstance(result, PlanAttemptResult):
            node = self.get_node(result.node_id)
            if node.state is GraphNodeState.REPLANNING and self.latest_failed_verify_attempt_for_node(result.node_id) is not None:
                reason = HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
            else:
                reason = _plan_failure_human_reason(visible_error)
        elif result.mode is RuntimeMode.VERIFY:
            reason = HumanEscalationReason.GATE_UNEXECUTABLE
        else:
            reason = HumanEscalationReason.BACKEND_UNAVAILABLE
        self.create_human_wait(
            result.node_id,
            reason=reason.value,
            details={
                "mode": result.mode.value,
                "attempt_id": result.attempt_id,
                "lease_id": result.lease_id,
                "error": visible_error,
            },
        )

    def pipeline_view(self) -> PipelineView:
        envelope = self.active_runtime_config()
        nodes = self.list_nodes()
        active_leases = self._active_leases()
        modes: list[PipelineModeView] = []
        for mode in RuntimeMode:
            active_node_ids = sorted(lease.node_id for lease in active_leases if lease.mode is mode)
            queued = [
                node.node_id
                for node in nodes
                if _queued_mode_for_state(node.state) is mode and node.node_id not in active_node_ids
            ]
            modes.append(
                PipelineModeView(
                    mode=mode,
                    active=len(active_node_ids),
                    limit=envelope.scheduler_policy.capacity.by_mode.get(mode),
                    queued=len(queued),
                    node_ids=active_node_ids + sorted(queued),
                )
            )
        return PipelineView(
            graph_revision=self.current_graph_revision(),
            policy_revision=envelope.scheduler_policy.version,
            nodes=[
                {
                    **node.to_dict(),
                    "graph_revision": self.current_graph_revision(),
                    "aggregate_state": self._aggregate_display_state(node),
                }
                for node in nodes
            ],
            modes=modes,
            predicted_call_order=self._predicted_call_order(nodes),
            capacity=envelope.scheduler_policy.capacity.to_dict(),
            blocks=self.current_blocks(),
            gates=[
                gate.to_dict()
                for node in nodes
                for gate in [self.gate_for_node(node.node_id)]
                if gate is not None
            ],
            leases=[lease.to_dict() for lease in active_leases],
            attempts=[attempt.to_dict() for attempt in self.list_attempts()],
            integration_queue=self.list_integration_queue(),
            manifests=[manifest.to_dict() for manifest in self.list_task_output_manifests()],
            human_waits=self.list_human_waits(),
            runtime_waits=self.list_runtime_waits(),
            linear_projections=self._current_linear_projections(nodes),
            prediction_basis={
                "graph_revision": self.current_graph_revision(),
                "policy_revision": envelope.scheduler_policy.version,
                "assumption": "unknown verifies pass",
                "generated_at": _now(),
                "dependency_policy": envelope.scheduler_policy.dependency_policy.value,
                "pass_threshold": PASS_THRESHOLD,
                "basis": "current graph revision, active leases, and VERIFY_PASSED blockers",
            },
            runtime_config=envelope.sanitized().to_dict(),
        )

    def _active_leases(self) -> list[WorkerLease]:
        with self.connect() as connection:
            rows = connection.execute("SELECT payload_json FROM worker_leases WHERE active = 1").fetchall()
        return [WorkerLease.from_dict(_json_loads(row["payload_json"])) for row in rows]

    def _predicted_call_order(self, nodes: list[GraphNode]) -> list[PredictedCall]:
        envelope = self.active_runtime_config()
        capacity = envelope.scheduler_policy.capacity
        node_by_id = {node.node_id: node for node in nodes}
        predicted_by_node: dict[str, int] = {}
        active_leases = self._active_leases()
        wave_usage: dict[int, dict[RuntimeMode, int]] = {1: {}}
        wave_global_usage: dict[int, int] = {1: len(active_leases)}
        for lease in active_leases:
            wave_usage[1][lease.mode] = wave_usage[1].get(lease.mode, 0) + 1
        order: list[PredictedCall] = []
        for node in self._topological_nodes(nodes):
            blocked_by: list[str] = []
            earliest_mode = _mode_for_state(node.state) if node.state in _DISPATCHABLE_STATES or node.state is GraphNodeState.PLANNED else None
            if node.state is GraphNodeState.AWAITING_HUMAN:
                reason = f" ({node.human_reason.value})" if node.human_reason is not None else ""
                blocked_by.append(f"{node.node_id}: awaiting human{reason}")
            elif node.state not in _PREDICTABLE_DISPATCH_STATES:
                blocked_by.append(f"{node.node_id}: {node.state.value} is not dispatchable")
            if node.state in _PREDICTABLE_DISPATCH_STATES:
                for blocker_id in self.blockers_for(node.node_id):
                    blocker = node_by_id.get(blocker_id)
                    if blocker is None:
                        continue
                    blocked_by.extend(self._dependency_block_reasons(blocker))
            predicted_position = None
            if not blocked_by and earliest_mode is not None:
                earliest_position = 1 + max(
                    (predicted_by_node[blocker_id] for blocker_id in self.blockers_for(node.node_id) if blocker_id in predicted_by_node),
                    default=0,
                )
                predicted_position = self._reserve_prediction_wave(
                    earliest_position,
                    earliest_mode,
                    capacity,
                    wave_usage,
                    wave_global_usage,
                )
                predicted_by_node[node.node_id] = predicted_position
            order.append(
                PredictedCall(
                    node_id=node.node_id,
                    predicted_position=predicted_position,
                    blocked_by=blocked_by,
                    earliest_mode=earliest_mode,
                    aggregate_state=self._aggregate_display_state(node),
                )
            )
        return order

    def _topological_nodes(self, nodes: list[GraphNode]) -> list[GraphNode]:
        node_by_id = {node.node_id: node for node in nodes}
        indegree = {node.node_id: 0 for node in nodes}
        outgoing = {node.node_id: [] for node in nodes}
        for node in nodes:
            for blocker_id in self.blockers_for(node.node_id):
                if blocker_id not in node_by_id:
                    continue
                outgoing[blocker_id].append(node.node_id)
                indegree[node.node_id] += 1
        ready = sorted(node_id for node_id, count in indegree.items() if count == 0)
        ordered: list[GraphNode] = []
        while ready:
            node_id = ready.pop(0)
            ordered.append(node_by_id[node_id])
            for dependent_id in sorted(outgoing[node_id]):
                indegree[dependent_id] -= 1
                if indegree[dependent_id] == 0:
                    ready.append(dependent_id)
                    ready.sort()
        if len(ordered) != len(nodes):
            return sorted(nodes, key=lambda item: item.node_id)
        return ordered

    def _dependency_block_reasons(self, blocker: GraphNode) -> list[str]:
        children = self.children_for(blocker.node_id)
        if children:
            derived_state = self.derive_parent_state(blocker.node_id)
            if derived_state is GraphNodeState.AWAITING_HUMAN:
                return [f"{blocker.node_id}: awaiting human"]
            if derived_state is not GraphNodeState.VERIFY_PASSED:
                return [f"{blocker.node_id}: verify not passed"]
            if not all(self._child_ready_for_aggregate_downstream(child) for child in children):
                return [f"{blocker.node_id}: integration not completed"]
            return []
        if blocker.state is GraphNodeState.AWAITING_HUMAN:
            reason = f" ({blocker.human_reason.value})" if blocker.human_reason is not None else ""
            return [f"{blocker.node_id}: awaiting human{reason}"]
        if not _node_verify_passed(blocker):
            return [f"{blocker.node_id}: verify not passed"]
        if not self.integration_terminal_for_node(blocker.node_id):
            return [f"{blocker.node_id}: integration not completed"]
        return []

    def _child_ready_for_aggregate_downstream(self, child: GraphNode) -> bool:
        if child.state is GraphNodeState.SUPERSEDED:
            return True
        return _node_verify_passed(child) and self.integration_terminal_for_node(child.node_id)

    def _reserve_prediction_wave(
        self,
        earliest_position: int,
        mode: RuntimeMode,
        capacity: SchedulerCapacity,
        wave_usage: dict[int, dict[RuntimeMode, int]],
        wave_global_usage: dict[int, int],
    ) -> int:
        position = earliest_position
        while not self._prediction_wave_has_capacity(position, mode, capacity, wave_usage, wave_global_usage):
            position += 1
        wave_usage.setdefault(position, {})
        wave_usage[position][mode] = wave_usage[position].get(mode, 0) + 1
        wave_global_usage[position] = wave_global_usage.get(position, 0) + 1
        return position

    def _prediction_wave_has_capacity(
        self,
        position: int,
        mode: RuntimeMode,
        capacity: SchedulerCapacity,
        wave_usage: dict[int, dict[RuntimeMode, int]],
        wave_global_usage: dict[int, int],
    ) -> bool:
        global_limit = capacity.global_limit
        if global_limit is not None and wave_global_usage.get(position, 0) >= global_limit:
            return False
        mode_limit = capacity.by_mode.get(mode)
        if mode_limit is not None and wave_usage.get(position, {}).get(mode, 0) >= mode_limit:
            return False
        return True

    def _aggregate_display_state(self, node: GraphNode) -> str | None:
        if not self.children_for(node.node_id):
            return None
        derived_state = self.derive_parent_state(node.node_id)
        if derived_state is GraphNodeState.PLANNED:
            return "in_progress"
        return derived_state.value


class PipelineScheduler:
    def __init__(self, store: ConductorPipelineStore):
        self.store = store

    def is_dependency_satisfied(self, node_id: str) -> bool:
        node = self.store.get_node(node_id)
        children = self.store.children_for(node_id)
        if children:
            derived_state = self.store.derive_parent_state(node_id)
            if self.store.active_runtime_config().scheduler_policy.dependency_policy is DependencySatisfactionPolicy.VERIFY_PASSED:
                return derived_state is GraphNodeState.VERIFY_PASSED and all(self._node_ready_for_downstream(child) for child in children)
            return derived_state in {GraphNodeState.VERIFY_PASSED, GraphNodeState.SUPERSEDED}
        policy = self.store.active_runtime_config().scheduler_policy.dependency_policy
        if policy is DependencySatisfactionPolicy.VERIFY_PASSED:
            return self._node_ready_for_downstream(node)
        return node.state in {
            GraphNodeState.VERIFY_PASSED,
            GraphNodeState.SUPERSEDED,
        }

    def _node_ready_for_downstream(self, node: GraphNode) -> bool:
        if node.state is GraphNodeState.SUPERSEDED:
            return True
        return _node_verify_passed(node) and self.store.integration_terminal_for_node(node.node_id)

    def dispatchable_nodes(self, mode: RuntimeMode) -> list[str]:
        nodes = self.store.list_nodes()
        dispatchable: list[str] = []
        for node in nodes:
            if self.store.children_for(node.node_id):
                continue
            if node.state not in _DISPATCHABLE_STATES:
                continue
            if _mode_for_state(node.state) is not mode:
                continue
            if self.store.active_lease(node.node_id, mode) is not None:
                continue
            if mode is RuntimeMode.VERIFY and not self.store.has_verification_input_for_node(node.node_id):
                continue
            if all(self.is_dependency_satisfied(blocker_id) for blocker_id in self.store.blockers_for(node.node_id)):
                dispatchable.append(node.node_id)
        return dispatchable

    def promote_ready_nodes(self) -> list[str]:
        promoted: list[str] = []
        for node in self.store.list_nodes():
            if node.state is not GraphNodeState.PLANNED:
                continue
            if self.store.children_for(node.node_id):
                continue
            if all(self.is_dependency_satisfied(blocker_id) for blocker_id in self.store.blockers_for(node.node_id)):
                self.store.update_node_state(node.node_id, GraphNodeState.READY)
                promoted.append(node.node_id)
        return promoted


class PipelineLinearProjector:
    def __init__(
        self,
        *,
        store: ConductorPipelineStore,
        tracker: Any,
        root_issue_id: str,
        delegate_id: str | None = None,
    ):
        self.store = store
        self.tracker = tracker
        self.root_issue_id = root_issue_id
        self.delegate_id = delegate_id

    async def reconcile_once(self) -> int:
        revision = self.store.current_graph_revision_record()
        if revision is None or not self.root_issue_id:
            return 0
        projected = 0
        issue_ids_by_node: dict[str, str] = {}
        existing = await self._existing_node_issues()
        for projection in self.store.list_linear_projections():
            node_id = str(projection.get("node_id") or "")
            issue_id = str(projection.get("linear_issue_id") or "")
            if node_id and issue_id and node_id not in existing:
                existing[node_id] = {"id": issue_id}
        for node in self.store.list_nodes():
            is_root_issue_node = node.node_id == revision.root_node_id and node.issue_id == self.root_issue_id
            issue = {"id": self.root_issue_id} if is_root_issue_node else existing.get(node.node_id)
            if issue is None:
                issue = await self.tracker.create_child_issue_for(
                    parent_issue_id=self.root_issue_id,
                    title=node.title,
                    description=self._description_block(node, revision),
                    label_names=["performer:type/pipeline-node"],
                    delegate_id=self.delegate_id,
                )
            issue_id = str(issue.get("id") or "")
            if not issue_id:
                continue
            update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
            if update_description is not None:
                await update_description(issue_id, "SYMPHONY PIPELINE NODE", self._description_block(node, revision))
            self.store.record_linear_projection(
                node_id=node.node_id,
                linear_issue_id=issue_id,
                metadata=self._metadata(node, revision),
            )
            issue_ids_by_node[node.node_id] = issue_id
            projected += 1
        projected += await self._project_block_edges(issue_ids_by_node)
        return projected

    async def _project_block_edges(self, issue_ids_by_node: dict[str, str]) -> int:
        ensure_relation = getattr(self.tracker, "ensure_issue_relation", None)
        if ensure_relation is None:
            return 0
        projected = 0
        for blocker in sorted(issue_ids_by_node):
            blocker_issue_id = issue_ids_by_node.get(blocker)
            if not blocker_issue_id:
                continue
            for blocked in self.store.dependents_for(blocker):
                blocked_issue_id = issue_ids_by_node.get(blocked)
                if not blocked_issue_id:
                    continue
                await ensure_relation(
                    issue_id=blocker_issue_id,
                    related_issue_id=blocked_issue_id,
                    relation_type="blocks",
                )
                projected += 1
        return projected

    async def ingest_human_linear_changes_once(self) -> int:
        revision = self.store.current_graph_revision_record()
        if revision is None:
            return 0
        children = await self._existing_node_issues()
        issue_id_by_node: dict[str, str] = {}
        node_by_issue_id: dict[str, str] = {}
        for node_id, issue in children.items():
            issue_id = str(issue.get("id") or "")
            if not issue_id:
                continue
            issue_id_by_node[node_id] = issue_id
            node_by_issue_id[issue_id] = node_id
        if not issue_id_by_node:
            return 0
        edges = self._linear_block_edges(children, node_by_issue_id)
        graph_revision = self.store.merge_human_added_blocks(edges, reason="human_linear_blocks_ingested")
        return 1 if graph_revision is not None else 0

    def _linear_block_edges(
        self,
        children: dict[str, dict[str, Any]],
        node_by_issue_id: dict[str, str],
    ) -> list[tuple[str, str]]:
        edges: list[tuple[str, str]] = []
        for source_node_id, issue in children.items():
            for relation in _issue_relations(issue):
                if str(relation.get("type") or "") != "blocks":
                    continue
                related = relation.get("relatedIssue") if isinstance(relation.get("relatedIssue"), dict) else {}
                related_issue_id = str(related.get("id") or "")
                target_node_id = node_by_issue_id.get(related_issue_id)
                if target_node_id:
                    edges.append((source_node_id, target_node_id))
            for blocker in issue.get("blocked_by") or []:
                if not isinstance(blocker, dict):
                    continue
                blocker_node_id = node_by_issue_id.get(str(blocker.get("id") or ""))
                if blocker_node_id:
                    edges.append((blocker_node_id, source_node_id))
        return list(dict.fromkeys(edges))

    async def _existing_node_issues(self) -> dict[str, dict[str, Any]]:
        fetch = getattr(self.tracker, "fetch_child_issues", None)
        if fetch is None:
            return {}
        children = await fetch(self.root_issue_id, label_name="performer:type/pipeline-node")
        result: dict[str, dict[str, Any]] = {}
        for child in children or []:
            if not isinstance(child, dict):
                continue
            node_id = _projected_node_id_from_description(str(child.get("description") or ""))
            if node_id:
                result[node_id] = child
        return result

    def _metadata(self, node: GraphNode, revision: GraphRevision) -> dict[str, Any]:
        return self.store.linear_projection_metadata(node, revision)

    def _description_block(self, node: GraphNode, revision: GraphRevision) -> str:
        gate = self.store.gate_for_node(node.node_id)
        metadata = self._metadata(node, revision)
        runtime_wait = self.store.active_runtime_wait_for_node(node.node_id)
        lines = [
            "```yaml",
            "symphony:",
            f"  graph_id: {metadata['graph_id']}",
            f"  node_id: {metadata['node_id']}",
            f"  plan_attempt_id: {metadata['plan_attempt_id']}",
            f"  gate_snapshot_hash: {metadata['gate_snapshot_hash'] or ''}",
            f"  conductor_revision: {metadata['conductor_revision']}",
            f"  operator_status: {metadata['operator_status']}",
        ]
        if metadata.get("operator_wait_kind"):
            lines.append(f"  operator_wait_kind: {_yaml_scalar(metadata.get('operator_wait_kind'))}")
        lines.append("```")
        if runtime_wait is not None:
            lines.extend(
                [
                    "",
                    "### Runtime Wait",
                    "",
                    "```yaml",
                    "runtime_wait:",
                    f"  status: {_yaml_scalar(runtime_wait.get('status'))}",
                    f"  wait_kind: {_yaml_scalar(runtime_wait.get('wait_kind'))}",
                    f"  attempt_id: {_yaml_scalar(runtime_wait.get('attempt_id'))}",
                    f"  mode: {_yaml_scalar(runtime_wait.get('mode'))}",
                    f"  lease_id: {_yaml_scalar(runtime_wait.get('lease_id'))}",
                    f"  updated_at: {_yaml_scalar(runtime_wait.get('updated_at'))}",
                    f"  message: {_yaml_scalar(runtime_wait.get('message'))}",
                    f"  command: {_yaml_scalar(runtime_wait.get('command'))}",
                    "```",
                ]
            )
        if gate is not None:
            lines.extend(
                [
                    "",
                    "### Frozen Gate",
                    "",
                    "acceptance_criteria:",
                    *[f"- {item}" for item in gate.content.acceptance_criteria],
                    "verification_procedure:",
                    *[f"- {item}" for item in gate.content.verification_procedure],
                    "rubric:",
                    *[f"- {score}: {gate.content.rubric.get(str(score), '')}" for score in range(5)],
                    f"pass_threshold: {gate.content.pass_threshold}",
                ]
            )
        return "\n".join(lines)

@dataclass(frozen=True)
class PipelineDispatchAccepted:
    node_id: str
    graph_id: str
    plan_attempt_id: str


class PipelineCoordinator:
    def __init__(self, *, store: ConductorPipelineStore, runtime_manager: Any):
        self.store = store
        self.runtime_manager = runtime_manager
        self.scheduler = PipelineScheduler(store)

    def heartbeat_active_leases(
        self,
        *,
        at: datetime | None = None,
        ttl_seconds: int = 300,
    ) -> int:
        now = at or datetime.now(timezone.utc)
        heartbeats = 0
        for lease in self.store.list_active_leases():
            if self.store.heartbeat_lease(lease.lease_id, lease.fencing_token, at=now, ttl_seconds=ttl_seconds):
                heartbeats += 1
        return heartbeats

    def accept_dispatch(self, event: dict[str, Any], *, instance_id: str) -> PipelineDispatchAccepted:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        dispatch_key = issue_id or issue_identifier
        if not dispatch_key:
            raise ValueError("dispatch requires issue_id or issue_identifier")
        existing = self._existing_dispatch_for_issue(issue_id=issue_id, issue_identifier=issue_identifier)
        if existing is not None:
            return existing
        issue_identifier = issue_identifier or issue_id
        title = str(event.get("issue_title") or event.get("title") or issue_identifier or issue_id)
        issue_description = str(event.get("issue_description") or event.get("description") or "")
        node_id = issue_id or issue_identifier
        graph_id = str(event.get("graph_id") or f"graph-{node_id}")
        plan_attempt_id = str(event.get("plan_attempt_id") or f"plan-{uuid4().hex}")
        node = GraphNode(
            node_id=node_id,
            title=title,
            state=GraphNodeState.REPLANNING,
            issue_id=issue_id or None,
            issue_identifier=issue_identifier or None,
        )
        proposal = PlanProposal(
            graph_id=graph_id,
            plan_attempt_id=plan_attempt_id,
            root_node_id=node_id,
            nodes=[node],
            blocks=[],
            gates=[],
            entry_node_ids=[node_id],
            exit_node_ids=[node_id],
        )
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            revision_row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
            revision = int(revision_row["revision"]) + 1
            connection.execute(
                """
                INSERT INTO graph_revisions (revision, graph_id, plan_attempt_id, root_node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (revision, graph_id, plan_attempt_id, node_id, _json_dumps(proposal.to_dict()), _now()),
            )
            connection.execute(
                """
                INSERT INTO graph_nodes (revision, node_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (revision, node_id, _json_dumps(_node_topology_payload(node))),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
                VALUES (?, ?)
                """,
                (node_id, _json_dumps(_node_runtime_payload(node))),
            )
        self.store.record_dispatch_context(
            node_id,
            {
                "issue_id": issue_id,
                "issue_identifier": issue_identifier,
                "title": title,
                "description": issue_description,
            },
        )
        return PipelineDispatchAccepted(node_id=node_id, graph_id=graph_id, plan_attempt_id=plan_attempt_id)

    def _existing_dispatch_for_issue(self, *, issue_id: str, issue_identifier: str) -> PipelineDispatchAccepted | None:
        revision = self.store.current_graph_revision_record()
        if revision is None:
            return None
        try:
            node = self.store.get_node(revision.root_node_id)
        except KeyError:
            return None
        keys = {value for value in [node.node_id, node.issue_id, node.issue_identifier] if value}
        requested = {value for value in [issue_id, issue_identifier] if value}
        if not keys.intersection(requested):
            return None
        return PipelineDispatchAccepted(
            node_id=node.node_id,
            graph_id=revision.graph_id,
            plan_attempt_id=revision.plan_attempt_id,
        )

    async def start_due_attempts(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        started = 0
        envelope = self.store.active_runtime_config()
        self.scheduler.promote_ready_nodes()
        active_leases = self.store._active_leases()
        active_by_mode: dict[RuntimeMode, int] = {mode: 0 for mode in RuntimeMode}
        for lease in active_leases:
            active_by_mode[lease.mode] = active_by_mode.get(lease.mode, 0) + 1
        active_global = len(active_leases)
        for mode in (RuntimeMode.PLAN, RuntimeMode.EXECUTE, RuntimeMode.VERIFY):
            remaining = envelope.scheduler_policy.remaining_for_mode(
                mode,
                active_global=active_global,
                active_by_mode=active_by_mode,
            )
            if remaining == 0:
                continue
            started_for_mode = 0
            for node_id in self.scheduler.dispatchable_nodes(mode):
                if remaining is not None and started_for_mode >= remaining:
                    break
                if self.store.active_lease(node_id, mode) is not None:
                    continue
                profile = envelope.profiles.get(mode)
                preflight_error = _runtime_profile_preflight_error(mode, profile)
                if preflight_error is not None:
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_backend_ineligible "
                            f"mode={mode.value} node_id={node_id} error={preflight_error} "
                            f"graph_revision={self.store.current_graph_revision()} "
                            f"policy_revision={envelope.scheduler_policy.version}"
                        ),
                    )
                    self.store.create_human_wait(
                        node_id,
                        reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
                        details={
                            "mode": mode.value,
                            "error": preflight_error,
                            "action_required": "update_runtime_profile",
                        },
                    )
                    continue
                attempt_id = f"{mode.value}-{uuid4().hex}"
                lease = self.store.start_attempt(mode, node_id=node_id, attempt_id=attempt_id, now=now)
                try:
                    paths = self._attempt_paths(Path(instance.instance_dir), attempt_id)
                    request = self._attempt_request(
                        mode,
                        node_id=node_id,
                        attempt_id=attempt_id,
                        lease=lease,
                        instance=instance,
                        attempt_dir=paths["request_path"].parent,
                    )
                    env = prepare_mode_environment(
                        Path(instance.instance_dir),
                        profile,
                        workspace_path=_attempt_workspace_for_mode(mode, request),
                        home_scope=attempt_id,
                    )
                    _write_json_atomic(paths["request_path"], request)
                    result_path = paths["result_path"]
                    if result_path.exists():
                        result_path.unlink()
                    started_instance = await self.runtime_manager.start(
                        instance,
                        env=env,
                        mode=mode.value,
                        attempt_id=attempt_id,
                        lease_id=lease.lease_id,
                        attempt_request_path=str(paths["request_path"]),
                        attempt_result_path=str(result_path),
                    )
                    self.store.record_attempt_process_pid(attempt_id, getattr(started_instance, "pid", None))
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_attempt_started "
                            f"mode={mode.value} node_id={node_id} attempt_id={attempt_id} "
                            f"lease_id={lease.lease_id} graph_revision={self.store.current_graph_revision()} "
                            f"policy_revision={envelope.scheduler_policy.version} "
                            f"process_pid={getattr(started_instance, 'pid', None)} "
                            f"request_path={paths['request_path']} result_path={result_path}"
                        ),
                    )
                except Exception as exc:
                    error = _sanitize_error(exc)
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_attempt_start_failed "
                            f"mode={mode.value} node_id={node_id} attempt_id={attempt_id} error={error}"
                        ),
                    )
                    self._fail_started_attempt_for_backend_error(
                        mode=mode,
                        node_id=node_id,
                        attempt_id=attempt_id,
                        lease_id=lease.lease_id,
                        error=error,
                        at=now,
                    )
                    continue
                started += 1
                started_for_mode += 1
                active_global += 1
                active_by_mode[mode] = active_by_mode.get(mode, 0) + 1
        return started

    def _fail_started_attempt_for_backend_error(
        self,
        *,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        lease_id: str,
        error: str,
        at: datetime,
    ) -> None:
        result_type: type[PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult]
        if mode is RuntimeMode.PLAN:
            result_type = PlanAttemptResult
        elif mode is RuntimeMode.EXECUTE:
            result_type = ExecuteAttemptResult
        else:
            result_type = VerifyAttemptResult
        result = result_type(
            attempt_id=attempt_id,
            node_id=node_id,
            status=AttemptState.FAILED,
            graph_revision=self.store.current_graph_revision(),
            policy_revision=self.store.active_runtime_config().scheduler_policy.version,
            gate_snapshot_hash=self.store.get_node(node_id).gate_snapshot_hash or "",
            lease_id=lease_id,
            fencing_token="",
            error=error,
        )
        self.store._finish_attempt(result, state=AttemptState.FAILED, at=at, error=error)
        self.store._deactivate_lease(lease_id)
        self.store.create_human_wait(
            node_id,
            reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
            details={"mode": mode.value, "attempt_id": attempt_id, "lease_id": lease_id, "error": error},
        )

    def observe_runtime_waits_from_logs(self, instance: Any) -> int:
        observed = 0
        seen: set[tuple[str, str]] = set()
        for log_path in _runtime_log_candidates(instance):
            try:
                lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in lines[-500:]:
                event = _attempt_event_from_performer_stream_line(line)
                if event is None:
                    continue
                wait = _runtime_wait_from_attempt_event(event)
                if wait is None:
                    continue
                attempt_id = str(wait.get("attempt_id") or "")
                wait_kind = str(wait.get("wait_kind") or "")
                if not attempt_id or not wait_kind or (attempt_id, wait_kind) in seen:
                    continue
                seen.add((attempt_id, wait_kind))
                try:
                    attempt = self.store.get_attempt(attempt_id)
                except KeyError:
                    continue
                if attempt.state is not AttemptState.RUNNING:
                    continue
                try:
                    mode = RuntimeMode(str(wait.get("mode") or attempt.mode.value))
                except ValueError:
                    continue
                if mode is not attempt.mode:
                    continue
                node_id = str(wait.get("node_id") or attempt.node_id)
                if node_id != attempt.node_id:
                    continue
                lease = self.store.active_lease(attempt.node_id, attempt.mode)
                if lease is None or lease.attempt_id != attempt.attempt_id:
                    continue
                if self.store.record_runtime_wait(
                    attempt_id=attempt.attempt_id,
                    node_id=attempt.node_id,
                    mode=attempt.mode,
                    wait_kind=wait_kind,
                    message=_optional_event_str(wait.get("message")),
                    command=_optional_event_str(wait.get("command")),
                    thread_id=_optional_event_str(wait.get("thread_id")),
                    turn_id=_optional_event_str(wait.get("turn_id")),
                    session_id=_optional_event_str(wait.get("session_id")),
                    lease_id=lease.lease_id,
                    log_path=str(log_path),
                ):
                    observed += 1
        return observed

    def fail_running_attempts_for_exited_process(
        self,
        instance: Any,
        *,
        at: datetime | None = None,
    ) -> int:
        if getattr(instance, "process_status", None) != "exited":
            return 0
        at = at or datetime.now(timezone.utc)
        failed = 0
        error = _process_exit_error(instance)
        for attempt in self.store.list_attempts():
            if attempt.state is not AttemptState.RUNNING:
                continue
            lease = self.store.active_lease(attempt.node_id, attempt.mode)
            if lease is None or lease.attempt_id != attempt.attempt_id:
                continue
            result_path = Path(instance.instance_dir) / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
            if result_path.exists():
                continue
            self._fail_started_attempt_for_backend_error(
                mode=attempt.mode,
                node_id=attempt.node_id,
                attempt_id=attempt.attempt_id,
                lease_id=lease.lease_id,
                error=error,
                at=at,
            )
            _append_instance_log(
                instance,
                (
                    "pipeline_attempt_process_exited "
                    f"mode={attempt.mode.value} node_id={attempt.node_id} "
                    f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                    f"exit_code={getattr(instance, 'last_exit_code', None)} error={error}"
                ),
            )
            failed += 1
        return failed

    def fail_exited_attempt_snapshot(
        self,
        instance: Any,
        snapshot: dict[str, object],
        *,
        at: datetime | None = None,
    ) -> int:
        attempt_id = str(snapshot.get("attempt_id") or "").strip()
        if not attempt_id:
            return 0
        try:
            attempt = self.store.get_attempt(attempt_id)
        except KeyError:
            return 0
        if attempt.state is not AttemptState.RUNNING:
            return 0
        snapshot_mode = str(snapshot.get("mode") or "").strip()
        if snapshot_mode and snapshot_mode != attempt.mode.value:
            return 0
        lease = self.store.active_lease(attempt.node_id, attempt.mode)
        if lease is None or lease.attempt_id != attempt.attempt_id:
            return 0
        snapshot_lease_id = str(snapshot.get("lease_id") or "").strip()
        if snapshot_lease_id and snapshot_lease_id != lease.lease_id:
            return 0
        snapshot_result_path_value = str(snapshot.get("result_path") or "").strip()
        if snapshot_result_path_value and Path(snapshot_result_path_value).exists():
            return 0
        error = _attempt_snapshot_exit_error(snapshot, instance)
        self._fail_started_attempt_for_backend_error(
            mode=attempt.mode,
            node_id=attempt.node_id,
            attempt_id=attempt.attempt_id,
            lease_id=lease.lease_id,
            error=error,
            at=at or datetime.now(timezone.utc),
        )
        _append_instance_log(
            instance,
            (
                "pipeline_attempt_process_exited "
                f"mode={attempt.mode.value} node_id={attempt.node_id} "
                f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                f"pid={snapshot.get('pid')} exit_code={snapshot.get('exit_code')} error={error}"
            ),
        )
        return 1

    def collect_result_files(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        root = Path(instance.instance_dir) / "state" / "pipeline"
        if not root.exists():
            return 0
        applied = 0
        for result_path in sorted(root.glob("*/attempt-result.json")):
            try:
                payload = _json_loads(result_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                _append_instance_log(
                    instance,
                    (
                        "event=pipeline_result_file_invalid "
                        f"attempt_id={result_path.parent.name} result_path={result_path} "
                        f"error_type={exc.__class__.__name__} sanitized_reason={_sanitize_error(exc)}"
                    ),
                )
                continue
            result = _attempt_result_from_payload(payload)
            if result is None:
                _append_instance_log(
                    instance,
                    (
                        "event=pipeline_result_file_invalid "
                        f"attempt_id={result_path.parent.name} result_path={result_path} "
                        "error_type=InvalidAttemptResult sanitized_reason=invalid_attempt_result"
                    ),
                )
                continue
            if self.store.complete_attempt_with_fencing(result, at=now):
                applied += 1
                applied_path = result_path.with_suffix(".json.applied")
                result_path.rename(applied_path)
                _append_pipeline_log_event(
                    instance,
                    "pipeline_result_applied",
                    graph_revision=result.graph_revision,
                    policy_revision=result.policy_revision,
                    node_id=result.node_id,
                    attempt_id=result.attempt_id,
                    mode=result.mode.value,
                    lease_id=result.lease_id,
                    result_path=str(applied_path),
                )
                if isinstance(result, VerifyAttemptResult) and result.passed and result.score >= PASS_THRESHOLD:
                    integration_id = f"integration-{result.node_id}-{result.attempt_id}"
                    _append_pipeline_log_event(
                        instance,
                        "pipeline_manifest_published",
                        graph_revision=result.graph_revision,
                        policy_revision=result.policy_revision,
                        node_id=result.node_id,
                        attempt_id=result.attempt_id,
                        mode=result.mode.value,
                        lease_id=result.lease_id,
                        result_path=str(applied_path),
                    )
                    _append_pipeline_log_event(
                        instance,
                        "pipeline_integration_queued",
                        graph_revision=result.graph_revision,
                        policy_revision=result.policy_revision,
                        node_id=result.node_id,
                        attempt_id=result.attempt_id,
                        mode=result.mode.value,
                        lease_id=result.lease_id,
                        integration_id=integration_id,
                    )
        return applied

    def _attempt_request(
        self,
        mode: RuntimeMode,
        *,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        instance: Any,
        attempt_dir: Path,
    ) -> dict[str, Any]:
        node = self.store.get_node(node_id)
        dispatch_context = self.store.dispatch_context_for_node(node_id)
        if mode is RuntimeMode.PLAN:
            revision = self.store.current_graph_revision_record()
            failure_context: dict[str, Any] = {}
            if node.state is GraphNodeState.REPLANNING:
                failed_verify = self.store.latest_failed_verify_attempt_for_node(node_id)
                if failed_verify is not None:
                    failure_context = {
                        "reason": "verify_failed",
                        "failed_attempt_id": failed_verify.attempt_id,
                        "score": failed_verify.score,
                        "gate_snapshot_hash": failed_verify.gate_snapshot_hash,
                        "error": failed_verify.error,
                    }
            request = PlanAttemptRequest(
                attempt_id=attempt_id,
                graph_id=revision.graph_id if revision is not None else f"graph-{node_id}",
                root_node_id=revision.root_node_id if revision is not None else node_id,
                node_id=node_id,
                issue_id=str(dispatch_context.get("issue_id") or node.issue_id or node_id),
                issue_identifier=str(dispatch_context.get("issue_identifier") or node.issue_identifier or node.title),
                title=str(dispatch_context.get("title") or node.title),
                graph_revision=self.store.current_graph_revision(),
                policy_revision=self.store.active_runtime_config().scheduler_policy.version,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                workspace_path=str(
                    materialize_planner_workspace(
                        attempt_dir,
                        getattr(instance, "resolved_repo_path", None),
                    )
                ),
                issue_description=str(dispatch_context.get("description") or ""),
                failure_context=failure_context,
            )
            return request.to_dict()
        gate = self.store.gate_for_node(node_id)
        if gate is None:
            raise ValueError(f"node {node_id} has no frozen gate snapshot")
        common = {
            "attempt_id": attempt_id,
            "node_id": node_id,
            "graph_revision": self.store.current_graph_revision(),
            "policy_revision": self.store.active_runtime_config().scheduler_policy.version,
            "gate_snapshot": gate,
            "lease_id": lease.lease_id,
            "fencing_token": lease.fencing_token,
        }
        if mode is RuntimeMode.EXECUTE:
            blocker_ids = self.store.blockers_for(node_id)
            upstream_manifests = self.store.integrated_manifests_for_blockers(node_id)
            integrated_revisions = [
                str(manifest.code.get("integrated_revision") or "").strip()
                for manifest in upstream_manifests
                if str(manifest.code.get("integrated_revision") or "").strip()
            ]
            repository_path = str(getattr(instance, "resolved_repo_path", "") or "")
            current_integrated_revision = (
                self.store.current_integrated_revision(repository_path)
                if blocker_ids and len(upstream_manifests) == len(blocker_ids)
                else None
            )
            request = ExecuteAttemptRequest(
                **common,
                task_title=str(dispatch_context.get("title") or node.title),
                issue_identifier=str(dispatch_context.get("issue_identifier") or node.issue_identifier or ""),
                issue_description=str(dispatch_context.get("description") or ""),
                base_revision=(
                    current_integrated_revision
                    or (integrated_revisions[-1] if integrated_revisions else _repository_head_revision(repository_path))
                ),
                repository={"resolved_repo_path": repository_path},
                artifact_paths={"attempt_dir": str(attempt_dir)},
                upstream_manifests=[manifest.to_dict() for manifest in upstream_manifests],
                reason="dependency_policy_satisfied",
            )
            return request.to_dict()
        snapshot = self.store.verification_input_for_node(node_id)
        if snapshot is None:
            raise ValueError(f"node {node_id} has no verification input snapshot")
        request = VerifyAttemptRequest(
            **common,
            execute_attempt_id=snapshot.execute_attempt_id,
            verification_input=snapshot.to_dict(),
            artifact_paths={"attempt_dir": str(attempt_dir)},
            reason="execute_succeeded",
        )
        return request.to_dict()

    def _attempt_paths(self, instance_dir: Path, attempt_id: str) -> dict[str, Path]:
        root = instance_dir / "state" / "pipeline" / attempt_id
        root.mkdir(parents=True, exist_ok=True)
        return {"request_path": root / "attempt-request.json", "result_path": root / "attempt-result.json"}


_DISPATCHABLE_STATES = {
    GraphNodeState.READY,
    GraphNodeState.REWORKING,
    GraphNodeState.REPLANNING,
    GraphNodeState.VERIFYING,
}

_PREDICTABLE_DISPATCH_STATES = {
    GraphNodeState.PLANNED,
    *_DISPATCHABLE_STATES,
}


def _node_verify_passed(node: GraphNode) -> bool:
    return node.state is GraphNodeState.VERIFY_PASSED and int(node.verify_score or 0) >= PASS_THRESHOLD


def _plan_validation_human_reason(errors: set[PlanValidatorError]) -> HumanEscalationReason:
    if PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE in errors:
        return HumanEscalationReason.CREDENTIAL_REQUIRED
    if PlanValidatorError.GATE_UNEXECUTABLE in errors:
        return HumanEscalationReason.GATE_UNEXECUTABLE
    return HumanEscalationReason.PLAN_INVALID


def _plan_failure_human_reason(error: str) -> HumanEscalationReason:
    if not error.startswith("invalid_plan_proposal"):
        return HumanEscalationReason.BACKEND_UNAVAILABLE
    return _plan_validation_human_reason(_plan_validator_errors_from_error(error))


def _plan_validator_errors_from_error(error: str) -> set[PlanValidatorError]:
    if ":" not in error:
        return set()
    errors: set[PlanValidatorError] = set()
    for token in error.split(":", 1)[1].replace(",", " ").split():
        try:
            errors.add(PlanValidatorError(token.strip()))
        except ValueError:
            continue
    return errors


def _plan_validation_error_summary(errors: set[PlanValidatorError]) -> str:
    names = ", ".join(sorted(error.value for error in errors))
    return f"invalid plan proposal: {names}"


def _resume_state_for_human_wait(payload: dict[str, Any]) -> GraphNodeState:
    if payload.get("reason") == HumanEscalationReason.LINEAR_SYNC_CONFLICT.value:
        return GraphNodeState.VERIFY_PASSED
    details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
    try:
        mode = RuntimeMode(str(details.get("mode") or RuntimeMode.PLAN.value))
    except ValueError:
        mode = RuntimeMode.PLAN
    if mode is RuntimeMode.EXECUTE:
        return GraphNodeState.READY
    if mode is RuntimeMode.VERIFY:
        return GraphNodeState.VERIFYING
    return GraphNodeState.REPLANNING


def _mode_for_state(state: GraphNodeState) -> RuntimeMode:
    if state is GraphNodeState.REPLANNING:
        return RuntimeMode.PLAN
    if state is GraphNodeState.VERIFYING:
        return RuntimeMode.VERIFY
    return RuntimeMode.EXECUTE


def _queued_mode_for_state(state: GraphNodeState) -> RuntimeMode | None:
    if state is GraphNodeState.REPLANNING:
        return RuntimeMode.PLAN
    if state in {GraphNodeState.READY, GraphNodeState.REWORKING}:
        return RuntimeMode.EXECUTE
    if state is GraphNodeState.VERIFYING:
        return RuntimeMode.VERIFY
    return None


def _projected_node_id_from_description(description: str) -> str | None:
    for line in description.splitlines():
        stripped = line.strip()
        if stripped.startswith("node_id:"):
            value = stripped.split(":", 1)[1].strip()
            return value or None
    return None


def _issue_relations(issue: dict[str, Any]) -> list[dict[str, Any]]:
    relations = issue.get("relations")
    if isinstance(relations, dict):
        nodes = relations.get("nodes")
        return [relation for relation in nodes or [] if isinstance(relation, dict)]
    if isinstance(relations, list):
        return [relation for relation in relations if isinstance(relation, dict)]
    return []


def prepare_mode_environment(
    instance_state_root: Path,
    profile: RuntimeProfile | None,
    *,
    workspace_path: Path | str | None = None,
    home_scope: str | None = None,
) -> dict[str, str]:
    return prepare_backend_environment(instance_state_root, profile, workspace_path=workspace_path, home_scope=home_scope)


def _runtime_profile_preflight_error(mode: RuntimeMode, profile: RuntimeProfile | None) -> str | None:
    if profile is None:
        return None
    if profile.mode is not mode:
        return f"runtime profile mode mismatch for {mode.value}: {profile.mode.value}"
    if profile.backend not in RUNTIME_BACKENDS_BY_MODE.get(mode, set()):
        return f"unsupported runtime backend for {mode.value}: {profile.backend}"
    return None


def materialize_planner_workspace(attempt_dir: Path, resolved_repo_path: str | Path | None) -> Path:
    workspace = attempt_dir / "planner-workspace"
    if workspace.exists():
        if workspace.is_dir():
            shutil.rmtree(workspace)
        else:
            workspace.unlink()
    attempt_dir.mkdir(parents=True, exist_ok=True)
    source = Path(resolved_repo_path).expanduser() if resolved_repo_path else None
    if source is not None and source.is_dir() and source.resolve(strict=False) not in workspace.resolve(strict=False).parents:
        shutil.copytree(source, workspace)
    else:
        workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def _attempt_workspace_for_mode(mode: RuntimeMode, request: dict[str, Any]) -> Path | None:
    if mode is RuntimeMode.PLAN:
        workspace_path = request.get("workspace_path")
        return Path(str(workspace_path)) if workspace_path else None
    artifact_paths = request.get("artifact_paths")
    if isinstance(artifact_paths, dict):
        attempt_dir = artifact_paths.get("attempt_dir")
        if attempt_dir:
            return Path(str(attempt_dir)) / ("workspace" if mode is RuntimeMode.EXECUTE else "")
    return None


def _runtime_log_candidates(instance: Any) -> list[Path]:
    candidates: list[Path] = []
    current = Path(str(getattr(instance, "instance_dir", ""))) / "logs" / "current.log"
    try:
        if current.is_file():
            target = current.read_text(encoding="utf-8").strip()
            if target:
                candidates.append(Path(target))
    except OSError:
        pass
    log_path = getattr(instance, "log_path", None)
    if log_path:
        candidates.append(Path(str(log_path)))
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _attempt_event_from_performer_stream_line(line: str) -> dict[str, Any] | None:
    marker = " message="
    if "event=performer_stream " not in line or marker not in line:
        return None
    raw = line.split(marker, 1)[1].strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get("event") != "performer_attempt_event":
        return None
    return payload


def _runtime_wait_from_attempt_event(event: dict[str, Any]) -> dict[str, Any] | None:
    codex_event = str(event.get("codex_event") or event.get("type") or "")
    message = str(event.get("message") or "")
    command = str(event.get("command") or "")
    wait_kind = _classify_runtime_wait_kind(codex_event, message, command)
    if wait_kind is None:
        return None
    return {
        "attempt_id": str(event.get("attempt_id") or ""),
        "node_id": str(event.get("node_id") or ""),
        "mode": str(event.get("mode") or ""),
        "wait_kind": wait_kind,
        "message": _sanitize_error(message) if message else None,
        "command": _sanitize_error(command) if command else None,
        "thread_id": _optional_event_str(event.get("thread_id")),
        "turn_id": _optional_event_str(event.get("turn_id")),
        "session_id": _optional_event_str(event.get("session_id")),
    }


def _classify_runtime_wait_kind(codex_event: str, message: str, command: str) -> str | None:
    text = " ".join([codex_event, message, command]).lower()
    if "approval" in text or "permission" in text:
        return "approval_requested"
    if "tool_input" in text or "tool input" in text:
        return "tool_input_requested"
    if "input_requested" in text or "input requested" in text:
        return "input_requested"
    if "waiting" in text and "input" in text:
        return "input_requested"
    return None


def _normalize_runtime_wait_kind(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    return normalized or "runtime_wait"


def _optional_event_str(value: Any) -> str | None:
    if value is None:
        return None
    text = _sanitize_error(str(value))
    return text or None


def _yaml_scalar(value: Any) -> str:
    if value is None:
        return '""'
    return json.dumps(str(value))


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(_json_dumps(payload), encoding="utf-8")
    tmp.replace(path)


def _append_instance_log(instance: Any, message: str) -> None:
    log_path = getattr(instance, "log_path", None)
    if not log_path:
        return
    path = Path(str(log_path))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{_now()} {message}\n")
    except OSError:
        return


def _append_pipeline_log_event(instance: Any | None, event: str, **fields: Any) -> None:
    if instance is None:
        return
    parts = [f"event={event}"]
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(f"{key}={_sanitize_log_field(value)}")
    _append_instance_log(instance, " ".join(parts))


def _sanitize_log_field(value: Any) -> str:
    text = str(value).replace("\x00", "")
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text.replace(" ", "_")


def _process_exit_error(instance: Any) -> str:
    exit_code = getattr(instance, "last_exit_code", None)
    parts = [f"performer process exited before publishing attempt result exit_code={exit_code}"]
    tail = _instance_log_error_tail(instance)
    if tail:
        parts.append(f"log_tail={tail}")
    return _sanitize_error(" ".join(parts))


def _attempt_snapshot_exit_error(snapshot: dict[str, object], instance: Any) -> str:
    exit_code = snapshot.get("exit_code")
    if exit_code is None:
        parts = ["process exited before publishing attempt result"]
    else:
        parts = [f"process exited with code {exit_code} before publishing attempt result"]
    tail = _instance_log_error_tail(instance)
    if tail:
        parts.append(f"log_tail={tail}")
    return _sanitize_error(" ".join(parts))


def _instance_log_error_tail(instance: Any) -> str:
    paths: list[Path] = []
    current = Path(str(getattr(instance, "instance_dir", ""))) / "logs" / "current.log"
    try:
        if current.is_file():
            current_target = current.read_text(encoding="utf-8").strip()
            if current_target:
                paths.append(Path(current_target))
    except OSError:
        pass
    log_path = getattr(instance, "log_path", None)
    if log_path:
        paths.append(Path(str(log_path)))
    if not paths:
        return ""
    path = next((candidate for candidate in paths if candidate.exists() and candidate.stat().st_size > 0), paths[0])
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    lines = [line.strip().replace("\x00", "") for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    return " | ".join(lines[-3:])[-300:]


def _failed_state_for_mode(mode: RuntimeMode) -> GraphNodeState:
    if mode is RuntimeMode.EXECUTE:
        return GraphNodeState.EXECUTE_FAILED
    if mode is RuntimeMode.VERIFY:
        return GraphNodeState.VERIFY_FAILED
    return GraphNodeState.AWAITING_HUMAN


def _visible_attempt_error(result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult) -> str:
    raw = str(result.error or "").strip()
    if raw:
        return raw
    return "attempt_failed_without_reason"


def _attempt_result_from_payload(payload: dict[str, Any]) -> PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult | None:
    try:
        mode = RuntimeMode(str(payload.get("mode") or ""))
    except ValueError:
        return None
    if mode is RuntimeMode.PLAN:
        return PlanAttemptResult.from_dict(payload)
    if mode is RuntimeMode.EXECUTE:
        return ExecuteAttemptResult.from_dict(payload)
    if mode is RuntimeMode.VERIFY:
        return VerifyAttemptResult.from_dict(payload)
    return None


def _repository_integration_path(repository_path: Path | str) -> str:
    return str(Path(repository_path).resolve(strict=False))


def _safe_path_part(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return safe or "integration"


def _git(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.STDOUT)


def _rollback_repository(repository_path: Path, revision: str) -> None:
    try:
        _git(["reset", "--hard", revision], cwd=repository_path)
        _git(["clean", "-fd"], cwd=repository_path)
    except Exception:
        return


def _repository_head_revision(repository_path: str) -> str:
    path = Path(repository_path) if repository_path else None
    if path is None or not path.exists():
        return ""
    try:
        return _git(["rev-parse", "HEAD"], cwd=path).strip()
    except Exception:
        return ""


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]


def _node_topology_payload(node: GraphNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "title": node.title,
        "issue_id": node.issue_id,
        "issue_identifier": node.issue_identifier,
        "parent_node_id": node.parent_node_id,
        "gate_snapshot_hash": node.gate_snapshot_hash,
        "superseded_by": list(node.superseded_by),
    }


def _node_runtime_payload(node: GraphNode) -> dict[str, Any]:
    return {
        "state": node.state.value,
        "verify_score": node.verify_score,
        "rework_count": node.rework_count,
        "human_reason": node.human_reason.value if node.human_reason is not None else None,
    }


def _node_from_topology_and_runtime(topology_payload: dict[str, Any], runtime_payload: dict[str, Any] | None) -> GraphNode:
    merged = dict(topology_payload)
    runtime = runtime_payload or {}
    merged["state"] = runtime.get("state") or topology_payload.get("state") or GraphNodeState.PLANNED.value
    merged["verify_score"] = runtime.get("verify_score", topology_payload.get("verify_score"))
    merged["rework_count"] = runtime.get("rework_count", topology_payload.get("rework_count", 0))
    merged["human_reason"] = runtime.get("human_reason", topology_payload.get("human_reason"))
    return GraphNode.from_dict(merged)


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _json_loads(payload: str) -> dict[str, Any]:
    value = json.loads(payload)
    return value if isinstance(value, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_time(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")
