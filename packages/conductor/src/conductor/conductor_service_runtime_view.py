from __future__ import annotations

from typing import Any

from .conductor_service_helpers import _runtime_metrics


def managed_run_runtime_snapshot(managed_run_store) -> dict[str, Any]:
    view = managed_run_store.managed_run_view()
    runs = view.get("runs") if isinstance(view.get("runs"), list) else []
    runtime_waits = view.get("runtime_waits") if isinstance(view.get("runtime_waits"), list) else []
    if not runtime_waits:
        runtime_waits = [
            {"run_id": run.get("run_id"), **wait}
            for run in runs
            if isinstance(run, dict)
            for wait in (run.get("runtime_waits") or [])
            if isinstance(wait, dict)
        ]
    running = _running_runs(runs)
    blocked = _blocked_runs(runs)
    pending_human = _human_attention_runs(runs)
    return {
        "source": "managed_run",
        "runs_total": len(runs),
        "counts": {
            "running": len(running),
            "retrying": 0,
            "continuing": 0,
            "blocked": len(blocked),
            "pending_human": len(pending_human),
            "runtime_waiting": sum(1 for wait in runtime_waits if isinstance(wait, dict) and wait.get("status") == "waiting"),
        },
        "running": running,
        "retrying": [],
        "continuing": [],
        "blocked": blocked,
        "human_interventions": pending_human,
        "runtime_waits": runtime_waits,
        "issues": running + blocked + pending_human,
    }


def managed_run_runtime_metrics(managed_run_store) -> dict[str, Any]:
    return _runtime_metrics(managed_run_runtime_snapshot(managed_run_store))


def _running_runs(runs: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "run_id": run.get("run_id"),
            "issue_id": run.get("parent_issue_id"),
            "issue_identifier": run.get("issue_identifier"),
            "state": run.get("state"),
            "active_work_item_id": run.get("active_work_item_id"),
        }
        for run in runs
        if isinstance(run, dict) and str(run.get("state") or "") in {"planning", "projecting_plan", "ready", "executing", "reviewing"}
    ]


def _blocked_runs(runs: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "run_id": run.get("run_id"),
            "issue_id": run.get("parent_issue_id"),
            "issue_identifier": run.get("issue_identifier"),
            "reason": run.get("latest_reason") or "blocked",
        }
        for run in runs
        if isinstance(run, dict) and str(run.get("state") or "") in {"blocked", "failed"}
    ]


def _human_attention_runs(runs: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "run_id": run.get("run_id"),
            "issue_id": run.get("parent_issue_id"),
            "issue_identifier": run.get("issue_identifier"),
            "reason": run.get("latest_reason") or "human attention required",
        }
        for run in runs
        if isinstance(run, dict) and str(run.get("state") or "") == "blocked"
    ]
