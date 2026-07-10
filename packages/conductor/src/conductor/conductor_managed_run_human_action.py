from __future__ import annotations

from typing import Any

from performer_api.managed_runs import ManagedRunState, WorkItemState

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator


BLOCKED_STYLE_NAMES = frozenset({"blocked", "needs more"})


def human_action_wait_id(scope_id: str, reason: str) -> str:
    return f"managed-run:{scope_id or 'parent'}:{reason or 'blocked'}"


def human_action_instruction_body(
    *,
    run_id: str,
    work_item_id: str = "",
    reason: str,
    required_action: str = "",
) -> str:
    target = work_item_id or "parent"
    action = required_action or _required_action(reason, work_item_id)
    return "\n".join(
        [
            "## Symphony Managed Run Human Action",
            "",
            f"- run_id: {run_id}",
            f"- work_item_id: {target}",
            f"- structured_reason: {reason}",
            f"- required_action: {action}",
            "- comments are context only",
            "- resume requires flipping the issue out of the blocked state",
        ]
    )


def human_action_targets(run: dict[str, Any], work_items: list[dict[str, Any]]) -> list[dict[str, str]]:
    targets = [_work_item_target(item) for item in work_items if item.get("state") == WorkItemState.BLOCKED.value]
    targets = [target for target in targets if target is not None]
    if targets:
        return targets
    state = str(run.get("state") or "")
    reason = str(run.get("latest_reason") or "")
    if state == ManagedRunState.AWAITING_APPROVAL.value and reason == "plan_approval_required":
        return [_target("plan", "", reason)]
    if state == ManagedRunState.BLOCKED.value and reason:
        return [_target("run", "", reason)]
    return []


def linear_issue_is_blocked_style(issue: dict[str, Any]) -> bool:
    return str(issue.get("state") or "").strip().lower() in BLOCKED_STYLE_NAMES


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
    if work_item_id:
        return _resume_work_item(coordinator, run_id, work_item_id, event)
    return _resume_parent(coordinator, run_id, event)


def _work_item_target(item: dict[str, Any]) -> dict[str, str] | None:
    work_item_id = str(item.get("work_item_id") or "")
    reason = str(item.get("gate_status") or "")
    return _target("work_item", work_item_id, reason) if work_item_id and reason else None


def _target(target_kind: str, work_item_id: str, reason: str) -> dict[str, str]:
    scope_id = work_item_id or ("plan" if reason == "plan_approval_required" else "parent")
    return {
        "target_kind": target_kind,
        "work_item_id": work_item_id,
        "reason": reason,
        "wait_id": human_action_wait_id(scope_id, reason),
        "required_action": _required_action(reason, work_item_id),
    }


def _required_action(reason: str, work_item_id: str) -> str:
    if reason == "plan_approval_required":
        return "review the accepted plan, then flip this issue out of the blocked state to approve it"
    if reason == "human_approval_required":
        return "provide the approval or decision requested by this blocked work item"
    if reason == "plan_revision_requested":
        return "provide an approved plan revision through the managed run, then flip this issue out of the blocked state"
    if work_item_id:
        return "correct the blocked work item, then flip this issue out of the blocked state"
    return "resolve the blocked managed run, then flip this issue out of the blocked state"


def _resume_work_item(
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    work_item_id: str,
    event: dict[str, Any],
) -> dict[str, Any]:
    current = _work_item(coordinator, run_id, work_item_id)
    if current.get("state") != WorkItemState.BLOCKED.value:
        return {"applied": False, "reason": "work_item_not_waiting_for_human_action"}
    reason = str(current.get("gate_status") or "")
    marker = str(event.get("event_id") or "state_flip")
    if reason == "human_approval_required":
        coordinator.approve_work_item(run_id, work_item_id, approval_id=marker)
        return {"applied": True, "reason": "state_flip_resumed"}
    if reason == "plan_revision_requested":
        return {"applied": False, "reason": "plan_revision_requires_approved_plan"}
    coordinator.reopen_blocked_work_item(run_id, work_item_id, action_id=marker)
    return {"applied": True, "reason": "state_flip_resumed"}


def _resume_parent(
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    event: dict[str, Any],
) -> dict[str, Any]:
    run = coordinator.store.get_run(run_id)
    if run is None:
        raise KeyError(run_id)
    marker = str(event.get("event_id") or "state_flip")
    if run.get("state") == ManagedRunState.AWAITING_APPROVAL.value and run.get("latest_reason") == "plan_approval_required":
        coordinator.approve_plan(run_id, approval_id=marker)
        return {"applied": True, "reason": "state_flip_resumed"}
    if run.get("state") != ManagedRunState.BLOCKED.value:
        return {"applied": False, "reason": "parent_not_waiting_for_human_action"}
    if run.get("latest_reason") == "plan_revision_requested":
        return {"applied": False, "reason": "plan_revision_requires_approved_plan"}
    coordinator.reopen_blocked_run(run_id, action_id=marker)
    return {"applied": True, "reason": "state_flip_resumed"}


def _work_item(coordinator: ConductorManagedRunCoordinator, run_id: str, work_item_id: str) -> dict[str, Any]:
    for item in coordinator.store.list_work_items(run_id):
        if item.get("work_item_id") == work_item_id:
            return item
    return {}


__all__ = [
    "BLOCKED_STYLE_NAMES",
    "human_action_instruction_body",
    "human_action_targets",
    "human_action_wait_id",
    "ingest_managed_run_human_action_event",
    "linear_issue_is_blocked_style",
]
