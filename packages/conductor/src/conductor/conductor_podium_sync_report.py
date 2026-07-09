from __future__ import annotations

from typing import Any


def _pipeline_report_metrics(pipeline: dict[str, Any]) -> dict[str, Any]:
    nodes = pipeline.get("nodes") if isinstance(pipeline.get("nodes"), list) else []
    attempts = pipeline.get("attempts") if isinstance(pipeline.get("attempts"), list) else []
    human_waits = pipeline.get("human_waits") if isinstance(pipeline.get("human_waits"), list) else []
    runtime_waits = pipeline.get("runtime_waits") if isinstance(pipeline.get("runtime_waits"), list) else []
    predicted = pipeline.get("predicted_call_order") if isinstance(pipeline.get("predicted_call_order"), list) else []

    failed_attempts = sum(
        1
        for attempt in attempts
        if isinstance(attempt, dict) and str(attempt.get("state") or "") in {"failed", "timed_out", "cancelled"}
    )
    failed_nodes = sum(
        1
        for node in nodes
        if isinstance(node, dict) and str(node.get("state") or "") == "failed"
    )
    blocked_predictions = sum(
        1
        for call in predicted
        if isinstance(call, dict) and isinstance(call.get("blocked_by"), list) and len(call["blocked_by"]) > 0
    )
    active_human_waits = sum(
        1 for wait in human_waits if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
    )
    active_runtime_waits = sum(
        1 for wait in runtime_waits if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
    )
    rework_attempts = sum(
        1
        for node in nodes
        if isinstance(node, dict) and int(node.get("rework_count") or 0) > 0
    )
    return {
        "tokens": 0,
        "runtime_seconds": 0.0,
        "retries": rework_attempts,
        "continuations": 0,
        "blocked": blocked_predictions,
        "pending_human": active_human_waits + active_runtime_waits,
        "failures": failed_attempts + failed_nodes,
    }


def _pipeline_report_queue(pipeline: dict[str, Any]) -> dict[str, int]:
    modes = pipeline.get("modes") if isinstance(pipeline.get("modes"), list) else []
    leases = pipeline.get("leases") if isinstance(pipeline.get("leases"), list) else []
    queued = 0
    for mode in modes:
        if isinstance(mode, dict):
            queued += int(mode.get("queued") or 0)
    return {"queued": queued, "leased": len(leases)}


def _linear_issue_completed(issue: dict[str, Any]) -> bool:
    state_type = str(issue.get("state_type") or "").strip().lower()
    if state_type == "completed":
        return True
    state_name = str(issue.get("state") or "").strip().lower()
    return state_name in {"done", "closed", "completed"}


def _instance_for_attempt_pid(instances: list[Any], process_pid: int | None) -> Any | None:
    if process_pid is None:
        return None
    for instance in instances:
        if getattr(instance, "pid", None) == process_pid:
            return instance
    return None
