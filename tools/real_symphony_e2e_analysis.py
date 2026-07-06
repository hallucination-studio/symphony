from __future__ import annotations

import json
import os
import re
import signal
import uuid
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence, read_json_object_if_ready
from real_symphony_e2e_linear import (
    comment_linear_issue,
    fetch_linear_human_action_issue,
    move_linear_issue_to_state,
    update_linear_issue_description,
)

def write_wait_artifacts(
    *,
    evidence: Evidence,
    samples: list[dict[str, Any]],
    result_path: Path,
    final_issue: dict[str, Any],
    state_path: Path,
    last_state: dict[str, Any],
    ops_path: Path,
    last_ops: dict[str, Any],
    log_path: Path,
    stages: dict[str, str],
    stage_timeout_seconds: int,
) -> dict[str, Any]:
    samples_path = evidence.out.parent / "runtime-samples.json"
    samples_path.write_text(json.dumps(samples, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("runtime_samples", samples_path)
    if result_path.exists():
        result_copy = evidence.out.parent / "workspace-result.txt"
        result_copy.write_text(result_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        evidence.artifact("workspace_result", result_copy)
    final_issue_path = evidence.out.parent / "final-issue.json"
    final_issue_path.write_text(json.dumps(final_issue, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("final_issue", final_issue_path)
    stage_snapshot = {
        "observed": stages,
        "stage_timeout_seconds": stage_timeout_seconds,
        "last_sample": samples[-1] if samples else None,
    }
    stage_snapshot_path = evidence.out.parent / "stage-snapshot.json"
    stage_snapshot_path.write_text(json.dumps(stage_snapshot, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("stage_snapshot", stage_snapshot_path)
    return {
        "state": read_json_object_if_ready(state_path, last_state),
        "ops": read_json_object_if_ready(ops_path, last_ops),
        "issue": final_issue,
        "result_path": str(result_path),
        "log_path": str(log_path),
        "samples": samples,
    }


def conductor_human_actions(runs_payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs = runs_payload.get("runs")
    if not isinstance(runs, list):
        return []
    actions: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict) or run.get("phase") != "awaiting_human":
            continue
        human_action = run.get("human_action")
        if not isinstance(human_action, dict):
            human_action = {}
        actions.append(
            {
                "run_id": str(run.get("run_id") or ""),
                "issue_id": str(run.get("issue_id") or ""),
                "issue_identifier": str(run.get("issue_identifier") or "") or None,
                "phase": str(run.get("phase") or ""),
                "status": str(run.get("status") or ""),
                "last_reason": str(run.get("last_reason") or "") or None,
                "child_issue_id": str(human_action.get("child_issue_id") or "") or None,
                "child_identifier": str(human_action.get("child_identifier") or "") or None,
                "child_url": str(human_action.get("child_url") or "") or None,
                "kind": str(human_action.get("kind") or "") or None,
            }
        )
    return actions


def conductor_phase_runs(runs_payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs = runs_payload.get("runs")
    if not isinstance(runs, list):
        return []
    return [run for run in runs if isinstance(run, dict) and run.get("run_id") and run.get("phase")]


def audit_expected_failure_run(run_result: dict[str, Any], tree: dict[str, Any], *, expected: str) -> dict[str, Any]:
    phase_runs = [
        run
        for sample in run_result.get("samples", [])
        if isinstance(sample, dict)
        for run in sample.get("phase_runs", [])
        if isinstance(run, dict)
    ]
    max_overload_count = max([_int_value(run.get("overload_count")) for run in phase_runs] or [0])
    max_retry_count = max([_int_value(run.get("retry_count")) for run in phase_runs] or [0])
    max_crash_count = max([_int_value(run.get("crash_count")) for run in phase_runs] or [0])
    reasons = [str(run.get("last_reason") or "") for run in phase_runs]
    failed_terminal = any(run.get("phase") == "failed" or run.get("status") == "failed" for run in phase_runs)
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


def crash_probe_candidate(phase_runs: list[dict[str, Any]]) -> dict[str, Any] | None:
    for run in phase_runs:
        if run.get("phase") != "implementing" or run.get("status") != "running":
            continue
        pid = run.get("process_pid")
        if isinstance(pid, int) and pid > 0:
            return run
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


def should_complete_conductor_human_action(action: dict[str, Any], completed_run_ids: set[str]) -> bool:
    run_id = str(action.get("run_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    return bool(run_id and child_issue_id and run_id not in completed_run_ids)


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


def linear_webhook_signature(secret: str, payload: bytes) -> str:
    import hashlib
    import hmac

    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def build_instance_payload(
    *,
    run_id: str,
    fixture: Path,
    project_slug: str,
    agent_app_user_id: str,
    acceptance_gates: bool,
    simulate_agent_webhook: bool,
) -> dict[str, Any]:
    linear_filters: dict[str, Any] = {"active_states": ["Todo", "In Progress"]}
    if not simulate_agent_webhook:
        linear_filters["linear_agent_app_user_id"] = agent_app_user_id
    return {
        "name": f"Matrix {run_id}",
        "repo_source_type": "local_path",
        "repo_source_value": str(fixture),
        "linear_project": project_slug,
        "linear_filters": linear_filters,
        "workflow_profile": "gated-task" if acceptance_gates else "task",
        "workflow_inputs": {"goal": "Run the real Symphony e2e matrix task."},
    }


def build_agent_session_webhook_payload(
    *,
    linear: dict[str, Any],
    workspace_id: str,
    agent_app_user_id: str,
    simulate_agent_webhook: bool,
) -> dict[str, Any]:
    issue = linear["issue"]
    linear_agent_sessions = ((issue.get("agentSessions") or {}).get("nodes") or [])
    linear_agent_session = linear_agent_sessions[0] if linear_agent_sessions else {}
    delegate = issue.get("delegate")
    if simulate_agent_webhook:
        delegate = {"id": agent_app_user_id}
    return {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": workspace_id},
        "agentSession": {
            "id": linear_agent_session.get("id") or f"session-{uuid.uuid4().hex}",
            "appUserId": agent_app_user_id,
            "appUser": {"id": agent_app_user_id},
            "issue": {
                "id": issue["id"],
                "identifier": issue["identifier"],
                "project": {"slugId": linear["project"]["slugId"]},
                "assignee": issue.get("assignee"),
                "delegate": delegate,
            },
        },
    }
