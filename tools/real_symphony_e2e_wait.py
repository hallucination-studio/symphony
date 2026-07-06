from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import (
    complete_conductor_human_action,
    conductor_human_actions,
    conductor_phase_runs,
    crash_probe_candidate,
    kill_performer_for_crash_probe,
    should_complete_conductor_human_action,
    write_wait_artifacts,
)
from real_symphony_e2e_common import Evidence, api_url, http_json, read_json_object_if_ready, utc_now
from real_symphony_e2e_linear import comment_linear_issue, fetch_linear_issue

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
    expected_failure: str = "none",
) -> dict[str, Any]:
    instance_root = Path(instance["instance_dir"])
    state_path = Path(instance["persistence_path"])
    ops_path = state_path.parent / "ops.json"
    result_path = Path(instance["workspace_root"]) / "SYMPHONY_REAL_E2E_RESULT.md"
    log_path = Path(instance["log_path"])
    instance_id = str(instance["id"])
    deadline = time.monotonic() + timeout_seconds
    samples: list[dict[str, Any]] = []
    final_issue: dict[str, Any] | None = None
    approved_blocked_events: set[str] = set()
    completed_phase_human_actions: set[str] = set()
    completed_phase_human_runs: set[str] = set()
    parent_comment_probe_runs: set[str] = set()
    crash_probe_run_id: str | None = None
    crash_probe_pid: int | None = None
    crash_probe_killed = False
    crash_probe_requeued = False
    crash_probe_restarted = False
    crash_probe_terminal = False
    last_state: dict[str, Any] = {}
    last_ops: dict[str, Any] = {}
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
        last_state = read_json_object_if_ready(state_path, last_state)
        last_ops = read_json_object_if_ready(ops_path, last_ops)
        state = last_state
        ops = last_ops
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
        runs_status, runs_body = http_json("GET", api_url(conductor_port, "/api/runs"), timeout=2)
        phase_payload = runs_body if runs_status == 200 and isinstance(runs_body, dict) else {}
        phase_runs = conductor_phase_runs(phase_payload)
        phase_human_actions = conductor_human_actions(phase_payload)
        conductor_phase_event_types: list[str] = []
        if crash_recovery_probe:
            for run in phase_runs:
                run_id = str(run.get("run_id") or "")
                if not run_id:
                    continue
                detail_status, detail_body = http_json("GET", api_url(conductor_port, f"/api/runs/{run_id}"), timeout=2)
                if detail_status != 200 or not isinstance(detail_body, dict):
                    continue
                detail = detail_body.get("run")
                events = (detail or {}).get("events") if isinstance(detail, dict) else []
                if isinstance(events, list):
                    conductor_phase_event_types.extend(
                        str(event.get("event_type") or "")
                        for event in events
                        if isinstance(event, dict) and event.get("event_type")
                    )
        phase_terminal = bool(
            phase_runs
            and all(
                run.get("phase") in {"done", "failed"} or run.get("status") in {"completed", "failed"}
                for run in phase_runs
            )
        )
        run_statuses = [run.get("status") for run in ops.get("runs", {}).values()]
        event_types = [
            event.get("event_type")
            for event in ops.get("events", {}).values()
            if isinstance(event, dict)
        ] if isinstance(ops.get("events"), dict) else [
            event.get("event_type")
            for event in ops.get("events", [])
            if isinstance(event, dict)
        ]
        sample = {
            "at": utc_now(),
            "issue_state": final_issue["state"]["name"],
            "process_status": process_status,
            "sessions": len(state.get("sessions", [])),
            "retry_attempts": len(state.get("retry_attempts", [])),
            "continuations": len(state.get("continuations", [])),
            "blocked": len(state.get("blocked", [])),
            "result_exists": result_path.exists(),
            "run_statuses": run_statuses,
            "phase_runs": [
                {
                    "run_id": run.get("run_id"),
                    "phase": run.get("phase"),
                    "status": run.get("status"),
                    "ack_status": run.get("ack_status"),
                    "last_reason": run.get("last_reason"),
                    "retry_count": run.get("retry_count"),
                    "crash_count": run.get("crash_count"),
                    "init_failure_count": run.get("init_failure_count"),
                    "overload_count": run.get("overload_count"),
                    "human_action": run.get("human_action"),
                }
                for run in phase_runs
            ],
            "phase_human_actions": phase_human_actions,
            "event_types": event_types[-20:],
            "conductor_phase_event_types": conductor_phase_event_types[-20:],
        }
        samples.append(sample)
        if crash_recovery_probe and not crash_probe_killed:
            candidate = crash_probe_candidate(phase_runs)
            if candidate is not None:
                pid = int(candidate["process_pid"])
                killed, error = kill_performer_for_crash_probe(pid)
                crash_probe_run_id = str(candidate.get("run_id") or "")
                crash_probe_pid = pid
                crash_probe_killed = killed
                evidence.check(
                    "crash-recovery:performer-killed",
                    killed,
                    pid=pid,
                    run_id=crash_probe_run_id,
                    phase=candidate.get("phase"),
                    status=candidate.get("status"),
                    error=error,
                )
                await asyncio.sleep(2)
                continue
        if crash_recovery_probe and crash_probe_killed and crash_probe_run_id:
            matching_runs = [run for run in phase_runs if run.get("run_id") == crash_probe_run_id]
            crashed_events_seen = "performer.crashed" in conductor_phase_event_types
            if crashed_events_seen and not crash_probe_requeued:
                requeued_runs = [
                    run
                    for run in matching_runs
                    if run.get("phase") == "queued" and run.get("crash_count", 0) >= 1
                ]
                if requeued_runs:
                    crash_probe_requeued = True
                    evidence.check(
                        "crash-recovery:performer-crashed-event",
                        True,
                        run_id=crash_probe_run_id,
                        phase_runs=requeued_runs,
                        event_types=conductor_phase_event_types[-20:],
                    )
            if crash_probe_requeued and not crash_probe_restarted:
                restarted_runs = [
                    run
                    for run in matching_runs
                    if run.get("phase") in {"implementing", "reviewing", "reworking", "done", "failed"}
                    and run.get("crash_count", 0) >= 1
                    and run.get("attempt", 0) >= 1
                ]
                if restarted_runs:
                    crash_probe_restarted = True
                    evidence.check(
                        "crash-recovery:restarted-after-crash",
                        True,
                        run_id=crash_probe_run_id,
                        phase_runs=restarted_runs,
                    )
            if crash_probe_requeued and not crash_probe_terminal:
                terminal_runs = [
                    run
                    for run in matching_runs
                    if run.get("phase") in {"done", "failed"} or run.get("status") in {"completed", "failed"}
                    if run.get("crash_count", 0) >= 1
                ]
                if terminal_runs:
                    crash_probe_terminal = True
                    evidence.check(
                        "crash-recovery:terminal-after-crash",
                        True,
                        run_id=crash_probe_run_id,
                        pid=crash_probe_pid,
                        phase_runs=terminal_runs,
                    )
        mark_stage("webhook_queued", True, issue_id=issue_id)
        mark_stage("process_running_or_exited", process_status in {"running", "exited", "stopped"}, process_status=process_status)
        mark_stage("implementation_result_exists", result_path.exists(), path=str(result_path))
        mark_stage(
            "implementation_review_ready",
            final_issue["state"]["name"] == "In Review" or final_issue["state"]["type"] in {"completed", "canceled"},
            issue_state=final_issue["state"],
        )
        mark_stage(
            "gate_followup_started",
            "gate_followup_started" in event_types,
            event_types=event_types[-20:],
        )
        mark_stage(
            "gate_one_shot_completed",
            "gate_followup_started" in event_types and run_statuses and all(status != "running" for status in run_statuses),
            run_statuses=run_statuses,
        )
        blocked = [entry for entry in state.get("blocked", []) if isinstance(entry, dict)]
        for blocked_entry in blocked:
            blocked_issue_id = str(blocked_entry.get("issue_id") or "")
            blocked_key = f"{blocked_issue_id}:{blocked_entry.get('blocked_at') or blocked_entry.get('error')}"
            if not blocked_issue_id or blocked_key in approved_blocked_events:
                continue
            evidence.check(
                "runtime-error:blocked-visible",
                blocked_entry.get("phase") == "error"
                and blocked_entry.get("status_label") == "performer:phase/blocked"
                and bool(blocked_entry.get("error")),
                blocked=blocked_entry,
            )
            approval_comment = f"/symphony approve-runtime-error {blocked_entry.get('issue_identifier') or blocked_issue_id}"
            body = await comment_linear_issue(
                token,
                blocked_issue_id,
                approval_comment,
            )
            evidence.check(
                "runtime-error:linear-human-approved-resume",
                bool(body.get("success")) and bool((body.get("comment") or {}).get("id")),
                approval_comment=approval_comment,
                body=body,
            )
            approved_blocked_events.add(blocked_key)
            await asyncio.sleep(2)
            break
        check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
        if permission_approval_probe and "human-action:managed-push-resume" in check_names:
            resumed_runs = [
                run
                for run in phase_runs
                if run.get("run_id") in completed_phase_human_runs
                and not (
                    run.get("phase") == "awaiting_human"
                    and str((run.get("human_action") or {}).get("child_issue_id") or "") in completed_phase_human_actions
                )
            ]
            if resumed_runs:
                evidence.check("human-action:resume-observed-after-push", True, phase_runs=resumed_runs)
                break
        if phase_human_actions:
            evidence.check(
                "human-action:conductor-phase-awaiting-human",
                True,
                actions=phase_human_actions,
            )
            for action in phase_human_actions:
                run_id = str(action.get("run_id") or "")
                child_issue_id = str(action.get("child_issue_id") or "")
                if run_id in completed_phase_human_runs and child_issue_id not in completed_phase_human_actions:
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
                        last_state=last_state,
                        ops_path=ops_path,
                        last_ops=last_ops,
                        log_path=log_path,
                        stages=stages,
                        stage_timeout_seconds=stage_timeout_seconds,
                    )
                if not should_complete_conductor_human_action(action, completed_phase_human_runs):
                    continue
                if run_id not in parent_comment_probe_runs:
                    parent_comment_probe_runs.add(run_id)
                    comment = await comment_linear_issue(
                        token,
                        issue_id,
                        "E2E parent comment probe: this comment must not resume a waiting Symphony human action.",
                    )
                    await asyncio.sleep(2)
                    probe_status, probe_body = http_json("GET", api_url(conductor_port, f"/api/runs/{run_id}"), timeout=5)
                    probe_run = ((probe_body.get("run") or {}).get("run") or {}) if isinstance(probe_body, dict) else {}
                    evidence.check(
                        "human-action:parent-comment-does-not-resume",
                        bool(comment.get("success"))
                        and probe_status == 200
                        and probe_run.get("phase") == "awaiting_human"
                        and probe_run.get("status") == "waiting",
                        status=probe_status,
                        run=probe_run,
                        comment_created=bool(comment.get("success")),
                    )
                response = (
                    "Reviewed by the real Symphony E2E harness. "
                    "Apply any required local environment fix and retry the managed run."
                )
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
                completed_phase_human_actions.add(child_issue_id)
                completed_phase_human_runs.add(run_id)
                evidence.check(
                    "human-action:linear-child-complete",
                    completion.get("status") in {"completed", "already_done"},
                    action=action,
                    completion=completion,
                )
                status, pushed = http_json(
                    "POST",
                    api_url(conductor_port, f"/api/runs/{run_id}/human-answered"),
                    {"child_issue_id": child_issue_id, "human_response": response},
                    timeout=5,
                )
                evidence.check(
                    "human-action:managed-push-resume",
                    status == 200 and isinstance(pushed, dict) and pushed.get("status") == "accepted",
                    status=status,
                    body=pushed,
                )
            await asyncio.sleep(2)
            continue
        if expected_failure != "none" and phase_terminal:
            failed_with_child = any(
                run.get("phase") == "failed"
                and isinstance(run.get("human_action"), dict)
                and bool((run.get("human_action") or {}).get("child_issue_id"))
                for run in sample.get("phase_runs", [])
            )
            if failed_with_child:
                evidence.check(
                    f"expected-failure:{expected_failure}:terminal-child-created",
                    True,
                    phase_runs=sample.get("phase_runs", []),
                )
                break
        if permission_approval_probe:
            if (
                result_path.exists()
                and state.get("blocked", []) == []
                and "runtime-error:blocked-visible" in check_names
                and "runtime-error:linear-human-approved-resume" in check_names
            ):
                break
        if (
            result_path.exists()
            and final_issue["state"]["type"] in {"completed", "canceled"}
            and state.get("sessions") == []
            and state.get("retry_attempts") == []
            and state.get("continuations", []) == []
            and state.get("blocked", []) == []
            and (phase_terminal or (run_statuses and all(status != "running" for status in run_statuses)))
            and process_status in {"exited", "stopped"}
        ):
            break
        sleep_seconds = 2 if crash_recovery_probe and not crash_probe_terminal else 5
        await asyncio.sleep(sleep_seconds)
    final_issue = final_issue or await fetch_linear_issue(token, issue_id)
    if crash_recovery_probe:
        check_names = {check.get("name") for check in evidence.data.get("checks", []) if check.get("passed")}
        evidence.check(
            "crash-recovery:covered",
            {
                "crash-recovery:performer-killed",
                "crash-recovery:performer-crashed-event",
                "crash-recovery:restarted-after-crash",
                "crash-recovery:terminal-after-crash",
            }.issubset(check_names),
            killed=crash_probe_killed,
            run_id=crash_probe_run_id,
            pid=crash_probe_pid,
            passed_checks=sorted(name for name in check_names if str(name).startswith("crash-recovery:")),
        )
    return write_wait_artifacts(
        evidence=evidence,
        samples=samples,
        result_path=result_path,
        final_issue=final_issue,
        state_path=state_path,
        last_state=last_state,
        ops_path=ops_path,
        last_ops=last_ops,
        log_path=log_path,
        stages=stages,
        stage_timeout_seconds=stage_timeout_seconds,
    )
