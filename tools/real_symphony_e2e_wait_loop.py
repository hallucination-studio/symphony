from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import (
    complete_conductor_human_action,
    conductor_human_actions,
    conductor_pipeline_nodes,
    crash_probe_candidate,
    e2e_human_action_resume_response,
    kill_performer_for_crash_probe,
    parent_comment_negative_control_body,
    pipeline_nodes_terminal,
    should_complete_conductor_human_action,
    write_wait_artifacts,
)
from real_symphony_e2e_common import Evidence, api_url, http_json, utc_now
from real_symphony_e2e_linear import comment_linear_issue, fetch_linear_issue
from real_symphony_e2e_wait_helpers import (
    _human_answered_push_satisfies_resume_probe,
    _immediate_failure_matches_attempt,
    _immediate_failure_without_attempt,
    _pipeline_integrated,
    _pipeline_integrated_result_path,
    _pipeline_wait_by_id,
    _resolved_pipeline_wait_ids,
    _wait_resolved_before_harness_resume,
    immediate_pipeline_failure,
)


@dataclass
class WaitState:
    token: str
    issue_id: str
    instance: dict[str, Any]
    conductor_port: int
    evidence: Evidence
    timeout_seconds: int
    stage_timeout_seconds: int
    permission_approval_probe: bool
    crash_recovery_probe: bool
    crash_after_policy_revision: int | None
    continue_after_human_resume: bool
    expected_failure: str
    instance_root: Path = field(init=False)
    state_path: Path = field(init=False)
    ops_path: Path = field(init=False)
    result_path: Path = field(init=False)
    fallback_result_path: Path = field(init=False)
    log_path: Path = field(init=False)
    instance_id: str = field(init=False)
    samples: list[dict[str, Any]] = field(default_factory=list)
    stages: dict[str, str] = field(default_factory=dict)
    final_issue: dict[str, Any] | None = None
    completed_actions: set[str] = field(default_factory=set)
    completed_waits: set[str] = field(default_factory=set)
    parent_comment_probe_waits: set[str] = field(default_factory=set)
    crash_attempt_id: str | None = None
    crash_lease_id: str | None = None
    crash_pid: int | None = None
    crash_killed: bool = False
    crash_lease_reclaimed: bool = False

    def __post_init__(self) -> None:
        self.instance_root = Path(self.instance["instance_dir"])
        self.state_path = Path(self.instance["persistence_path"])
        self.ops_path = self.state_path.parent / "ops.json"
        self.fallback_result_path = Path(self.instance["workspace_root"]) / "SYMPHONY_REAL_E2E_RESULT.md"
        self.result_path = self.fallback_result_path
        self.log_path = Path(self.instance["log_path"])
        self.instance_id = str(self.instance["id"])


async def wait_for_run(**kwargs: Any) -> dict[str, Any]:
    state = WaitState(**kwargs)
    deadline = time.monotonic() + state.timeout_seconds
    while time.monotonic() < deadline:
        sample = await _sample_runtime(state)
        if sample is None:
            await asyncio.sleep(5)
            continue
        result = await _handle_sample(state, sample)
        if isinstance(result, dict):
            return result
        if result == "break":
            break
        await asyncio.sleep(2 if state.crash_recovery_probe and not state.crash_lease_reclaimed else 5)
    state.final_issue = state.final_issue or await fetch_linear_issue(state.token, state.issue_id)
    _record_crash_coverage(state)
    return _write_artifacts(state)


async def _sample_runtime(state: WaitState) -> dict[str, Any] | None:
    if not state.log_path.exists():
        generated = sorted((state.instance_root / "logs").glob("performer-*.log"))
        if generated:
            state.log_path = generated[-1]
    try:
        state.final_issue = await fetch_linear_issue(state.token, state.issue_id)
    except RuntimeError as exc:
        state.samples.append({"at": utc_now(), "issue_state": "unknown", "process_status": "unknown", "linear_fetch_error": str(exc)})
        return None
    process_status, pipeline_payload = _runtime_and_pipeline_payload(state)
    pipeline_nodes = conductor_pipeline_nodes(pipeline_payload)
    pipeline_attempts = [attempt for attempt in pipeline_payload.get("attempts", []) if isinstance(attempt, dict)]
    pipeline_leases = [lease for lease in pipeline_payload.get("leases", []) if isinstance(lease, dict)]
    pipeline_human_actions = conductor_human_actions(pipeline_payload)
    state.result_path = _pipeline_integrated_result_path(pipeline_payload) or state.fallback_result_path
    sample = _build_sample(state, process_status, pipeline_nodes, pipeline_attempts, pipeline_leases, pipeline_human_actions)
    sample["pipeline_payload"] = pipeline_payload
    state.samples.append(sample)
    _print_progress(sample, process_status, pipeline_nodes, pipeline_attempts, pipeline_leases, pipeline_human_actions)
    return sample


def _runtime_and_pipeline_payload(state: WaitState) -> tuple[str | None, dict[str, Any]]:
    status, runtime_body = http_json("GET", api_url(state.conductor_port, f"/api/instances/{state.instance_id}"), timeout=2)
    process_status = (runtime_body.get("instance") or {}).get("process_status") if status == 200 and isinstance(runtime_body, dict) else None
    pipeline_status, pipeline_body = http_json("GET", api_url(state.conductor_port, "/api/pipeline"), timeout=2)
    pipeline_payload = pipeline_body.get("pipeline") if pipeline_status == 200 and isinstance(pipeline_body, dict) and isinstance(pipeline_body.get("pipeline"), dict) else {}
    return process_status, pipeline_payload


def _build_sample(
    state: WaitState,
    process_status: str | None,
    nodes: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    leases: list[dict[str, Any]],
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "at": utc_now(),
        "issue_state": state.final_issue["state"]["name"] if state.final_issue else "unknown",
        "process_status": process_status,
        "result_exists": state.result_path.exists(),
        "pipeline_nodes": nodes,
        "pipeline_attempts": attempts,
        "pipeline_leases": leases,
        "pipeline_human_actions": actions,
        "conductor_pipeline_event_types": [],
    }


def _print_progress(
    sample: dict[str, Any],
    process_status: str | None,
    nodes: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    leases: list[dict[str, Any]],
    actions: list[dict[str, Any]],
) -> None:
    payload = {
        "event": "e2e_progress",
        "at": sample["at"],
        "issue_state": sample["issue_state"],
        "process_status": process_status,
        "result_exists": sample["result_exists"],
        "nodes": [{"node_id": node.get("node_id"), "state": node.get("state")} for node in nodes],
        "attempts": [{"attempt_id": attempt.get("attempt_id"), "mode": attempt.get("mode"), "state": attempt.get("state")} for attempt in attempts[-5:]],
        "active_leases": len(leases),
        "human_waits": [{"wait_id": action.get("wait_id"), "node_id": action.get("node_id"), "reason": action.get("reason"), "status": action.get("status")} for action in actions],
    }
    print(json.dumps(payload, sort_keys=True), flush=True)


async def _handle_sample(state: WaitState, sample: dict[str, Any]) -> str | dict[str, Any] | None:
    pipeline_payload = sample.pop("pipeline_payload")
    failure_result = _handle_immediate_failure(state, sample)
    if failure_result is not None:
        return failure_result
    await _handle_crash_probe(state, pipeline_payload, sample)
    _mark_progress_stages(state, sample, pipeline_payload)
    if _resume_observed_after_push(state, pipeline_payload) and not state.continue_after_human_resume:
        return "break"
    if sample["pipeline_human_actions"]:
        return await _handle_human_actions(state, sample)
    return _completion_decision(state, sample, pipeline_payload)


def _handle_immediate_failure(state: WaitState, sample: dict[str, Any]) -> dict[str, Any] | None:
    failure = immediate_pipeline_failure(sample, expected_failure=state.expected_failure, permission_approval_probe=state.permission_approval_probe)
    if failure is None:
        return None
    if state.crash_recovery_probe and state.crash_killed and _immediate_failure_matches_attempt(failure, state.crash_attempt_id):
        state.evidence.check("crash-recovery:failure-visible", True, attempt_id=state.crash_attempt_id, failure=failure)
        failure = _immediate_failure_without_attempt(failure, state.crash_attempt_id)
    if failure is None:
        return None
    state.evidence.check("pipeline-runtime-error:visible", False, failure=failure, process_status=sample.get("process_status"))
    return _write_artifacts(state)


async def _handle_crash_probe(state: WaitState, pipeline_payload: dict[str, Any], sample: dict[str, Any]) -> None:
    policy_ready = state.crash_after_policy_revision is None or int(pipeline_payload.get("policy_revision") or 0) >= state.crash_after_policy_revision
    if state.crash_recovery_probe and policy_ready and not state.crash_killed:
        await _kill_crash_probe_candidate(state, sample)
        return
    if state.crash_recovery_probe and state.crash_killed and state.crash_attempt_id:
        _record_crash_lease_reclaimed(state, sample)


async def _kill_crash_probe_candidate(state: WaitState, sample: dict[str, Any]) -> None:
    candidate = crash_probe_candidate(sample["pipeline_attempts"], sample["pipeline_leases"])
    if candidate is None:
        return
    pid = int(candidate["process_pid"])
    killed, error = kill_performer_for_crash_probe(pid)
    state.crash_attempt_id = str(candidate.get("attempt_id") or "")
    state.crash_lease_id = next((str(lease.get("lease_id") or "") for lease in sample["pipeline_leases"] if str(lease.get("attempt_id") or "") == state.crash_attempt_id), None)
    state.crash_pid = pid
    state.crash_killed = killed
    state.evidence.check("crash-recovery:performer-killed", killed, pid=pid, attempt_id=state.crash_attempt_id, mode=candidate.get("mode"), status=candidate.get("status"), lease_id=state.crash_lease_id, error=error)
    await asyncio.sleep(2)


def _record_crash_lease_reclaimed(state: WaitState, sample: dict[str, Any]) -> None:
    matching = [attempt for attempt in sample["pipeline_attempts"] if attempt.get("attempt_id") == state.crash_attempt_id]
    terminal = [attempt for attempt in matching if attempt.get("state") in {"failed", "cancelled", "timed_out"}]
    active = [lease for lease in sample["pipeline_leases"] if str(lease.get("attempt_id") or "") == state.crash_attempt_id or (state.crash_lease_id and str(lease.get("lease_id") or "") == state.crash_lease_id)]
    if terminal and not active and not state.crash_lease_reclaimed:
        state.crash_lease_reclaimed = True
        state.evidence.check("crash-recovery:lease-reclaimed", True, attempt_id=state.crash_attempt_id, lease_id=state.crash_lease_id, pid=state.crash_pid, pipeline_attempts=terminal, active_crash_leases=active)


def _mark_stage(state: WaitState, name: str, passed: bool, **details: Any) -> None:
    if passed and name not in state.stages:
        state.stages[name] = utc_now()
        state.evidence.check(f"stage:{name}", True, **details)


def _mark_progress_stages(state: WaitState, sample: dict[str, Any], pipeline_payload: dict[str, Any]) -> None:
    nodes = sample["pipeline_nodes"]
    attempts = sample["pipeline_attempts"]
    _mark_stage(state, "poller_queued", True, issue_id=state.issue_id)
    _mark_stage(state, "process_running_or_exited", sample.get("process_status") in {"running", "exited", "stopped"}, process_status=sample.get("process_status"))
    _mark_stage(state, "implementation_result_exists", state.result_path.exists(), path=str(state.result_path))
    _mark_stage(state, "pipeline_attempt_started", bool(attempts), attempts=[{"attempt_id": item.get("attempt_id"), "mode": item.get("mode"), "state": item.get("state")} for item in attempts[-5:]])
    _mark_stage(state, "pipeline_terminal", pipeline_nodes_terminal(nodes, terminal_states={"verify_passed", "failed", "superseded"}), nodes=[{"node_id": node.get("node_id"), "state": node.get("state")} for node in nodes])


def _resume_observed_after_push(state: WaitState, pipeline_payload: dict[str, Any]) -> bool:
    check_names = {check.get("name") for check in state.evidence.data.get("checks", []) if check.get("passed")}
    if state.permission_approval_probe and "human-action:managed-push-resume" in check_names:
        resumed_wait_ids = _resolved_pipeline_wait_ids(pipeline_payload)
        if state.completed_waits & resumed_wait_ids:
            state.evidence.check("human-action:resume-observed-after-push", True, wait_ids=sorted(resumed_wait_ids))
            return True
    return False


async def _handle_human_actions(state: WaitState, sample: dict[str, Any]) -> str | dict[str, Any] | None:
    state.evidence.check("human-action:conductor-pipeline-awaiting-human", True, actions=sample["pipeline_human_actions"])
    for action in sample["pipeline_human_actions"]:
        repeated = _repeated_wait_after_resume(state, action)
        if repeated is not None:
            return repeated
        if not should_complete_conductor_human_action(action, state.completed_waits):
            continue
        await _run_parent_comment_probe(state, action)
        await _complete_and_push_human_action(state, action)
    await asyncio.sleep(2)
    return None


def _repeated_wait_after_resume(state: WaitState, action: dict[str, Any]) -> dict[str, Any] | None:
    wait_id = str(action.get("wait_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    if wait_id in state.completed_waits and child_issue_id not in state.completed_actions:
        state.evidence.check("human-action:repeat-awaiting-human-after-resume", not state.permission_approval_probe, action=action, reason="same Conductor run requested another human action after automatic resume")
        return _write_artifacts(state) if state.permission_approval_probe else None
    return None


async def _run_parent_comment_probe(state: WaitState, action: dict[str, Any]) -> None:
    wait_id = str(action.get("wait_id") or "")
    if wait_id in state.parent_comment_probe_waits:
        return
    state.parent_comment_probe_waits.add(wait_id)
    comment = await comment_linear_issue(state.token, state.issue_id, parent_comment_negative_control_body(wait_id))
    await asyncio.sleep(2)
    status, body = http_json("GET", api_url(state.conductor_port, "/api/pipeline"), timeout=5)
    pipeline = body.get("pipeline") if status == 200 and isinstance(body, dict) and isinstance(body.get("pipeline"), dict) else {}
    probe_wait = _pipeline_wait_by_id(pipeline, wait_id)
    if _wait_resolved_before_harness_resume(probe_wait):
        state.completed_waits.add(wait_id)
        state.evidence.check("human-action:stale-wait-already-resolved", True, status=status, wait=probe_wait, comment_created=bool(comment.get("success")))
        return
    state.evidence.check("human-action:parent-comment-does-not-resume", bool(comment.get("success")) and status == 200 and probe_wait.get("status") == "waiting", status=status, wait=probe_wait, comment_created=bool(comment.get("success")))


async def _complete_and_push_human_action(state: WaitState, action: dict[str, Any]) -> None:
    wait_id = str(action.get("wait_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    response = e2e_human_action_resume_response(action)
    try:
        completion = await complete_conductor_human_action(state.token, action, response=response)
    except Exception as exc:
        state.evidence.check("human-action:linear-child-complete", False, child_issue_id=child_issue_id, error=str(exc))
        return
    state.completed_actions.add(child_issue_id)
    state.completed_waits.add(wait_id)
    state.evidence.check("human-action:linear-child-complete", completion.get("status") in {"completed", "already_done"}, action=action, completion=completion)
    status, pushed = http_json("POST", api_url(state.conductor_port, f"/api/pipeline/human-waits/{wait_id}/human-answered"), {"child_issue_id": child_issue_id, "human_response": response}, timeout=5)
    state.evidence.check("human-action:managed-push-resume", _human_answered_push_satisfies_resume_probe(status, pushed), status=status, body=pushed)


def _completion_decision(state: WaitState, sample: dict[str, Any], pipeline_payload: dict[str, Any]) -> str | None:
    pipeline_terminal = pipeline_nodes_terminal(sample["pipeline_nodes"], terminal_states={"verify_passed", "failed", "superseded"})
    check_names = {check.get("name") for check in state.evidence.data.get("checks", []) if check.get("passed")}
    if state.expected_failure != "none" and pipeline_terminal and any(node.get("state") == "failed" for node in sample["pipeline_nodes"]):
        state.evidence.check(f"expected-failure:{state.expected_failure}:terminal-child-created", True, pipeline_nodes=sample["pipeline_nodes"])
        return "break"
    if state.permission_approval_probe and state.result_path.exists() and not sample["pipeline_leases"] and {"human-action:managed-push-resume", "human-action:resume-observed-after-push"}.issubset(check_names):
        return None if state.continue_after_human_resume else "break"
    if state.result_path.exists() and pipeline_terminal and _pipeline_integrated(pipeline_payload) and not sample["pipeline_leases"] and sample.get("process_status") in {"exited", "stopped"}:
        return "break"
    return None


def _record_crash_coverage(state: WaitState) -> None:
    if not state.crash_recovery_probe:
        return
    check_names = {check.get("name") for check in state.evidence.data.get("checks", []) if check.get("passed")}
    state.evidence.check("crash-recovery:covered", {"crash-recovery:performer-killed", "crash-recovery:failure-visible", "crash-recovery:lease-reclaimed"}.issubset(check_names), killed=state.crash_killed, attempt_id=state.crash_attempt_id, lease_id=state.crash_lease_id, pid=state.crash_pid, passed_checks=sorted(name for name in check_names if str(name).startswith("crash-recovery:")))


def _write_artifacts(state: WaitState) -> dict[str, Any]:
    return write_wait_artifacts(
        evidence=state.evidence,
        samples=state.samples,
        result_path=state.result_path,
        final_issue=state.final_issue or {},
        state_path=state.state_path,
        last_state={},
        ops_path=state.ops_path,
        last_ops={},
        log_path=state.log_path,
        stages=state.stages,
        stage_timeout_seconds=state.stage_timeout_seconds,
    )
