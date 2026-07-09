from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    ExecuteAttemptRequest,
    PASS_THRESHOLD,
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanAttemptRequest,
    PlanAttemptResult,
    PipelineModeView,
    PipelineView,
    IntentSpec,
    PlanProposal,
    PlanRepair,
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



from .conductor_pipeline_helpers import (
    _DISPATCHABLE_STATES,
    _PREDICTABLE_DISPATCH_STATES,
    _UNCHANGED,
    _format_time,
    _git,
    _json_dumps,
    _json_loads,
    _jsonable,
    _mode_for_state,
    _node_from_topology_and_runtime,
    _node_next_action,
    _node_runtime_payload,
    _node_topology_payload,
    _node_verify_passed,
    _now,
    _plan_failure_human_reason,
    _plan_validation_error_summary,
    _plan_validation_human_reason,
    _queued_mode_for_state,
    _repository_integration_path,
    _resume_state_for_human_wait,
    _retry_state_for_attempt_mode,
    _rollback_repository,
    _safe_path_part,
    _sanitize_error,
    _utc,
)
from .conductor_pipeline_logs import (
    _append_pipeline_log_event,
    _normalize_runtime_wait_kind,
    _visible_attempt_error,
)
from .conductor_pipeline_store_schema import init_pipeline_db

@dataclass(frozen=True)
class GraphRevision:
    graph_id: str
    revision: int
    plan_attempt_id: str
    root_node_id: str


_UNCHANGED = object()
_PROCESS_EXIT_RESULT_GRACE_SECONDS = 15.0


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
        init_pipeline_db(str(self.db_path))

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

    def commit_plan(self, proposal: PlanProposal, *, intent_spec: IntentSpec | None = None) -> GraphRevision:
        errors = PlanValidator(intent_spec=intent_spec).validate(proposal)
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
                    INSERT INTO node_runtime_state (node_id, payload_json)
                    VALUES (?, ?)
                    ON CONFLICT(node_id) DO UPDATE SET payload_json = excluded.payload_json
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
            "agent_session_id": str(context.get("agent_session_id") or ""),
        }
        for key in ("intent", "pipeline_intent"):
            value = context.get(key)
            if isinstance(value, dict):
                sanitized[key] = _jsonable(value)
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

    def resolved_dispatch_context_for_node(self, node_id: str) -> dict[str, Any]:
        context = self.dispatch_context_for_node(node_id)
        if context:
            return context
        revision = self.current_graph_revision_record()
        if revision is not None and revision.root_node_id != node_id:
            context = self.dispatch_context_for_node(revision.root_node_id)
            if context:
                return context
        return {}

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

    def record_stuck_node_observation(self, node_id: str, *, reason: str, at: datetime | None = None) -> dict[str, Any]:
        graph_revision = self.current_graph_revision()
        now = (at or datetime.now(timezone.utc)).isoformat()
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT count, payload_json, first_seen_at FROM stuck_node_observations
                WHERE graph_revision = ? AND node_id = ?
                """,
                (graph_revision, node_id),
            ).fetchone()
            count = int(row["count"]) + 1 if row is not None else 1
            first_seen_at = str(row["first_seen_at"]) if row is not None else now
            payload = _json_loads(row["payload_json"]) if row is not None else {}
            payload.update(
                {
                    "node_id": node_id,
                    "graph_revision": graph_revision,
                    "reason": reason,
                    "count": count,
                    "first_seen_at": first_seen_at,
                    "last_seen_at": now,
                }
            )
            connection.execute(
                """
                INSERT INTO stuck_node_observations (graph_revision, node_id, count, payload_json, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(graph_revision, node_id) DO UPDATE SET
                  count = excluded.count,
                  payload_json = excluded.payload_json,
                  last_seen_at = excluded.last_seen_at
                """,
                (graph_revision, node_id, count, _json_dumps(payload), first_seen_at, now),
            )
        return payload

    def clear_stuck_node_observations_except(self, node_ids: set[str]) -> None:
        graph_revision = self.current_graph_revision()
        with self.connect() as connection:
            if not node_ids:
                connection.execute("DELETE FROM stuck_node_observations WHERE graph_revision = ?", (graph_revision,))
                return
            placeholders = ",".join("?" for _ in node_ids)
            connection.execute(
                f"""
                DELETE FROM stuck_node_observations
                WHERE graph_revision = ? AND node_id NOT IN ({placeholders})
                """,
                (graph_revision, *sorted(node_ids)),
            )

    def list_stuck_node_observations(self) -> list[dict[str, Any]]:
        graph_revision = self.current_graph_revision()
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM stuck_node_observations
                WHERE graph_revision = ?
                ORDER BY node_id
                """,
                (graph_revision,),
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def record_graph_delivery(
        self,
        *,
        status: str,
        branch_name: str = "",
        pr_url: str = "",
        repository_path: str = "",
        error: str = "",
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        created_at = _now()
        payload = {
            "delivery_id": f"delivery-{uuid4().hex}",
            "graph_revision": self.current_graph_revision(),
            "status": status,
            "branch_name": branch_name,
            "pr_url": pr_url,
            "repository_path": repository_path,
            "error": error,
            "details": details or {},
            "created_at": created_at,
            "updated_at": created_at,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO graph_deliveries (
                  delivery_id, graph_revision, status, payload_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["delivery_id"],
                    payload["graph_revision"],
                    payload["status"],
                    _json_dumps(payload),
                    created_at,
                    created_at,
                ),
            )
        return payload

    def list_graph_deliveries(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM graph_deliveries ORDER BY created_at, delivery_id"
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

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
        graph_revision = self.current_graph_revision() if graph_revision is None else graph_revision
        policy_revision = (
            self.active_runtime_config().scheduler_policy.version
            if policy_revision is None
            else policy_revision
        )
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
        commit_sha = str(code.get("commit_sha") or code.get("result_revision") or "").strip()
        workspace_path = str(code.get("workspace_path") or "").strip()
        if commit_sha and workspace_path:
            return self._integrate_manifest_commit(
                repository_path,
                manifest=manifest,
                commit_sha=commit_sha,
                workspace_path=Path(workspace_path),
            )
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

    def _integrate_manifest_commit(
        self,
        repository_path: Path,
        *,
        manifest: TaskOutputManifest,
        commit_sha: str,
        workspace_path: Path,
    ) -> str:
        if not workspace_path.exists():
            raise ValueError("integration workspace unavailable")
        original_revision = _git(["rev-parse", "HEAD"], cwd=repository_path).strip()
        integration_base = self.current_integrated_revision(repository_path) or original_revision
        fetch_ref = f"refs/symphony/integration/{_safe_path_part(manifest.verify_attempt_id)}"
        try:
            _git(["checkout", "--quiet", integration_base], cwd=repository_path)
            _git(["fetch", "--quiet", str(workspace_path), f"{commit_sha}:{fetch_ref}"], cwd=repository_path)
            try:
                _git(["merge", "--no-ff", "--no-edit", fetch_ref], cwd=repository_path)
            except subprocess.CalledProcessError as exc:
                output = str(exc.output or "")
                if "Already up to date" not in output:
                    raise
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

    def verified_branch_manifest_for_node(self, node_id: str) -> TaskOutputManifest | None:
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
            branch_name = str(manifest.code.get("branch_name") or "").strip()
            commit_sha = str(manifest.code.get("commit_sha") or manifest.code.get("result_revision") or "").strip()
            if branch_name and commit_sha:
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
            manifest = self.verified_branch_manifest_for_node(blocker_id)
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
            GraphNodeState.NEED_HUMAN,
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
            node_id = str(payload["node_id"])
            self._update_node_state_on_connection(
                connection,
                node_id,
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

    def record_linear_projection_success(self, *, revision: int | None = None) -> dict[str, Any]:
        now = _now()
        payload = {
            "healthy": True,
            "last_successful_projection_at": now,
            "last_projected_revision": revision if revision is not None else self.current_graph_revision(),
            "last_projection_error": "",
            "updated_at": now,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO linear_projection_health (id, payload_json, updated_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (_json_dumps(payload), now),
            )
        return payload

    def record_linear_projection_failure(self, error: str, *, revision: int | None = None) -> dict[str, Any]:
        existing = self.linear_projection_health()
        now = _now()
        payload = {
            "healthy": False,
            "last_successful_projection_at": existing.get("last_successful_projection_at") or "",
            "last_projected_revision": existing.get("last_projected_revision") or revision or self.current_graph_revision(),
            "last_projection_error": _sanitize_error(error),
            "updated_at": now,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO linear_projection_health (id, payload_json, updated_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (_json_dumps(payload), now),
            )
        return payload

    def linear_projection_health(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute("SELECT payload_json FROM linear_projection_health WHERE id = 1").fetchone()
        if row is None:
            return {
                "healthy": True,
                "last_successful_projection_at": "",
                "last_projected_revision": None,
                "last_projection_error": "",
                "updated_at": "",
            }
        return _json_loads(row["payload_json"])

    def list_linear_projections(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM linear_projections ORDER BY projection_id",
            ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def get_linear_projection_comment(self, comment_key: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM linear_projection_comments WHERE comment_key = ?",
                (comment_key,),
            ).fetchone()
        return _json_loads(row["payload_json"]) if row is not None else None

    def record_linear_projection_comment(
        self,
        *,
        comment_key: str,
        linear_issue_id: str,
        comment_id: str,
    ) -> dict[str, Any]:
        payload = {
            "comment_key": comment_key,
            "linear_issue_id": linear_issue_id,
            "comment_id": comment_id,
            "updated_at": _now(),
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO linear_projection_comments (
                  comment_key, linear_issue_id, comment_id, payload_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(comment_key) DO UPDATE SET
                  linear_issue_id = excluded.linear_issue_id,
                  comment_id = excluded.comment_id,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (comment_key, linear_issue_id, comment_id, _json_dumps(payload), payload["updated_at"]),
            )
        return payload

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
        attempts = [attempt for attempt in self.list_attempts() if attempt.node_id == node.node_id]
        active_lease = None
        for mode in RuntimeMode:
            lease = self.active_lease(node.node_id, mode)
            if lease is not None:
                active_lease = lease
                break
        human_waits = [
            wait
            for wait in self.list_human_waits()
            if str(wait.get("node_id") or "") == node.node_id and str(wait.get("status") or "waiting") == "waiting"
        ]
        metadata = {
            "graph_id": revision.graph_id,
            "node_id": node.node_id,
            "plan_attempt_id": revision.plan_attempt_id,
            "gate_snapshot_hash": node.gate_snapshot_hash,
            "conductor_revision": revision.revision,
            "operator_status": self._linear_operator_status(node, runtime_wait=runtime_wait),
            "attempts": [
                {
                    "attempt_id": attempt.attempt_id,
                    "mode": attempt.mode.value,
                    "state": attempt.state.value,
                    "score": attempt.score,
                    "thread_id": attempt.thread_id,
                    "kind": attempt.kind,
                    "process_pid": attempt.process_pid,
                    "lease_id": attempt.lease_id,
                    "started_at": attempt.started_at,
                    "error": attempt.error,
                    "completed_at": attempt.completed_at,
                }
                for attempt in attempts
            ],
            "rework_count": node.rework_count,
            "replan_depth": node.replan_depth,
            "verify_score": node.verify_score,
            "active_lease": active_lease.to_dict() if active_lease is not None else None,
            "human_waits": human_waits,
            "runtime_wait": runtime_wait,
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
        if active_human_waits or node.state is GraphNodeState.NEED_HUMAN:
            return "need_human"
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

    def insert_merge_conflict_resolver(self, target_node_id: str, *, error: str) -> GraphRevision:
        current = self.current_graph_revision_record()
        if current is None:
            raise KeyError(target_node_id)
        target = self.get_node(target_node_id)
        blocker_ids = self.blockers_for(target_node_id)
        if not blocker_ids:
            raise ValueError("merge conflict resolver requires blockers")
        existing_node_ids = {node.node_id for node in self.list_nodes()}
        base_resolver_id = f"{target_node_id}-merge-conflict"
        resolver_id = base_resolver_id
        suffix = 2
        while resolver_id in existing_node_ids:
            resolver_id = f"{base_resolver_id}-{suffix}"
            suffix += 1
        gate = GateSpecSnapshot.create(
            gate_id=f"gate-{resolver_id}",
            task_id=resolver_id,
            created_by="conductor-merge-conflict",
            created_at=_now(),
            content=GateSpecContent(
                acceptance_criteria=[f"Resolve merge conflict before {target_node_id} executes."],
                verification_procedure=[GateStep("git diff --check", GateStepSource.SYSTEM_REPAIR)],
                rubric={str(score): f"score {score}" for score in range(5)},
                pass_threshold=PASS_THRESHOLD,
            ),
        )
        resolver = GraphNode(
            node_id=resolver_id,
            title=f"Resolve merge conflict for {target.title}",
            state=GraphNodeState.READY,
            gate_snapshot_hash=gate.hash,
            issue_id=target.issue_id,
            issue_identifier=target.issue_identifier,
        )
        nodes = [*self.list_nodes(), resolver]
        blocks = [
            (source, blocked)
            for source, blocked in self.current_blocks()
            if not (blocked == target_node_id and source in blocker_ids)
        ]
        blocks.extend((blocker_id, resolver_id) for blocker_id in blocker_ids)
        blocks.append((resolver_id, target_node_id))
        node_ids = {node.node_id for node in nodes}
        blockers = {blocked for _source, blocked in blocks}
        blocked_by = {source for source, _blocked in blocks}
        gates = [gate for node in nodes for gate in [self.gate_for_node(node.node_id)] if gate is not None]
        gates.append(gate)
        return self.commit_plan(
            PlanProposal(
                graph_id=current.graph_id,
                plan_attempt_id=current.plan_attempt_id,
                root_node_id=current.root_node_id,
                nodes=nodes,
                blocks=blocks,
                gates=gates,
                entry_node_ids=sorted(node_ids - blockers),
                exit_node_ids=sorted(node_ids - blocked_by),
            )
        )

    def replace_node_with_subgraph(self, node_id: str, subgraph: PlanProposal, *, intent_spec: IntentSpec | None = None) -> GraphRevision:
        if intent_spec is not None:
            subgraph = PlanRepair(intent_spec).repair(subgraph)
        errors = PlanValidator(intent_spec=intent_spec).validate(subgraph)
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
        retained_subgraph_node_ids = {
            subgraph.root_node_id
            for node in subgraph.nodes
            if node.node_id == subgraph.root_node_id and node.node_id in nodes and node.node_id != node_id
        }
        replacement_source_nodes = [
            node for node in subgraph.nodes if node.node_id not in retained_subgraph_node_ids
        ]
        replacement_ids = [node.node_id for node in replacement_source_nodes]
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
                replan_depth=old.replan_depth,
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
                replan_depth=old.replan_depth + 1,
                superseded_by=list(node.superseded_by),
                human_reason=node.human_reason,
            )
            for node in replacement_source_nodes
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
            if result.mode in {RuntimeMode.EXECUTE, RuntimeMode.VERIFY}:
                self._handle_same_stage_attempt_failure(result, error=visible_error)
            else:
                self._create_attempt_failure_human_wait(result, error=visible_error)
            return True
        if isinstance(result, PlanAttemptResult):
            if result.proposal is None:
                return False
            intent_spec = self._intent_spec_for_plan_node(result.node_id)
            proposal = PlanRepair(intent_spec).repair(result.proposal)
            validation_errors = PlanValidator(intent_spec=intent_spec).validate(proposal)
            if self._plan_result_should_replace_node(result.node_id, node):
                max_replan_depth = self.active_runtime_config().scheduler_policy.max_rework_attempts
                if node.replan_depth >= max_replan_depth:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                        error=f"replan_depth_limit_exceeded depth={node.replan_depth} limit={max_replan_depth}",
                    )
                if validation_errors:
                    return self._fail_plan_attempt_with_human_wait(
                        result,
                        at=at,
                        reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                        error=_plan_validation_error_summary(validation_errors),
                    )
                try:
                    self.replace_node_with_subgraph(result.node_id, proposal, intent_spec=intent_spec)
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
                    self.commit_plan(proposal, intent_spec=intent_spec)
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
                self.update_node_state(
                    result.node_id,
                    GraphNodeState.REPLANNING,
                    verify_score=result.score,
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

    def _plan_result_should_replace_node(self, node_id: str, node: GraphNode) -> bool:
        if node.state is not GraphNodeState.REPLANNING:
            return False
        revision = self.current_graph_revision_record()
        if revision is None:
            return False
        if revision.root_node_id == node_id and len(self.list_nodes()) == 1:
            return False
        return True

    def _intent_spec_for_plan_node(self, node_id: str) -> IntentSpec:
        context = self.resolved_dispatch_context_for_node(node_id)
        if not context:
            node = self.get_node(node_id)
            context = {
                "issue_id": node.issue_id or node.node_id,
                "issue_identifier": node.issue_identifier or "",
                "description": "",
            }
        return IntentSpec.from_dispatch_context(context)

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
        branch_required = [
            snapshot.base_revision,
            snapshot.branch_name,
            snapshot.commit_sha,
            snapshot.evidence_uri,
            snapshot.repository_path,
            snapshot.workspace_path,
        ]
        if all(str(value).strip() for value in branch_required):
            return True
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
        if result.graph_revision != attempt.graph_revision:
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
            thread_id=result.thread_id or attempt.thread_id,
            kind=result.kind or attempt.kind,
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

    def fail_running_attempt_for_recovery(
        self,
        attempt_id: str,
        *,
        error: str,
        at: datetime,
    ) -> bool:
        try:
            attempt = self.get_attempt(attempt_id)
        except KeyError:
            return False
        if attempt.state is not AttemptState.RUNNING:
            return False
        lease = self.active_lease(attempt.node_id, attempt.mode)
        if lease is None or lease.attempt_id != attempt.attempt_id:
            return False
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=AttemptState.FAILED,
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
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE attempts
                SET state = ?, payload_json = ?
                WHERE attempt_id = ?
                """,
                (AttemptState.FAILED.value, _json_dumps(updated.to_dict()), updated.attempt_id),
            )
            connection.execute("UPDATE worker_leases SET active = 0 WHERE lease_id = ?", (lease.lease_id,))
        self.update_node_state(attempt.node_id, _retry_state_for_attempt_mode(attempt.mode))
        self.resolve_runtime_waits_for_attempt(updated.attempt_id, resolution="attempt failed during startup recovery")
        return True

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
        elif visible_error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in visible_error.lower():
            reason = HumanEscalationReason.THREAD_LOST
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

    def _handle_same_stage_attempt_failure(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        error: str,
    ) -> None:
        if error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in error.lower():
            self._create_attempt_failure_human_wait(result, error=error)
            return
        node = self.get_node(result.node_id)
        next_retry_count = node.rework_count + 1
        max_retries = self.active_runtime_config().scheduler_policy.max_rework_attempts
        if next_retry_count >= max_retries:
            reason = (
                HumanEscalationReason.GATE_UNEXECUTABLE
                if result.mode is RuntimeMode.VERIFY
                else HumanEscalationReason.BACKEND_UNAVAILABLE
            )
            self.create_human_wait(
                result.node_id,
                reason=reason.value,
                details={
                    "mode": result.mode.value,
                    "attempt_id": result.attempt_id,
                    "lease_id": result.lease_id,
                    "error": error,
                    "retry_count": next_retry_count,
                    "max_retries": max_retries,
                },
            )
            self.update_node_state(
                result.node_id,
                GraphNodeState.NEED_HUMAN,
                rework_count=next_retry_count,
                human_reason=reason,
            )
            return
        self.update_node_state(
            result.node_id,
            _retry_state_for_attempt_mode(result.mode),
            rework_count=next_retry_count,
            human_reason=None,
        )

    def pipeline_view(self) -> PipelineView:
        envelope = self.active_runtime_config()
        policy_source = self.active_runtime_config_source()
        scheduler_policy = self.latest_scheduler_tick_policy()
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
            policy_id=envelope.scheduler_policy.policy_id,
            policy_source=policy_source,
            last_scheduler_policy_id=str(scheduler_policy.get("policy_id") or ""),
            last_scheduler_policy_version=int(scheduler_policy.get("policy_version") or 0),
            last_scheduler_policy_source=str(scheduler_policy.get("policy_source") or "no_scheduler_tick"),
            last_scheduler_tick_at=str(scheduler_policy.get("recorded_at") or ""),
            nodes=[
                {
                    **node.to_dict(),
                    "graph_revision": self.current_graph_revision(),
                    "progress_measure": self._node_progress_measure(node, envelope),
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
            stuck_observations=self.list_stuck_node_observations(),
            linear_projections=self._current_linear_projections(nodes),
            graph_deliveries=self.list_graph_deliveries(),
            prediction_basis={
                "graph_revision": self.current_graph_revision(),
                "policy_revision": envelope.scheduler_policy.version,
                "assumption": "unknown verifies pass",
                "generated_at": _now(),
                "pass_threshold": PASS_THRESHOLD,
                "policy_id": str(scheduler_policy.get("policy_id") or envelope.scheduler_policy.policy_id),
                "policy_version": int(scheduler_policy.get("policy_version") or envelope.scheduler_policy.version),
                "policy_source": str(scheduler_policy.get("policy_source") or policy_source),
                "last_scheduler_tick_at": str(scheduler_policy.get("recorded_at") or ""),
                "basis": "current graph revision, active leases, last scheduler policy, and VERIFY_PASSED blockers",
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
            if node.state is GraphNodeState.NEED_HUMAN:
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
        if blocker.state is GraphNodeState.NEED_HUMAN:
            reason = f" ({blocker.human_reason.value})" if blocker.human_reason is not None else ""
            return [f"{blocker.node_id}: awaiting human{reason}"]
        if blocker.state is GraphNodeState.FAILED:
            return [f"{blocker.node_id}: failed"]
        if not _node_verify_passed(blocker):
            return [f"{blocker.node_id}: verify not passed"]
        if self.verified_branch_manifest_for_node(blocker.node_id) is None:
            return [f"{blocker.node_id}: verified branch output missing"]
        return []

    def _reserve_prediction_wave(
        self,
        earliest_position: int,
        mode: RuntimeMode,
        capacity: SchedulerCapacity,
        wave_usage: dict[int, dict[RuntimeMode, int]],
        wave_global_usage: dict[int, int],
    ) -> int:
        if capacity.global_limit == 0 or capacity.by_mode.get(mode) == 0:
            return earliest_position
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

    def _node_progress_measure(self, node: GraphNode, envelope: RuntimeConfigEnvelope) -> dict[str, Any]:
        return {
            "replan_depth": node.replan_depth,
            "rework_count": node.rework_count,
            "max_rework_attempts": envelope.scheduler_policy.max_rework_attempts,
            "terminal": node.state
            in {
                GraphNodeState.VERIFY_PASSED,
                GraphNodeState.FAILED,
                GraphNodeState.SUPERSEDED,
                GraphNodeState.NEED_HUMAN,
            },
            "next_action": _node_next_action(node),
        }
