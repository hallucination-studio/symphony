from __future__ import annotations

import asyncio
import json
import time
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
    pipeline_integrations_terminal,
    pipeline_nodes_terminal,
    should_complete_conductor_human_action,
    write_wait_artifacts,
)
from real_symphony_e2e_common import Evidence, api_url, http_json, utc_now
from real_symphony_e2e_linear import comment_linear_issue, fetch_linear_issue


def immediate_pipeline_failure(
    sample: dict[str, Any],
    *,
    expected_failure: str = "none",
    permission_approval_probe: bool = False,
) -> dict[str, Any] | None:
    if expected_failure != "none":
        return None
    attempts = [attempt for attempt in sample.get("pipeline_attempts", []) if isinstance(attempt, dict)]
    failed_attempts = [
        attempt
        for attempt in attempts
        if str(attempt.get("state") or "").lower() in {"failed", "timed_out", "cancelled"}
    ]
    if failed_attempts:
        return {"kind": "attempt_failed", "attempts": failed_attempts}
    nodes = [node for node in sample.get("pipeline_nodes", []) if isinstance(node, dict)]
    failed_nodes = [node for node in nodes if str(node.get("state") or "").lower() == "failed"]
    if failed_nodes:
        return {"kind": "node_failed", "nodes": failed_nodes}
    waits = [action for action in sample.get("pipeline_human_actions", []) if isinstance(action, dict)]
    backend_waits = [
        action
        for action in waits
        if str(action.get("reason") or "") in {"BACKEND_UNAVAILABLE", "VERIFIER_CREDENTIAL_UNAVAILABLE"}
    ]
    if backend_waits:
        return {"kind": "backend_human_wait", "actions": backend_waits}
    runtime_waits = [
        action
        for action in waits
        if isinstance(action.get("details"), dict) and str(action["details"].get("wait_kind") or "")
    ]
    if runtime_waits and permission_approval_probe:
        return None
    if runtime_waits:
        return {"kind": "runtime_human_wait", "actions": runtime_waits}
    return None


async def wait_for_run(
    *,
    token: str,
    issue_id: str,
    instance: dict[str, Any],
    conductor_port: int,
    evidence: Evidence,
    timeout_seconds: int,
    stage_timeout_seconds: int,
    permission_approval_probe: bool = False,
    crash_recovery_probe: bool = False,
    crash_after_policy_revision: int | None = None,
    continue_after_human_resume: bool = False,
    expected_failure: str = "none",
) -> dict[str, Any]:
    instance_root = Path(instance["instance_dir"])
    state_path = Path(instance["persistence_path"])
    ops_path = state_path.parent / "ops.json"
    fallback_result_path = Path(instance["workspace_root"]) / "SYMPHONY_REAL_E2E_RESULT.md"
    result_path = fallback_result_path
    log_path = Path(instance["log_path"])
    instance_id = str(instance["id"])
    deadline = time.monotonic() + timeout_seconds
    samples: list[dict[str, Any]] = []
    final_issue: dict[str, Any] | None = None
    completed_pipeline_human_actions: set[str] = set()
    completed_pipeline_human_waits: set[str] = set()
    parent_comment_probe_waits: set[str] = set()
    crash_probe_attempt_id: str | None = None
    crash_probe_lease_id: str | None = None
    crash_probe_pid: int | None = None
    crash_probe_killed = False
    crash_probe_failure_visible = False
    crash_probe_lease_reclaimed = False
    stages: dict[str, str] = {}

    def mark_stage(name: str, passed: bool, **details: Any) -> None:
        if passed and name not in stages:
            stages[name] = utc_now()
            evidence.check(f"stage:{name}", True, **details)

    while time.monotonic() < deadline:
        if not log_path.exists():
            generated = sorted((instance_root / "logs").glob("performer-*.log"))
            if generated:
                log_path = generated[-1]
        try:
            final_issue = await fetch_linear_issue(token, issue_id)
        except RuntimeError as exc:
            samples.append(
                {
                    "at": utc_now(),
                    "issue_state": "unknown",
                    "process_status": "unknown",
                    "linear_fetch_error": str(exc),
                }
            )
            await asyncio.sleep(5)
            continue
        status, runtime_body = http_json("GET", api_url(conductor_port, f"/api/instances/{instance_id}"), timeout=2)
        process_status = None
        if status == 200 and isinstance(runtime_body, dict):
            process_status = (runtime_body.get("instance") or {}).get("process_status")
        pipeline_status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=2)
        pipeline_payload = (
            pipeline_body.get("pipeline")
            if pipeline_status == 200 and isinstance(pipeline_body, dict) and isinstance(pipeline_body.get("pipeline"), dict)
            else {}
        )
        pipeline_nodes = conductor_pipeline_nodes(pipeline_payload)
        pipeline_attempts = [
            attempt for attempt in pipeline_payload.get("attempts", []) if isinstance(attempt, dict)
        ]
        pipeline_leases = [lease for lease in pipeline_payload.get("leases", []) if isinstance(lease, dict)]
        pipeline_human_actions = conductor_human_actions(pipeline_payload)
        result_path = _pipeline_integrated_result_path(pipeline_payload) or fallback_result_path
        conductor_pipeline_event_types: list[str] = []
        pipeline_integrated = _pipeline_integrated(pipeline_payload)
        pipeline_terminal = pipeline_nodes_terminal(
            pipeline_nodes,
            terminal_states={"verify_passed", "failed", "superseded"},
        )
        sample = {
            "at": utc_now(),
            "issue_state": final_issue["state"]["name"],
            "process_status": process_status,
            "result_exists": result_path.exists(),
            "pipeline_nodes": pipeline_nodes,
            "pipeline_attempts": pipeline_attempts,
            "pipeline_leases": pipeline_leases,
            "pipeline_human_actions": pipeline_human_actions,
            "conductor_pipeline_event_types": conductor_pipeline_event_types[-20:],
        }
        samples.append(sample)
        print(
            json.dumps(
                {
                    "event": "e2e_progress",
                    "at": sample["at"],
                    "issue_state": sample["issue_state"],
                    "process_status": process_status,
                    "result_exists": result_path.exists(),
                    "nodes": [
                        {"node_id": node.get("node_id"), "state": node.get("state")}
                        for node in pipeline_nodes
                    ],
                    "attempts": [
                        {
                            "attempt_id": attempt.get("attempt_id"),
                            "mode": attempt.get("mode"),
                            "state": attempt.get("state"),
                        }
                        for attempt in pipeline_attempts[-5:]
                    ],
                    "active_leases": len(pipeline_leases),
                    "human_waits": [
                        {
                            "wait_id": action.get("wait_id"),
                            "node_id": action.get("node_id"),
                            "reason": action.get("reason"),
                            "status": action.get("status"),
                        }
                        for action in pipeline_human_actions
                    ],
                },
                sort_keys=True,
            ),
            flush=True,
        )
        immediate_failure = immediate_pipeline_failure(
            sample,
            expected_failure=expected_failure,
            permission_approval_probe=permission_approval_probe,
        )
        if immediate_failure is not None:
            crash_probe_expected_failure = (
                crash_recovery_probe
                and crash_probe_killed
                and _immediate_failure_matches_attempt(immediate_failure, crash_probe_attempt_id)
            )
            if crash_probe_expected_failure:
                crash_probe_failure_visible = True
                evidence.check(
                    "crash-recovery:failure-visible",
                    True,
                    attempt_id=crash_probe_attempt_id,
                    failure=immediate_failure,
                )
                immediate_failure = _immediate_failure_without_attempt(immediate_failure, crash_probe_attempt_id)
        if immediate_failure is not None:
            evidence.check(
                "pipeline-runtime-error:visible",
                False,
                failure=immediate_failure,
                process_status=process_status,
            )
            return write_wait_artifacts(
                evidence=evidence,
                samples=samples,
                result_path=result_path,
                final_issue=final_issue,
                state_path=state_path,
                last_state={},
                ops_path=ops_path,
                last_ops={},
                log_path=log_path,
                stages=stages,
                stage_timeout_seconds=stage_timeout_seconds,
            )
        crash_probe_policy_ready = (
            crash_after_policy_revision is None
            or int(pipeline_payload.get("policy_revision") or 0) >= crash_after_policy_revision
        )
        if crash_recovery_probe and crash_probe_policy_ready and not crash_probe_killed:
            candidate = crash_probe_candidate(pipeline_attempts, pipeline_leases)
            if candidate is not None:
                pid = int(candidate["process_pid"])
                killed, error = kill_performer_for_crash_probe(pid)
                crash_probe_attempt_id = str(candidate.get("attempt_id") or "")
                crash_probe_lease_id = next(
                    (
                        str(lease.get("lease_id") or "")
                        for lease in pipeline_leases
                        if str(lease.get("attempt_id") or "") == crash_probe_attempt_id
                    ),
                    None,
                )
                crash_probe_pid = pid
                crash_probe_killed = killed
                evidence.check(
                    "crash-recovery:performer-killed",
                    killed,
                    pid=pid,
                    attempt_id=crash_probe_attempt_id,
                    mode=candidate.get("mode"),
                    status=candidate.get("status"),
                    lease_id=crash_probe_lease_id,
                    error=error,
                )
                await asyncio.sleep(2)
                continue
        if crash_recovery_probe and crash_probe_killed and crash_probe_attempt_id:
            matching_attempts = [
                attempt for attempt in pipeline_attempts if attempt.get("attempt_id") == crash_probe_attempt_id
            ]
            terminal_attempts = [
                attempt
                for attempt in matching_attempts
                if attempt.get("state") in {"failed", "cancelled", "timed_out"}
            ]
            active_crash_leases = [
                lease
                for lease in pipeline_leases
                if str(lease.get("attempt_id") or "") == crash_probe_attempt_id
                or (crash_probe_lease_id and str(lease.get("lease_id") or "") == crash_probe_lease_id)
            ]
            if terminal_attempts and not active_crash_leases and not crash_probe_lease_reclaimed:
                crash_probe_lease_reclaimed = True
                evidence.check(
                    "crash-recovery:lease-reclaimed",
                    True,
                    attempt_id=crash_probe_attempt_id,
                    lease_id=crash_probe_lease_id,
                    pid=crash_probe_pid,
                    pipeline_attempts=terminal_attempts,
                    active_crash_leases=active_crash_leases,
                )
        mark_stage("webhook_queued", True, issue_id=issue_id)
        mark_stage("process_running_or_exited", process_status in {"running", "exited", "stopped"}, process_status=process_status)
        mark_stage("implementation_result_exists", result_path.exists(), path=str(result_path))
        mark_stage(
            "pipeline_attempt_started",
            bool(pipeline_attempts),
            attempts=[
                {
                    "attempt_id": attempt.get("attempt_id"),
                    "mode": attempt.get("mode"),
                    "state": attempt.get("state"),
                }
                for attempt in pipeline_attempts[-5:]
            ],
        )
        mark_stage(
            "pipeline_terminal",
            pipeline_terminal,
            nodes=[{"node_id": node.get("node_id"), "state": node.get("state")} for node in pipeline_nodes],
        )
        check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
        if permission_approval_probe and "human-action:managed-push-resume" in check_names:
            resumed_wait_ids = _resolved_pipeline_wait_ids(pipeline_payload)
            if completed_pipeline_human_waits & resumed_wait_ids:
                evidence.check("human-action:resume-observed-after-push", True, wait_ids=sorted(resumed_wait_ids))
                if not continue_after_human_resume:
                    break
        if pipeline_human_actions:
            evidence.check(
                "human-action:conductor-pipeline-awaiting-human",
                True,
                actions=pipeline_human_actions,
            )
            for action in pipeline_human_actions:
                wait_id = str(action.get("wait_id") or "")
                child_issue_id = str(action.get("child_issue_id") or "")
                if wait_id in completed_pipeline_human_waits and child_issue_id not in completed_pipeline_human_actions:
                    evidence.check(
                        "human-action:repeat-awaiting-human-after-resume",
                        not permission_approval_probe,
                        action=action,
                        reason="same Conductor run requested another human action after automatic resume",
                    )
                    if permission_approval_probe:
                        break
                    return write_wait_artifacts(
                        evidence=evidence,
                        samples=samples,
                        result_path=result_path,
                        final_issue=final_issue,
                        state_path=state_path,
                        last_state={},
                        ops_path=ops_path,
                        last_ops={},
                        log_path=log_path,
                        stages=stages,
                        stage_timeout_seconds=stage_timeout_seconds,
                    )
                if not should_complete_conductor_human_action(action, completed_pipeline_human_waits):
                    continue
                if wait_id not in parent_comment_probe_waits:
                    parent_comment_probe_waits.add(wait_id)
                    comment = await comment_linear_issue(
                        token,
                        issue_id,
                        parent_comment_negative_control_body(wait_id),
                    )
                    await asyncio.sleep(2)
                    probe_status, probe_body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=5)
                    probe_pipeline = (
                        probe_body.get("pipeline")
                        if probe_status == 200 and isinstance(probe_body, dict) and isinstance(probe_body.get("pipeline"), dict)
                        else {}
                    )
                    probe_wait = _pipeline_wait_by_id(probe_pipeline, wait_id)
                    if _wait_resolved_before_harness_resume(probe_wait):
                        completed_pipeline_human_waits.add(wait_id)
                        evidence.check(
                            "human-action:stale-wait-already-resolved",
                            True,
                            status=probe_status,
                            wait=probe_wait,
                            comment_created=bool(comment.get("success")),
                        )
                        continue
                    evidence.check(
                        "human-action:parent-comment-does-not-resume",
                        bool(comment.get("success"))
                        and probe_status == 200
                        and probe_wait.get("status") == "waiting",
                        status=probe_status,
                        wait=probe_wait,
                        comment_created=bool(comment.get("success")),
                    )
                response = e2e_human_action_resume_response(action)
                try:
                    completion = await complete_conductor_human_action(token, action, response=response)
                except Exception as exc:
                    evidence.check(
                        "human-action:linear-child-complete",
                        False,
                        child_issue_id=child_issue_id,
                        error=str(exc),
                    )
                    continue
                completed_pipeline_human_actions.add(child_issue_id)
                completed_pipeline_human_waits.add(wait_id)
                evidence.check(
                    "human-action:linear-child-complete",
                    completion.get("status") in {"completed", "already_done"},
                    action=action,
                    completion=completion,
                )
                status, pushed = http_json(
                    "POST",
                    api_url(conductor_port, f"/api/pipeline/human-waits/{wait_id}/human-answered"),
                    {"child_issue_id": child_issue_id, "human_response": response},
                    timeout=5,
                )
                evidence.check(
                    "human-action:managed-push-resume",
                    _human_answered_push_satisfies_resume_probe(status, pushed),
                    status=status,
                    body=pushed,
                )
            await asyncio.sleep(2)
            continue
        if expected_failure != "none" and pipeline_terminal:
            failed_with_child = any(
                node.get("state") == "failed"
                for node in sample.get("pipeline_nodes", [])
            )
            if failed_with_child:
                evidence.check(
                    f"expected-failure:{expected_failure}:terminal-child-created",
                    True,
                    pipeline_nodes=sample.get("pipeline_nodes", []),
                )
                break
        if permission_approval_probe:
            if (
                result_path.exists()
                and not pipeline_leases
                and "human-action:managed-push-resume" in check_names
                and "human-action:resume-observed-after-push" in check_names
            ):
                if not continue_after_human_resume:
                    break
        if (
            result_path.exists()
            and pipeline_terminal
            and pipeline_integrated
            and not pipeline_leases
            and process_status in {"exited", "stopped"}
        ):
            break
        sleep_seconds = 2 if crash_recovery_probe and not crash_probe_lease_reclaimed else 5
        await asyncio.sleep(sleep_seconds)
    final_issue = final_issue or await fetch_linear_issue(token, issue_id)
    if crash_recovery_probe:
        check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
        evidence.check(
            "crash-recovery:covered",
            {
                "crash-recovery:performer-killed",
                "crash-recovery:failure-visible",
                "crash-recovery:lease-reclaimed",
            }.issubset(check_names),
            killed=crash_probe_killed,
            attempt_id=crash_probe_attempt_id,
            lease_id=crash_probe_lease_id,
            pid=crash_probe_pid,
            passed_checks=sorted(name for name in check_names if str(name).startswith("crash-recovery:")),
        )
    return write_wait_artifacts(
        evidence=evidence,
        samples=samples,
        result_path=result_path,
        final_issue=final_issue,
        state_path=state_path,
        last_state={},
        ops_path=ops_path,
        last_ops={},
        log_path=log_path,
        stages=stages,
        stage_timeout_seconds=stage_timeout_seconds,
    )


def _pipeline_integrated(pipeline_payload: dict[str, Any]) -> bool:
    return pipeline_integrations_terminal(pipeline_payload)


def _human_answered_push_satisfies_resume_probe(status: int, body: Any) -> bool:
    if status != 200 or not isinstance(body, dict):
        return False
    if body.get("status") == "accepted":
        return True
    return body.get("status") == "ignored" and body.get("reason") == "completed_child_required"


def _wait_resolved_before_harness_resume(wait: dict[str, Any]) -> bool:
    if wait.get("status") != "resolved":
        return False
    resolution = str(wait.get("resolution") or "").strip().lower()
    return resolution in {"attempt succeeded", "attempt cancelled", "attempt failed", "attempt timed_out"}


def _immediate_failure_matches_attempt(failure: dict[str, Any], attempt_id: str | None) -> bool:
    expected_attempt_id = str(attempt_id or "").strip()
    if not expected_attempt_id:
        return False
    attempts = failure.get("attempts")
    if isinstance(attempts, list):
        attempt_ids = [
            str(attempt.get("attempt_id") or "")
            for attempt in attempts
            if isinstance(attempt, dict) and str(attempt.get("attempt_id") or "")
        ]
        return bool(attempt_ids) and all(attempt_id == expected_attempt_id for attempt_id in attempt_ids)
    actions = failure.get("actions")
    if not isinstance(actions, list):
        return False
    matched = False
    for action in actions:
        if not isinstance(action, dict):
            return False
        details = action.get("details")
        if not isinstance(details, dict) or str(details.get("attempt_id") or "") != expected_attempt_id:
            return False
        matched = True
    return matched


def _immediate_failure_without_attempt(failure: dict[str, Any], attempt_id: str | None) -> dict[str, Any] | None:
    expected_attempt_id = str(attempt_id or "").strip()
    if not expected_attempt_id:
        return failure
    attempts = failure.get("attempts")
    if not isinstance(attempts, list):
        return None if _immediate_failure_matches_attempt(failure, expected_attempt_id) else failure
    remaining_attempts = [
        attempt
        for attempt in attempts
        if not (isinstance(attempt, dict) and str(attempt.get("attempt_id") or "") == expected_attempt_id)
    ]
    if len(remaining_attempts) == len(attempts):
        return failure
    if not remaining_attempts:
        return None
    filtered = dict(failure)
    filtered["attempts"] = remaining_attempts
    return filtered


def _resolved_pipeline_wait_ids(pipeline_payload: dict[str, Any]) -> set[str]:
    wait_ids: set[str] = set()
    for key in ("human_waits", "runtime_waits"):
        waits = pipeline_payload.get(key)
        if not isinstance(waits, list):
            continue
        for wait in waits:
            if not isinstance(wait, dict) or wait.get("status") != "resolved":
                continue
            wait_id = str(wait.get("wait_id") or "")
            if wait_id:
                wait_ids.add(wait_id)
    return wait_ids


def _pipeline_wait_by_id(pipeline_payload: dict[str, Any], wait_id: str) -> dict[str, Any]:
    for key in ("human_waits", "runtime_waits"):
        waits = pipeline_payload.get(key)
        if not isinstance(waits, list):
            continue
        for wait in waits:
            if isinstance(wait, dict) and wait.get("wait_id") == wait_id:
                return wait
    return {}


def _pipeline_integrated_result_path(pipeline_payload: dict[str, Any]) -> Path | None:
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    integrated_verify_attempt_ids = {
        str(item.get("verify_attempt_id") or "") for item in integrations if item.get("status") == "integrated"
    }
    if not integrated_verify_attempt_ids:
        return None
    for manifest in pipeline_payload.get("manifests", []):
        if not isinstance(manifest, dict):
            continue
        if str(manifest.get("verify_attempt_id") or "") not in integrated_verify_attempt_ids:
            continue
        code = manifest.get("code")
        if not isinstance(code, dict):
            continue
        repository_path = str(code.get("repository_path") or "").strip()
        if repository_path:
            return Path(repository_path) / "SYMPHONY_REAL_E2E_RESULT.md"
    return None
