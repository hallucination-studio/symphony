from __future__ import annotations

from .conductor_pipeline_helper_common import *


def _resume_state_for_human_wait(payload: dict[str, Any]) -> GraphNodeState:
    if payload.get("reason") == HumanEscalationReason.LINEAR_SYNC_CONFLICT.value:
        return GraphNodeState.VERIFY_PASSED
    details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
    try:
        mode = RuntimeMode(str(details.get("mode") or RuntimeMode.PLAN.value))
    except ValueError:
        mode = RuntimeMode.PLAN
    if mode is RuntimeMode.EXECUTE:
        return GraphNodeState.READY
    if mode is RuntimeMode.VERIFY:
        return GraphNodeState.VERIFYING
    return GraphNodeState.REPLANNING

def _retry_state_for_attempt_mode(mode: RuntimeMode) -> GraphNodeState:
    if mode is RuntimeMode.EXECUTE:
        return GraphNodeState.READY
    if mode is RuntimeMode.VERIFY:
        return GraphNodeState.VERIFYING
    return GraphNodeState.REPLANNING

def _mode_for_state(state: GraphNodeState) -> RuntimeMode:
    if state is GraphNodeState.REPLANNING:
        return RuntimeMode.PLAN
    if state is GraphNodeState.VERIFYING:
        return RuntimeMode.VERIFY
    return RuntimeMode.EXECUTE

def _queued_mode_for_state(state: GraphNodeState) -> RuntimeMode | None:
    if state is GraphNodeState.REPLANNING:
        return RuntimeMode.PLAN
    if state is GraphNodeState.READY:
        return RuntimeMode.EXECUTE
    if state is GraphNodeState.VERIFYING:
        return RuntimeMode.VERIFY
    return None

def _node_topology_payload(node: GraphNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "title": node.title,
        "issue_id": node.issue_id,
        "issue_identifier": node.issue_identifier,
        "parent_node_id": node.parent_node_id,
        "gate_snapshot_hash": node.gate_snapshot_hash,
        "superseded_by": list(node.superseded_by),
    }

def _node_runtime_payload(node: GraphNode) -> dict[str, Any]:
    return {
        "state": node.state.value,
        "verify_score": node.verify_score,
        "rework_count": node.rework_count,
        "replan_depth": node.replan_depth,
        "human_reason": node.human_reason.value if node.human_reason is not None else None,
    }

def _node_from_topology_and_runtime(topology_payload: dict[str, Any], runtime_payload: dict[str, Any] | None) -> GraphNode:
    merged = dict(topology_payload)
    runtime = runtime_payload or {}
    merged["state"] = runtime.get("state") or topology_payload.get("state") or GraphNodeState.PLANNED.value
    merged["verify_score"] = runtime.get("verify_score", topology_payload.get("verify_score"))
    merged["rework_count"] = runtime.get("rework_count", topology_payload.get("rework_count", 0))
    merged["replan_depth"] = runtime.get("replan_depth", topology_payload.get("replan_depth", 0))
    merged["human_reason"] = runtime.get("human_reason", topology_payload.get("human_reason"))
    return GraphNode.from_dict(merged)

def _node_next_action(node: GraphNode) -> str:
    if node.state is GraphNodeState.PLANNED:
        return "wait_for_dependencies_or_promote"
    if node.state is GraphNodeState.READY:
        return "dispatch_execute"
    if node.state is GraphNodeState.EXECUTING:
        return "wait_for_execute_result"
    if node.state is GraphNodeState.VERIFYING:
        return "dispatch_or_wait_for_verify"
    if node.state is GraphNodeState.REPLANNING:
        return "dispatch_plan_rewrite"
    if node.state is GraphNodeState.NEED_HUMAN:
        return "wait_for_human_action"
    return "terminal"
