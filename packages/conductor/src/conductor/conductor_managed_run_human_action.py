from __future__ import annotations

from typing import Any

from performer_api.managed_runs import WorkItemState

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator


def human_action_wait_id(work_item_id: str, reason: str) -> str:
    return f"managed-run:{work_item_id}:{reason or 'blocked'}"


def human_action_instruction_body(*, run_id: str, work_item_id: str, reason: str) -> str:
    return "\n".join(
        [
            "## Symphony Managed Run Human Action",
            "",
            f"- run_id: {run_id}",
            f"- work_item_id: {work_item_id}",
            f"- structured_reason: {reason}",
            "- required_action: provide the approval or decision requested by this blocked work item",
            "- comments are context only",
            "- resume requires flipping the issue out of the blocked state",
        ]
    )


def ingest_managed_run_human_action_event(
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    event: dict[str, Any],
) -> dict[str, Any]:
    if str(event.get("event_type") or "") != "state_changed":
        return {"applied": False, "reason": "comment_only_does_not_resume"}
    if event.get("from_blocked_style") is not True or event.get("to_blocked_style") is not False:
        return {"applied": False, "reason": "state_flip_not_resumable"}
    work_item_id = str(event.get("work_item_id") or "")
    if not work_item_id:
        return {"applied": False, "reason": "work_item_id_required"}
    current = _work_item(coordinator, run_id, work_item_id)
    if current.get("state") != WorkItemState.BLOCKED.value or current.get("gate_status") != "human_approval_required":
        return {"applied": False, "reason": "work_item_not_waiting_for_human_action"}
    coordinator.approve_work_item(run_id, work_item_id, approval_id=str(event.get("event_id") or "state_flip"))
    return {"applied": True, "reason": "state_flip_resumed"}


def _work_item(coordinator: ConductorManagedRunCoordinator, run_id: str, work_item_id: str) -> dict[str, Any]:
    for item in coordinator.store.list_work_items(run_id):
        if item.get("work_item_id") == work_item_id:
            return item
    return {}


__all__ = ["human_action_instruction_body", "human_action_wait_id", "ingest_managed_run_human_action_event"]
