from __future__ import annotations

from .conductor_pipeline_store_common import *


class ObservabilityMixin:
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
