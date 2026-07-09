from __future__ import annotations

from .conductor_pipeline_projection_common import *


class ReconcileMixin:
    async def reconcile_once(self) -> int:
        revision = self.store.current_graph_revision_record()
        if revision is None or not self.root_issue_id:
            return 0
        projected = 0
        projected += await self._project_root_status_comment(revision)
        issue_ids_by_node: dict[str, str] = {}
        existing = await self._existing_node_issues()
        prior_metadata_by_node = {
            str(projection.get("node_id") or ""): projection.get("metadata")
            for projection in self.store.list_linear_projections()
            if str(projection.get("node_id") or "")
        }
        for projection in self.store.list_linear_projections():
            node_id = str(projection.get("node_id") or "")
            issue_id = str(projection.get("linear_issue_id") or "")
            if node_id and issue_id and node_id not in existing:
                existing[node_id] = {"id": issue_id}
        for node in _nodes_parent_first(self.store.list_nodes()):
            is_root_issue_node = node.node_id == revision.root_node_id and node.issue_id == self.root_issue_id
            issue = {"id": self.root_issue_id} if is_root_issue_node else existing.get(node.node_id)
            if issue is None:
                parent_issue_id = self._projection_parent_issue_id(node, issue_ids_by_node)
                issue = await self.tracker.create_child_issue_for(
                    parent_issue_id=parent_issue_id,
                    title=node.title,
                    description=self._description_block(node, revision),
                    label_names=["performer:type/pipeline-node"],
                    delegate_id=self.delegate_id,
                )
            issue_id = str(issue.get("id") or "")
            if not issue_id:
                raise RuntimeError(f"linear_projection_issue_missing_id node_id={node.node_id}")
            update_description = getattr(self.tracker, "update_issue_description_marker_block", None)
            if update_description is not None:
                await update_description(issue_id, "SYMPHONY PIPELINE NODE", self._description_block(node, revision))
            metadata = self._metadata(node, revision)
            projected += await self._project_attempt_comments(issue_id=issue_id, metadata=metadata)
            projected += await self._project_need_human_instruction(issue_id=issue_id, node=node, metadata=metadata)
            projected += await self._project_workflow_state(issue_id, node)
            projected += await self._project_agent_activity(
                issue_id=issue_id,
                node=node,
                metadata=metadata,
                prior_metadata=prior_metadata_by_node.get(node.node_id),
            )
            self.store.record_linear_projection(
                node_id=node.node_id,
                linear_issue_id=issue_id,
                metadata=metadata,
            )
            issue_ids_by_node[node.node_id] = issue_id
            projected += 1
        projected += await self._project_block_edges(issue_ids_by_node)
        self.store.record_linear_projection_success(revision=revision.revision)
        projected += await self._project_root_status_comment(revision)
        return projected

    async def _project_attempt_comments(self, *, issue_id: str, metadata: dict[str, Any]) -> int:
        projected = 0
        for attempt in metadata.get("attempts") or []:
            if not isinstance(attempt, dict):
                continue
            attempt_id = str(attempt.get("attempt_id") or "").strip()
            if not attempt_id:
                continue
            if await self._upsert_projection_comment(
                issue_id=issue_id,
                comment_key=f"attempt:{attempt_id}",
                body=_attempt_comment_block(attempt),
            ):
                projected += 1
        return projected

    async def _project_need_human_instruction(
        self,
        *,
        issue_id: str,
        node: GraphNode,
        metadata: dict[str, Any],
    ) -> int:
        if node.state is not GraphNodeState.NEED_HUMAN:
            return 0
        reason = node.human_reason.value if node.human_reason is not None else "NEED_HUMAN"
        waits = [wait for wait in metadata.get("human_waits") or [] if isinstance(wait, dict)]
        wait = waits[-1] if waits else {}
        comment_suffix = str(wait.get("wait_id") or f"{node.node_id}:{reason}")
        projected = await self._upsert_projection_comment(
            issue_id=issue_id,
            comment_key=f"need-human:{comment_suffix}",
            body=_need_human_instruction_block(node, wait),
        )
        return 1 if projected else 0

    async def _project_root_status_comment(self, revision: GraphRevision) -> int:
        projected = await self._upsert_projection_comment(
            issue_id=self.root_issue_id,
            comment_key=f"root-status:{self.root_issue_id}",
            body=self._root_status_block(revision),
        )
        return 1 if projected else 0

    async def _upsert_projection_comment(self, *, issue_id: str, comment_key: str, body: str) -> bool:
        create_comment = getattr(self.tracker, "comment_issue", None)
        if create_comment is None:
            return False
        stored = self.store.get_linear_projection_comment(comment_key)
        update_comment = getattr(self.tracker, "update_issue_comment", None)
        if (
            isinstance(stored, dict)
            and str(stored.get("linear_issue_id") or "") == issue_id
            and str(stored.get("comment_id") or "").strip()
        ):
            comment_id = str(stored["comment_id"])
            if update_comment is None:
                return False
            result = await update_comment(comment_id, body)
            if isinstance(result, dict) and result.get("success") is False:
                reason = str(result.get("reason") or "comment_update_rejected")
                raise RuntimeError(f"linear_projection_comment_update_failed issue_id={issue_id} comment_key={comment_key} reason={reason}")
            if isinstance(result, dict) and result.get("success"):
                next_comment_id = str(result.get("comment_id") or comment_id)
                self.store.record_linear_projection_comment(
                    comment_key=comment_key,
                    linear_issue_id=issue_id,
                    comment_id=next_comment_id,
                )
                return True
        result = await create_comment(issue_id, body)
        if isinstance(result, dict) and result.get("success") is False:
            reason = str(result.get("reason") or "comment_create_rejected")
            raise RuntimeError(f"linear_projection_comment_create_failed issue_id={issue_id} comment_key={comment_key} reason={reason}")
        if not isinstance(result, dict) or not result.get("success"):
            raise RuntimeError(f"linear_projection_comment_create_failed issue_id={issue_id} comment_key={comment_key} reason=invalid_response")
        comment_id = str(result.get("comment_id") or "").strip()
        if not comment_id:
            return False
        self.store.record_linear_projection_comment(
            comment_key=comment_key,
            linear_issue_id=issue_id,
            comment_id=comment_id,
        )
        return True
