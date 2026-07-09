from __future__ import annotations

from .conductor_pipeline_store_common import *


class GraphMixin:
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
