from __future__ import annotations

from typing import Any

from .conductor_service_helpers import _runtime_metrics


def pipeline_runtime_snapshot(pipeline_store) -> dict[str, Any]:
    view = pipeline_store.pipeline_view().to_dict()
    nodes = view.get("nodes") if isinstance(view.get("nodes"), list) else []
    attempts = view.get("attempts") if isinstance(view.get("attempts"), list) else []
    predicted = view.get("predicted_call_order") if isinstance(view.get("predicted_call_order"), list) else []
    human_waits = view.get("human_waits") if isinstance(view.get("human_waits"), list) else []
    runtime_waits = view.get("runtime_waits") if isinstance(view.get("runtime_waits"), list) else []
    running = _running_attempts(attempts)
    retrying = _retrying_nodes(nodes)
    blocked = _blocked_calls(predicted)
    human_interventions = _waiting_human_interventions(human_waits, runtime_waits)
    return {
        "source": "pipeline",
        "graph_revision": view.get("graph_revision"),
        "policy_revision": view.get("policy_revision"),
        "counts": {
            "running": len(running),
            "retrying": len(retrying),
            "continuing": 0,
            "blocked": len(blocked),
            "pending_human": len(human_interventions),
        },
        "running": running,
        "retrying": retrying,
        "continuing": [],
        "blocked": blocked,
        "human_interventions": human_interventions,
        "issues": running + retrying + blocked + human_interventions,
    }


def pipeline_runtime_metrics(pipeline_store) -> dict[str, Any]:
    return _runtime_metrics(pipeline_runtime_snapshot(pipeline_store))


def _running_attempts(attempts: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "attempt_id": attempt.get("attempt_id"),
            "issue_id": attempt.get("node_id"),
            "mode": attempt.get("mode"),
            "state": attempt.get("state"),
            "started_at": attempt.get("started_at"),
        }
        for attempt in attempts
        if isinstance(attempt, dict) and str(attempt.get("state") or "") == "running"
    ]


def _retrying_nodes(nodes: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "issue_id": node.get("node_id"),
            "state": node.get("state"),
            "rework_count": node.get("rework_count"),
        }
        for node in nodes
        if isinstance(node, dict) and int(node.get("rework_count") or 0) > 0
    ]


def _blocked_calls(predicted: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "issue_id": call.get("node"),
            "blocked_by": call.get("blocked_by"),
            "earliest_mode": call.get("earliest_mode"),
        }
        for call in predicted
        if isinstance(call, dict) and isinstance(call.get("blocked_by"), list) and call["blocked_by"]
    ]


def _waiting_human_interventions(human_waits: list[Any], runtime_waits: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "issue_id": wait.get("node_id"),
            "wait_id": wait.get("wait_id"),
            "reason": wait.get("reason") or wait.get("wait_kind"),
            "status": wait.get("status"),
        }
        for wait in [*human_waits, *runtime_waits]
        if isinstance(wait, dict) and str(wait.get("status") or "waiting") == "waiting"
    ]
