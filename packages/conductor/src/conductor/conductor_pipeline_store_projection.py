from __future__ import annotations

from .conductor_pipeline_store_common import *


class ProjectionMixin:
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
