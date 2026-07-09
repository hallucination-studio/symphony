from __future__ import annotations

from .conductor_pipeline_coordinator_common import *


class DispatchMixin:
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
                "agent_session_id": event.get("agent_session_id") or "",
                "intent": event.get("intent") if isinstance(event.get("intent"), dict) else {},
                "pipeline_intent": event.get("pipeline_intent") if isinstance(event.get("pipeline_intent"), dict) else {},
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
