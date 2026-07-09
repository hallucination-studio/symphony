from __future__ import annotations

import os
import re
import signal
from pathlib import Path
from typing import Any

from real_symphony_e2e_linear import (
    fetch_linear_human_action_issue,
    move_linear_issue_to_state,
    update_linear_issue_description,
)

def audit_expected_failure_run(run_result: dict[str, Any], tree: dict[str, Any], *, expected: str) -> dict[str, Any]:
    managed_run_work_items = [
        node
        for sample in run_result.get("samples", [])
        if isinstance(sample, dict)
        for node in sample.get("managed_run_work_items", [])
        if isinstance(node, dict)
    ]
    max_overload_count = max([_int_value(node.get("overload_count")) for node in managed_run_work_items] or [0])
    max_retry_count = max([_int_value(node.get("retry_count")) for node in managed_run_work_items] or [0])
    max_crash_count = max([_int_value(node.get("crash_count")) for node in managed_run_work_items] or [0])
    reasons = [str(node.get("last_reason") or "") for node in managed_run_work_items]
    failed_terminal = any(node.get("state") == "failed" for node in managed_run_work_items)
    human_actions = _human_action_children(tree)
    descriptions = "\n\n".join(str(child.get("description") or "") for child in human_actions)
    if max_overload_count == 0:
        max_overload_count = _max_counter_from_text(descriptions, "overload_count")
    if max_retry_count == 0:
        max_retry_count = _max_counter_from_text(descriptions, "retry_count")
    if max_crash_count == 0:
        max_crash_count = _max_counter_from_text(descriptions, "crash_count")
    http_status_in_linear = "Upstream HTTP status:" in descriptions
    raw_error_in_linear = "Last error:" in descriptions and (
        "JSON-RPC error" in descriptions or "server overloaded" in descriptions or "invalid request" in descriptions
    )
    terminal_bad_request = any("codex_bad_request" in reason for reason in reasons) or "invalid request" in descriptions.lower()
    overload_exhausted = any("upstream_overloaded_exhausted" in reason for reason in reasons) or max_overload_count > 0
    if expected == "overload":
        passed = (
            failed_terminal
            and overload_exhausted
            and max_overload_count > 0
            and max_retry_count == 0
            and max_crash_count == 0
            and raw_error_in_linear
            and http_status_in_linear
        )
    elif expected == "terminal_bad_request":
        passed = failed_terminal and terminal_bad_request and max_overload_count == 0 and raw_error_in_linear and http_status_in_linear
    else:
        raise ValueError(f"Unsupported expected failure: {expected}")
    return {
        "pass": passed,
        "expected": expected,
        "failed_terminal": failed_terminal,
        "max_overload_count": max_overload_count,
        "max_retry_count": max_retry_count,
        "max_crash_count": max_crash_count,
        "last_reasons": reasons[-10:],
        "human_action_count": len(human_actions),
        "raw_error_in_linear": raw_error_in_linear,
        "http_status_in_linear": http_status_in_linear,
        "terminal_bad_request": terminal_bad_request,
        "overload_exhausted": overload_exhausted,
    }


def _human_action_children(tree: dict[str, Any]) -> list[dict[str, Any]]:
    children = ((tree.get("children") or {}).get("nodes") or []) if isinstance(tree.get("children"), dict) else []
    result: list[dict[str, Any]] = []
    for child in children:
        if not isinstance(child, dict):
            continue
        labels = ((child.get("labels") or {}).get("nodes") or []) if isinstance(child.get("labels"), dict) else []
        if str(child.get("title") or "").startswith("[Human Action]") or any(
            isinstance(label, dict) and label.get("name") == "performer:type/human-action" for label in labels
        ):
            result.append(child)
    return result


def _int_value(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _max_counter_from_text(text: str, key: str) -> int:
    values = [int(match.group(1)) for match in re.finditer(rf"{re.escape(key)}:\s*(\d+)", text)]
    return max(values or [0])


def crash_probe_candidate(pipeline_attempts: list[dict[str, Any]], leases: list[dict[str, Any]]) -> dict[str, Any] | None:
    active_attempt_ids = {str(lease.get("attempt_id") or "") for lease in leases if isinstance(lease, dict)}
    for attempt in pipeline_attempts:
        if str(attempt.get("attempt_id") or "") not in active_attempt_ids:
            continue
        if attempt.get("mode") != "execute":
            continue
        if attempt.get("state") != "running":
            continue
        pid = attempt.get("process_pid")
        if isinstance(pid, int) and pid > 0:
            return attempt
    return None


def kill_performer_for_crash_probe(pid: int) -> tuple[bool, str | None]:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return False, "process_not_found"
    except PermissionError:
        return False, "permission_denied"
    except OSError as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return True, None


def human_action_description_with_response(description: str, response: str) -> str:
    marker = "Human response:"
    response = response.strip()
    if marker.lower() not in description.lower():
        return f"{description.rstrip()}\n\n{marker}\n{response}\n"
    lower = description.lower()
    start = lower.find(marker.lower()) + len(marker)
    stop = len(description)
    for candidate in ["When finished,", "完成后", "Move this child issue"]:
        index = lower.find(candidate.lower(), start)
        if index >= 0:
            stop = min(stop, index)
    prefix = description[:start].rstrip()
    suffix = description[stop:].lstrip("\n")
    if suffix:
        return f"{prefix}\n{response}\n\n{suffix}"
    return f"{prefix}\n{response}\n"


def parent_comment_negative_control_body(wait_id: str) -> str:
    normalized_wait_id = str(wait_id or "unknown").strip() or "unknown"
    return (
        "Symphony E2E negative control for human-action routing.\n\n"
        f"wait_id={normalized_wait_id}\n"
        "No action is required. This is not a Symphony human-action resume command; "
        "the waiting managed-run work item must remain blocked until its [Human Action] child issue is completed."
    )


def e2e_human_action_resume_response(action: dict[str, Any]) -> str:
    wait_id = str(action.get("wait_id") or "unknown").strip() or "unknown"
    child_identifier = str(action.get("child_identifier") or action.get("child_issue_id") or "unknown").strip() or "unknown"
    reason = str(action.get("reason") or "unknown").strip() or "unknown"
    return (
        f"Symphony E2E resume approval for human wait {wait_id} on child {child_identifier}.\n"
        f"This is the explicit human-action resume signal; reason={reason}; retry the managed run."
    )


def should_complete_conductor_human_action(action: dict[str, Any], completed_wait_ids: set[str]) -> bool:
    wait_id = str(action.get("wait_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    return bool(wait_id and child_issue_id and wait_id not in completed_wait_ids)


def done_state_id_for_human_action(issue: dict[str, Any]) -> str | None:
    team = issue.get("team") if isinstance(issue.get("team"), dict) else {}
    states = ((team.get("states") or {}).get("nodes") or []) if isinstance(team, dict) else []
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("type") or "") == "completed" and state.get("id"):
            return str(state["id"])
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("name") or "").strip().lower() == "done" and state.get("id"):
            return str(state["id"])
    return None


async def complete_conductor_human_action(
    token: str,
    action: dict[str, Any],
    *,
    response: str,
) -> dict[str, Any]:
    child_issue_id = str(action.get("child_issue_id") or "").strip()
    if not child_issue_id:
        return {"status": "skipped", "reason": "missing_child_issue_id", "action": action}
    issue = await fetch_linear_human_action_issue(token, child_issue_id)
    state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
    if str(state.get("type") or "") == "completed" or str(state.get("name") or "").strip().lower() == "done":
        return {"status": "already_done", "child_issue_id": child_issue_id, "child_identifier": issue.get("identifier")}
    description = human_action_description_with_response(str(issue.get("description") or ""), response)
    updated = await update_linear_issue_description(token, child_issue_id, description)
    done_state_id = done_state_id_for_human_action(issue)
    if not done_state_id:
        return {
            "status": "failed",
            "reason": "done_state_not_found",
            "child_issue_id": child_issue_id,
            "description_updated": bool(updated.get("success")),
        }
    moved = await move_linear_issue_to_state(token, child_issue_id, done_state_id)
    moved_issue = moved.get("issue") if isinstance(moved, dict) and isinstance(moved.get("issue"), dict) else {}
    return {
        "status": "completed" if moved.get("success") else "failed",
        "child_issue_id": child_issue_id,
        "child_identifier": moved_issue.get("identifier") or issue.get("identifier"),
        "description_updated": bool(updated.get("success")),
        "state": moved_issue.get("state"),
    }


def build_instance_payload(
    *,
    run_id: str,
    fixture: Path,
    project_slug: str,
    agent_app_user_id: str,
    pipeline_gates: bool,
) -> dict[str, Any]:
    return {
        "name": f"Matrix {run_id}",
        "repo_source_type": "local_path",
        "repo_source_value": str(fixture),
        "linear_project": project_slug,
        "linear_filters": {"linear_agent_app_user_id": agent_app_user_id},
        "managed_run_profile": "gated-task" if pipeline_gates else "default",
    }
