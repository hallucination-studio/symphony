from __future__ import annotations

from typing import Any

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_human_action_projection import ingest_linear_human_action_state_flips
from .conductor_managed_run_runtime_wait_projection import ingest_runtime_wait_child_completions
from .conductor_managed_run_store import ConductorManagedRunStore


async def ingest_managed_run_operator_events(
    *,
    store: ConductorManagedRunStore,
    tracker: Any,
    run_id: str,
    root_issue_id: str,
    run: dict[str, Any],
    work_items: list[dict[str, Any]],
    root_issue: dict[str, Any],
    issues_by_work_item: dict[str, dict[str, Any]],
) -> tuple[int, dict[str, Any], list[dict[str, Any]]]:
    coordinator = ConductorManagedRunCoordinator(store=store)
    projected = await ingest_runtime_wait_child_completions(
        store=store,
        coordinator=coordinator,
        run_id=run_id,
        tracker=tracker,
    )
    run = store.get_run(run_id) or run
    work_items = store.list_work_items(run_id)
    projected += await ingest_linear_human_action_state_flips(
        store=store,
        coordinator=coordinator,
        run_id=run_id,
        root_issue_id=root_issue_id,
        root_issue=root_issue,
        work_items=work_items,
        issues_by_work_item=issues_by_work_item,
    )
    return projected, store.get_run(run_id) or run, store.list_work_items(run_id)


__all__ = ["ingest_managed_run_operator_events"]
