from __future__ import annotations

from .conductor_pipeline_projection_common import *


class ActivityMixin:
    async def _project_agent_activity(
        self,
        *,
        issue_id: str,
        node: GraphNode,
        metadata: dict[str, Any],
        prior_metadata: Any,
    ) -> int:
        agent_session_id = self._agent_session_id_for_node(node.node_id)
        if not agent_session_id or not _is_uuid(agent_session_id):
            return 0
        create_activity = getattr(self.tracker, "agent_activity_create", None)
        if create_activity is None:
            return 0
        prior_status = ""
        if isinstance(prior_metadata, dict):
            prior_status = str(prior_metadata.get("operator_status") or "")
        current_status = str(metadata.get("operator_status") or "")
        if prior_status == current_status:
            return 0
        content = _linear_activity_content(node, metadata, graph_complete=self._graph_complete())
        await create_activity(agent_session_id=agent_session_id, content=content)
        return 1

    async def _project_workflow_state(self, issue_id: str, node: GraphNode) -> int:
        transition = getattr(self.tracker, "transition_issue_by_state_target", None)
        if transition is None:
            return 0
        names, state_type = _linear_workflow_state_target_for_node(node, graph_complete=self._graph_complete())
        if not names:
            return 0
        result = await transition(issue_id, names=names, state_type=state_type)
        if isinstance(result, dict) and result.get("success") is False:
            reason = str(result.get("reason") or "transition_rejected")
            current = str(result.get("state") or result.get("current_state") or "")
            target = ",".join(names)
            raise RuntimeError(
                "linear_workflow_transition_failed "
                f"issue_id={issue_id} node_id={node.node_id} target={target} "
                f"state_type={state_type} current_state={current} reason={reason}"
            )
        return 1

    def _graph_complete(self) -> bool:
        nodes = self.store.list_nodes()
        complete_states = {GraphNodeState.VERIFY_PASSED, GraphNodeState.SUPERSEDED}
        return (
            bool(nodes)
            and any(node.state is GraphNodeState.VERIFY_PASSED for node in nodes)
            and all(node.state in complete_states for node in nodes)
        )

    def _agent_session_id_for_node(self, node_id: str) -> str:
        context = self.store.resolved_dispatch_context_for_node(node_id)
        session_id = str(context.get("agent_session_id") or "").strip()
        if session_id:
            return session_id
        revision = self.store.current_graph_revision_record()
        if revision is not None:
            root_context = self.store.dispatch_context_for_node(revision.root_node_id)
            return str(root_context.get("agent_session_id") or "").strip()
        return ""

    def _root_status_block(self, revision: GraphRevision) -> str:
        debug_projection = _debug_projection_enabled()
        projection_health = self.store.linear_projection_health()
        projection_healthy = bool(projection_health.get("healthy", True))
        lines = [
            "```yaml",
            "symphony_pipeline:",
            f"  graph_id: {revision.graph_id}",
            f"  conductor_revision: {revision.revision}",
            f"  graph_complete: {str(self._graph_complete()).lower()}",
            f"  projection_healthy: {str(projection_healthy).lower()}",
            f"  last_successful_projection_at: {_yaml_scalar(projection_health.get('last_successful_projection_at') or '')}",
        ]
        if not projection_healthy:
            lines.append(f"  last_projection_error: {_yaml_scalar(projection_health.get('last_projection_error') or '')}")
        lines.append("  nodes:")
        for node in self.store.list_nodes():
            metadata = self._metadata(node, revision)
            active_lease = metadata.get("active_lease") if isinstance(metadata.get("active_lease"), dict) else None
            lines.extend(
                [
                    f"    - node_id: {_yaml_scalar(node.node_id)}",
                    f"      state: {_yaml_scalar(node.state.value)}",
                    f"      operator_status: {_yaml_scalar(metadata.get('operator_status'))}",
                    f"      verify_score: {_yaml_scalar(node.verify_score)}",
                    f"      rework_count: {node.rework_count}",
                    f"      replan_depth: {node.replan_depth}",
                ]
            )
            if active_lease is not None:
                lines.append(f"      active_lease_mode: {_yaml_scalar(active_lease.get('mode'))}")
                lines.append(f"      heartbeat_at: {_yaml_scalar(active_lease.get('heartbeat_at'))}")
                if debug_projection:
                    lines.extend(
                        [
                            f"      lease_id: {_yaml_scalar(active_lease.get('lease_id'))}",
                            f"      fencing_token: {_yaml_scalar(active_lease.get('fencing_token'))}",
                            f"      attempt_id: {_yaml_scalar(active_lease.get('attempt_id'))}",
                        ]
                    )
            attempts = metadata.get("attempts") if isinstance(metadata.get("attempts"), list) else []
            if attempts:
                latest = attempts[-1]
                if isinstance(latest, dict):
                    lines.append(f"      current_attempt_mode: {_yaml_scalar(latest.get('mode'))}")
                    if debug_projection:
                        lines.append(f"      current_attempt_id: {_yaml_scalar(latest.get('attempt_id'))}")
                        lines.append(f"      process_pid: {_yaml_scalar(latest.get('process_pid'))}")
            human_reason = node.human_reason.value if node.human_reason is not None else ""
            if human_reason:
                lines.append(f"      human_reason: {_yaml_scalar(human_reason)}")
        lines.append("```")
        return "\n".join(lines)

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
