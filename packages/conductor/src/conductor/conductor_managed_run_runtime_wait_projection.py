from __future__ import annotations

from typing import Any

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_runtime_waits import (
    linear_issue_is_completed,
    merge_runtime_wait,
    runtime_wait_description,
    runtime_wait_title,
    runtime_waits,
)
from .conductor_managed_run_store import ConductorManagedRunStore


async def ingest_runtime_wait_child_completions(
    *,
    store: ConductorManagedRunStore,
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    tracker: Any,
) -> int:
    fetch_issue = getattr(tracker, "fetch_issue", None)
    if not callable(fetch_issue):
        return 0
    run = store.get_run(run_id)
    if run is None:
        return 0
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    resolved = 0
    for wait in runtime_waits(payload):
        if wait.get("status") != "waiting":
            continue
        child_issue_id = str(wait.get("child_issue_id") or "")
        if not child_issue_id:
            continue
        issue = await fetch_issue(child_issue_id)
        if isinstance(issue, dict) and linear_issue_is_completed(issue):
            resolved += int(coordinator.resolve_runtime_wait(run_id, str(wait.get("wait_id") or "")))
    return resolved


async def project_runtime_waits(
    *,
    store: ConductorManagedRunStore,
    tracker: Any,
    run_id: str,
    root_issue_id: str,
) -> int:
    create_child = getattr(tracker, "create_child_issue_for", None)
    if not callable(create_child):
        return 0
    run = store.get_run(run_id)
    if run is None:
        return 0
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    waits = runtime_waits(payload)
    projected = 0
    changed = False
    for index, wait in enumerate(waits):
        if wait.get("status") != "waiting":
            continue
        child_issue_id = str(wait.get("child_issue_id") or "")
        issue: dict[str, Any] = {}
        fetch_issue = getattr(tracker, "fetch_issue", None)
        if child_issue_id and callable(fetch_issue):
            loaded = await fetch_issue(child_issue_id)
            issue = dict(loaded) if isinstance(loaded, dict) else {}
        if not child_issue_id or not issue:
            created = await create_child(
                parent_issue_id=root_issue_id,
                title=runtime_wait_title(wait),
                description=runtime_wait_description(wait),
                label_names=[],
            )
            issue = dict(created) if isinstance(created, dict) else {}
            child_issue_id = str(issue.get("id") or "")
            if not child_issue_id:
                raise RuntimeError(f"managed_run_runtime_wait_child_missing_id run_id={run_id} wait_id={wait.get('wait_id')}")
            waits[index] = {**wait, "child_issue_id": child_issue_id, "child_issue_identifier": str(issue.get("identifier") or "")}
            wait = waits[index]
            changed = True
            projected += 1
        update_description = getattr(tracker, "update_issue_description_marker_block", None)
        if callable(update_description):
            await update_description(child_issue_id, "SYMPHONY RUNTIME WAIT", runtime_wait_description(wait))
            projected += 1
        transition = getattr(tracker, "transition_issue_by_state_target", None)
        if callable(transition):
            await transition(child_issue_id, names=["Blocked", "Needs More"], state_type="unstarted")
            projected += 1
    if changed:
        merged: list[dict[str, Any]] = []
        for wait in waits:
            merged = merge_runtime_wait(merged, wait)
        store.merge_run_payload(run_id, {"runtime_waits": merged})
    return projected


__all__ = ["ingest_runtime_wait_child_completions", "project_runtime_waits"]
