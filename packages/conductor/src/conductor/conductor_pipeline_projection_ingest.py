from __future__ import annotations

from .conductor_pipeline_projection_common import *


class IngestMixin:
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
        resumed = self._ingest_need_human_state_flips(children)
        return (1 if graph_revision is not None else 0) + resumed

    def _ingest_need_human_state_flips(self, children: dict[str, dict[str, Any]]) -> int:
        resumed = 0
        waiting_by_node: dict[str, list[dict[str, Any]]] = {}
        for wait in self.store.list_human_waits():
            if str(wait.get("status") or "waiting") != "waiting":
                continue
            waiting_by_node.setdefault(str(wait.get("node_id") or ""), []).append(wait)
        if not waiting_by_node:
            return 0
        for node_id, waits in waiting_by_node.items():
            try:
                node = self.store.get_node(node_id)
            except KeyError:
                continue
            if node.state is not GraphNodeState.NEED_HUMAN:
                continue
            issue = children.get(node_id)
            if issue is None or _linear_issue_in_need_human_state(issue):
                continue
            for wait in waits:
                self.store.resume_human_wait(
                    str(wait["wait_id"]),
                    resolution=f"Linear issue state flip resumed node {node_id}.",
                )
                resumed += 1
        return resumed

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

    def _projection_parent_issue_id(self, node: GraphNode, issue_ids_by_node: dict[str, str]) -> str:
        parent_node_id = str(node.parent_node_id or "").strip()
        if parent_node_id:
            parent_issue_id = issue_ids_by_node.get(parent_node_id)
            if parent_issue_id:
                return parent_issue_id
            try:
                parent_node = self.store.get_node(parent_node_id)
            except KeyError:
                parent_node = None
            if parent_node is not None and parent_node.issue_id == self.root_issue_id:
                return self.root_issue_id
        return self.root_issue_id

    async def _existing_node_issues(self) -> dict[str, dict[str, Any]]:
        fetch = getattr(self.tracker, "fetch_child_issues", None)
        if fetch is None:
            return {}
        result: dict[str, dict[str, Any]] = {}
        pending = [self.root_issue_id]
        seen_issue_ids: set[str] = set()
        while pending:
            parent_issue_id = pending.pop(0)
            if parent_issue_id in seen_issue_ids:
                continue
            seen_issue_ids.add(parent_issue_id)
            children = await fetch(parent_issue_id, label_name="performer:type/pipeline-node")
            for child in children or []:
                if not isinstance(child, dict):
                    continue
                issue_id = str(child.get("id") or "")
                node_id = _projected_node_id_from_description(str(child.get("description") or ""))
                if node_id:
                    result[node_id] = child
                if issue_id:
                    pending.append(issue_id)
        return result
