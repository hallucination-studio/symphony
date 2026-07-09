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



_UNCHANGED = object()
_DISPATCHABLE_STATES = {
    GraphNodeState.READY,
    GraphNodeState.REPLANNING,
    GraphNodeState.VERIFYING,
}

_PREDICTABLE_DISPATCH_STATES = {
    GraphNodeState.PLANNED,
    *_DISPATCHABLE_STATES,
}


def _node_verify_passed(node: GraphNode) -> bool:
    return node.state is GraphNodeState.VERIFY_PASSED and int(node.verify_score or 0) >= PASS_THRESHOLD


def _plan_validation_human_reason(errors: set[PlanValidatorError]) -> HumanEscalationReason:
    if PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE in errors:
        return HumanEscalationReason.CREDENTIAL_REQUIRED
    if PlanValidatorError.GATE_UNEXECUTABLE in errors:
        return HumanEscalationReason.GATE_UNEXECUTABLE
    return HumanEscalationReason.PLAN_INVALID


def _plan_failure_human_reason(error: str) -> HumanEscalationReason:
    if error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in error.lower():
        return HumanEscalationReason.THREAD_LOST
    if not error.startswith("invalid_plan_proposal"):
        return HumanEscalationReason.BACKEND_UNAVAILABLE
    return _plan_validation_human_reason(_plan_validator_errors_from_error(error))


def _plan_validator_errors_from_error(error: str) -> set[PlanValidatorError]:
    if ":" not in error:
        return set()
    errors: set[PlanValidatorError] = set()
    for token in error.split(":", 1)[1].replace(",", " ").split():
        try:
            errors.add(PlanValidatorError(token.strip()))
        except ValueError:
            continue
    return errors


def _plan_validation_error_summary(errors: set[PlanValidatorError]) -> str:
    names = ", ".join(sorted(error.value for error in errors))
    return f"invalid plan proposal: {names}"


def _attempt_comment_block(attempt: dict[str, Any]) -> str:
    mode = str(attempt.get("mode") or "").strip()
    state = str(attempt.get("state") or "").strip()
    duration = _format_duration(attempt.get("started_at"), attempt.get("completed_at"))
    kind = _comment_scalar(attempt.get("kind"))
    thread_id = _comment_scalar(attempt.get("thread_id"))
    completed_at = _comment_scalar(attempt.get("completed_at"))
    lines = [
        f"{_attempt_mode_icon(mode)} {_attempt_mode_label(mode)} Attempt",
        f"{_attempt_state_icon(state)} Status: {_comment_scalar(state)}",
    ]
    if duration:
        lines.append(f"⏱️  Duration: {duration}")
    if kind:
        lines.append(f"🧩 Kind: {kind}")
    if thread_id:
        lines.append(f"🔗 Thread: {thread_id}")
    if completed_at:
        lines.append(f"⏱️  Completed: {completed_at}")
    lines.append(f"ID: {_comment_scalar(attempt.get('attempt_id'))}")
    error = str(attempt.get("error") or "").strip()
    if error:
        lines.append(f"⚠️ Error: {_comment_scalar(_sanitize_error(error))}")
    return "\n".join(lines)


def _attempt_mode_icon(mode: str) -> str:
    return {
        RuntimeMode.PLAN.value: "🔵",
        RuntimeMode.EXECUTE.value: "🟣",
        RuntimeMode.VERIFY.value: "🟢",
    }.get(mode, "⚪")


def _attempt_mode_label(mode: str) -> str:
    return {
        RuntimeMode.PLAN.value: "Plan",
        RuntimeMode.EXECUTE.value: "Execute",
        RuntimeMode.VERIFY.value: "Verify",
    }.get(mode, mode.title() if mode else "Unknown")


def _attempt_state_icon(state: str) -> str:
    return {
        AttemptState.SUCCEEDED.value: "✅",
        AttemptState.FAILED.value: "❌",
        AttemptState.RUNNING.value: "🔄",
        AttemptState.TIMED_OUT.value: "⏱️",
        AttemptState.PENDING.value: "⏳",
    }.get(state, "⚪")


def _format_duration(started_at_str: Any, completed_at_str: Any) -> str:
    started_at = _parse_time(started_at_str)
    completed_at = _parse_time(completed_at_str)
    if started_at is None or completed_at is None:
        return ""
    total_seconds = int((completed_at - started_at).total_seconds())
    if total_seconds < 0:
        return ""
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def _comment_scalar(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ")[:500]


def _need_human_instruction_block(node: GraphNode, wait: dict[str, Any]) -> str:
    reason = str(wait.get("reason") or (node.human_reason.value if node.human_reason is not None else "NEED_HUMAN"))
    details = wait.get("details") if isinstance(wait.get("details"), dict) else {}
    lines = [
        "Symphony needs human input on this node.",
        "",
        "```yaml",
        "symphony_need_human:",
        f"  node_id: {_comment_scalar(node.node_id)}",
        f"  reason: {_comment_scalar(reason)}",
        f"  wait_id: {_comment_scalar(wait.get('wait_id'))}",
        f"  mode: {_comment_scalar(details.get('mode'))}",
        f"  attempt_id: {_comment_scalar(details.get('attempt_id'))}",
        "```",
        "",
        "Add the missing information as a comment on this issue.",
        "Move this issue out of the need_human state to resume.",
        "Commenting alone will not resume Symphony.",
    ]
    error = str(details.get("error") or "").strip()
    if error:
        lines.extend(["", f"Sanitized reason: {_sanitize_error(error)}"])
    blocked_by = [str(item) for item in details.get("blocked_by") or [] if str(item).strip()]
    if blocked_by:
        lines.extend(["", "Blocked by:"])
        lines.extend(f"- {_sanitize_error(item)}" for item in blocked_by)
    return "\n".join(lines)


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
def _repository_integration_path(repository_path: Path | str) -> str:
    return str(Path(repository_path).resolve(strict=False))


def _safe_path_part(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return safe or "integration"


def _git(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.STDOUT)


def _rollback_repository(repository_path: Path, revision: str) -> None:
    try:
        _git(["reset", "--hard", revision], cwd=repository_path)
        _git(["clean", "-fd"], cwd=repository_path)
    except Exception:
        return


def _repository_head_revision(repository_path: str) -> str:
    path = Path(repository_path) if repository_path else None
    if path is None or not path.exists():
        return ""
    try:
        return _git(["rev-parse", "HEAD"], cwd=path).strip()
    except Exception:
        return ""


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]


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


def _jsonable(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value))
    except TypeError:
        return str(value)


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _json_loads(payload: str) -> dict[str, Any]:
    value = json.loads(payload)
    return value if isinstance(value, dict) else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_time(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _utc(parsed)


def _recently_observed_process_exit(instance: Any, *, at: datetime) -> bool:
    observed_at = _parse_time(getattr(instance, "updated_at", None))
    if observed_at is None:
        return False
    return (_utc(at) - observed_at).total_seconds() < _PROCESS_EXIT_RESULT_GRACE_SECONDS
