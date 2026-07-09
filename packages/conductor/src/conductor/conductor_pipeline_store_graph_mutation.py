from __future__ import annotations

from .conductor_pipeline_store_common import *

class GraphMutationMixin:
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
        subgraph = self._validated_replacement_subgraph(subgraph, intent_spec)
        context = self._replacement_context(node_id, subgraph)
        retained_nodes, replacement_nodes = self._replacement_node_sets(node_id, subgraph, context)
        new_edges = self._replacement_edges(node_id, subgraph, context)
        revision = self._commit_replacement_revision(subgraph, node_id, retained_nodes, replacement_nodes, new_edges)
        return GraphRevision(
            graph_id=subgraph.graph_id,
            revision=revision,
            plan_attempt_id=subgraph.plan_attempt_id,
            root_node_id=subgraph.root_node_id,
        )

    def _validated_replacement_subgraph(
        self,
        subgraph: PlanProposal,
        intent_spec: IntentSpec | None,
    ) -> PlanProposal:
        repaired = PlanRepair(intent_spec).repair(subgraph) if intent_spec is not None else subgraph
        errors = PlanValidator(intent_spec=intent_spec).validate(repaired)
        if errors:
            names = ", ".join(sorted(error.value for error in errors))
            raise ValueError(f"invalid replacement subgraph: {names}")
        return repaired
    def _replacement_context(self, node_id: str, subgraph: PlanProposal) -> dict[str, Any]:
        if self.current_graph_revision() <= 0:
            raise KeyError(node_id)
        nodes = {node.node_id: node for node in self.list_nodes()}
        if node_id not in nodes:
            raise KeyError(node_id)
        retained_subgraph_node_ids = {
            subgraph.root_node_id
            for node in subgraph.nodes
            if node.node_id == subgraph.root_node_id and node.node_id in nodes and node.node_id != node_id
        }
        replacement_source_nodes = [node for node in subgraph.nodes if node.node_id not in retained_subgraph_node_ids]
        replacement_ids = [node.node_id for node in replacement_source_nodes]
        subgraph_node_ids = set(replacement_ids)
        if node_id in subgraph_node_ids:
            raise ValueError("replacement subgraph reuses superseded node_id")
        existing_conflicts = sorted(subgraph_node_ids.intersection(nodes) - {node_id})
        if existing_conflicts:
            raise ValueError(f"replacement subgraph reuses existing node_id: {', '.join(existing_conflicts)}")
        return {
            "nodes": nodes,
            "old": nodes[node_id],
            "upstream": self.blockers_for(node_id),
            "downstream": self.dependents_for(node_id),
            "replacement_source_nodes": replacement_source_nodes,
            "replacement_ids": replacement_ids,
            "subgraph_node_ids": subgraph_node_ids,
        }
    def _replacement_node_sets(
        self,
        node_id: str,
        subgraph: PlanProposal,
        context: dict[str, Any],
    ) -> tuple[list[GraphNode], list[GraphNode]]:
        nodes = context["nodes"]
        old = context["old"]
        replacement_ids = context["replacement_ids"]
        subgraph_node_ids = context["subgraph_node_ids"]
        retained_nodes = [node for key, node in nodes.items() if key not in subgraph_node_ids]
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
            for node in context["replacement_source_nodes"]
        ]
        return retained_nodes, replacement_nodes
    def _replacement_edges(
        self,
        node_id: str,
        subgraph: PlanProposal,
        context: dict[str, Any],
    ) -> list[tuple[str, str]]:
        nodes = context["nodes"]
        subgraph_node_ids = context["subgraph_node_ids"]
        existing_edges = [
            (source, target)
            for source in nodes
            for target in self.dependents_for(source)
            if source != node_id and target != node_id and source not in subgraph_node_ids and target not in subgraph_node_ids
        ]
        new_edges = list(dict.fromkeys(existing_edges + subgraph.blocks))
        for source in context["upstream"]:
            for entry in subgraph.entry_node_ids:
                new_edges.append((source, entry))
        for exit_node in subgraph.exit_node_ids:
            for target in context["downstream"]:
                new_edges.append((exit_node, target))
        return list(dict.fromkeys(new_edges))
    def _commit_replacement_revision(
        self,
        subgraph: PlanProposal,
        node_id: str,
        retained_nodes: list[GraphNode],
        replacement_nodes: list[GraphNode],
        new_edges: list[tuple[str, str]],
    ) -> int:
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
        return revision
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
