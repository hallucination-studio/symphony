from __future__ import annotations

from .conductor_pipeline_helper_common import *
from .conductor_pipeline_helper_repo import _sanitize_error
from .conductor_pipeline_helper_json_time import _parse_time


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
