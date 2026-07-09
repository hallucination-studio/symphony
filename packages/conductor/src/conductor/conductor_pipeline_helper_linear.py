from __future__ import annotations

from .conductor_pipeline_helper_common import *


def _debug_projection_enabled() -> bool:
    return str(os.environ.get("SYMPHONY_DEBUG_PROJECTION") or "").strip().lower() in {"1", "true", "yes", "on"}

def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except (TypeError, ValueError):
        return False
    return True

def _linear_workflow_state_target_for_node(
    node: GraphNode, *, graph_complete: bool = False
) -> tuple[list[str], str]:
    """Return (candidate state names, Linear workflow-state type) for a node.

    Names are matched case-insensitively against the team's states first; if none
    match, the state ``type`` is used as a team-agnostic fallback.
    """
    if graph_complete:
        return (["Done", "Completed", "Merged", "Shipped"], "completed")
    if node.state in {GraphNodeState.PLANNED, GraphNodeState.READY}:
        return (["Todo", "Unstarted", "Backlog"], "unstarted")
    if node.state is GraphNodeState.NEED_HUMAN:
        return (["Blocked", "Needs Human", "Need Human"], "")
    if node.state in {
        GraphNodeState.EXECUTING,
        GraphNodeState.VERIFYING,
        GraphNodeState.REPLANNING,
    }:
        return (["In Progress", "Started", "Doing"], "started")
    if node.state is GraphNodeState.VERIFY_PASSED:
        return (["In Review", "Review"], "started")
    if node.state in {GraphNodeState.FAILED, GraphNodeState.SUPERSEDED}:
        return (["Canceled", "Cancelled"], "canceled")
    return (["Todo", "Unstarted", "Backlog"], "unstarted")

def _linear_activity_content(
    node: GraphNode, metadata: dict[str, Any], *, graph_complete: bool = False
) -> dict[str, str]:
    """Build a Linear agent-activity ``content`` object.

    Lifecycle-safe: only ``response`` completes the session and only ``error``
    marks it errored, so intermediate progress is a ``thought`` and awaiting-human
    is an ``elicitation``. See linear.app/developers/agent-interaction.
    """
    status = str(metadata.get("operator_status") or node.state.value)
    if graph_complete:
        return {"type": "response", "body": f"Symphony completed all pipeline nodes for node {node.node_id}."}
    if status in {"need_human", "awaiting_human_action"}:
        reason = node.human_reason.value if node.human_reason is not None else "human action required"
        return {"type": "elicitation", "body": f"Symphony is awaiting human action on node {node.node_id}: {reason}."}
    if node.state is GraphNodeState.FAILED:
        reason = node.human_reason.value if node.human_reason is not None else "pipeline node failed"
        return {"type": "error", "body": f"Symphony failed node {node.node_id}: {reason}."}
    return {"type": "thought", "body": _linear_activity_body(node, metadata)}

def _linear_activity_body(node: GraphNode, metadata: dict[str, Any]) -> str:
    status = str(metadata.get("operator_status") or node.state.value)
    if status.startswith("running_"):
        mode = status.removeprefix("running_")
        return f"Symphony is running {mode} for node {node.node_id}."
    if status == "waiting_for_runtime_input":
        return f"Symphony is waiting for runtime input on node {node.node_id}."
    if node.state is GraphNodeState.VERIFY_PASSED:
        return f"Symphony verified node {node.node_id} with score {node.verify_score}."
    return f"Symphony projected node {node.node_id} as {status}."

def _projected_node_id_from_description(description: str) -> str | None:
    for line in description.splitlines():
        stripped = line.strip()
        if stripped.startswith("node_id:"):
            value = stripped.split(":", 1)[1].strip()
            return value or None
    return None

def _nodes_parent_first(nodes: list[GraphNode]) -> list[GraphNode]:
    by_id = {node.node_id: node for node in nodes}
    visited: set[str] = set()
    ordered: list[GraphNode] = []

    def visit(node: GraphNode) -> None:
        if node.node_id in visited:
            return
        parent_id = str(node.parent_node_id or "")
        parent = by_id.get(parent_id)
        if parent is not None:
            visit(parent)
        visited.add(node.node_id)
        ordered.append(node)

    for node in nodes:
        visit(node)
    return ordered

def _issue_relations(issue: dict[str, Any]) -> list[dict[str, Any]]:
    relations = issue.get("relations")
    if isinstance(relations, dict):
        nodes = relations.get("nodes")
        return [relation for relation in nodes or [] if isinstance(relation, dict)]
    if isinstance(relations, list):
        return [relation for relation in relations if isinstance(relation, dict)]
    return []

def _linear_issue_in_need_human_state(issue: dict[str, Any]) -> bool:
    state = issue.get("state")
    state_name = ""
    state_type = ""
    if isinstance(state, dict):
        state_name = str(state.get("name") or "").strip().lower()
        state_type = str(state.get("type") or "").strip().lower()
    else:
        state_name = str(state or issue.get("state_name") or "").strip().lower()
        state_type = str(issue.get("state_type") or "").strip().lower()
    if state_name in {"blocked", "needs human", "need human", "need_human"}:
        return True
    return state_type == "blocked"

def _yaml_scalar(value: Any) -> str:
    if value is None:
        return '""'
    return json.dumps(str(value))
