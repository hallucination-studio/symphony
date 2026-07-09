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
    _attempt_comment_block,
    _debug_projection_enabled,
    _is_uuid,
    _issue_relations,
    _linear_activity_content,
    _linear_issue_in_need_human_state,
    _linear_workflow_state_target_for_node,
    _need_human_instruction_block,
    _nodes_parent_first,
    _projected_node_id_from_description,
    _yaml_scalar,
)
from .conductor_pipeline_store import ConductorPipelineStore, GraphRevision

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
        lines.extend(
            [
                f"  rework_count: {int(metadata.get('rework_count') or 0)}",
                f"  replan_depth: {int(metadata.get('replan_depth') or 0)}",
                f"  verify_score: {_yaml_scalar(metadata.get('verify_score'))}",
                "  attempts:",
            ]
        )
        debug_projection = _debug_projection_enabled()
        for attempt in metadata.get("attempts") or []:
            if not isinstance(attempt, dict):
                continue
            lines.extend(
                [
                    f"    - mode: {_yaml_scalar(attempt.get('mode'))}",
                    f"      state: {_yaml_scalar(attempt.get('state'))}",
                    f"      score: {_yaml_scalar(attempt.get('score'))}",
                ]
            )
            if attempt.get("thread_id"):
                lines.append(f"      thread_id: {_yaml_scalar(attempt.get('thread_id'))}")
            if attempt.get("kind"):
                lines.append(f"      kind: {_yaml_scalar(attempt.get('kind'))}")
            if debug_projection:
                lines.extend(
                    [
                        f"      attempt_id: {_yaml_scalar(attempt.get('attempt_id'))}",
                        f"      lease_id: {_yaml_scalar(attempt.get('lease_id'))}",
                        f"      process_pid: {_yaml_scalar(attempt.get('process_pid'))}",
                    ]
                )
        active_lease = metadata.get("active_lease") if isinstance(metadata.get("active_lease"), dict) else None
        if active_lease is not None:
            lines.extend(
                [
                    "  active_lease:",
                    f"    mode: {_yaml_scalar(active_lease.get('mode'))}",
                    f"    heartbeat_at: {_yaml_scalar(active_lease.get('heartbeat_at'))}",
                ]
            )
            if debug_projection:
                lines.extend(
                    [
                        f"    lease_id: {_yaml_scalar(active_lease.get('lease_id'))}",
                        f"    fencing_token: {_yaml_scalar(active_lease.get('fencing_token'))}",
                        f"    attempt_id: {_yaml_scalar(active_lease.get('attempt_id'))}",
                    ]
                )
        if metadata.get("human_waits"):
            lines.append("  human_waits:")
            for wait in metadata.get("human_waits") or []:
                if isinstance(wait, dict):
                    lines.append(f"    - reason: {_yaml_scalar(wait.get('reason'))}")
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
