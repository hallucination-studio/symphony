from __future__ import annotations

from typing import Any

from .conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from .conductor_managed_run_coordinator_helpers import LOGGER
from .conductor_managed_run_human_action import (
    human_action_instruction_body,
    human_action_targets,
    ingest_managed_run_human_action_event,
    linear_issue_is_blocked_style,
)
from .conductor_managed_run_store import ConductorManagedRunStore


async def ingest_linear_human_action_state_flips(
    *,
    store: ConductorManagedRunStore,
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    root_issue_id: str,
    root_issue: dict[str, Any],
    work_items: list[dict[str, Any]],
    issues_by_work_item: dict[str, dict[str, Any]],
) -> int:
    run = store.get_run(run_id)
    if run is None:
        return 0
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    instructions = payload.get("human_action_instructions") if isinstance(payload.get("human_action_instructions"), dict) else {}
    mappings = {str(key): dict(value) for key, value in instructions.items() if isinstance(value, dict)}
    changed = 0
    for target in human_action_targets(run, work_items):
        wait_id = target["wait_id"]
        mapping = mappings.get(wait_id)
        issue_id, issue = _target_issue(target, root_issue_id, root_issue, issues_by_work_item)
        if mapping is None or not issue_id or not issue:
            continue
        mapping_changed, applied = _ingest_target_state_flip(
            coordinator=coordinator,
            run_id=run_id,
            target=target,
            issue_id=issue_id,
            issue=issue,
            mapping=mapping,
        )
        if mapping_changed:
            mappings[wait_id] = mapping
            changed += 1
        if applied:
            changed += 1
    if changed:
        store.merge_run_payload(run_id, {"human_action_instructions": mappings})
    return changed


async def project_human_action_instructions(
    *,
    store: ConductorManagedRunStore,
    tracker: Any,
    run_id: str,
    root_issue_id: str,
    run: dict[str, Any],
    work_items: list[dict[str, Any]],
    issues_by_work_item: dict[str, dict[str, Any]],
) -> int:
    comment_issue = getattr(tracker, "comment_issue", None)
    update_comment = getattr(tracker, "update_issue_comment", None)
    if not callable(comment_issue):
        return 0
    latest = store.get_run(run_id) or run
    payload = latest.get("payload") if isinstance(latest.get("payload"), dict) else {}
    instructions = payload.get("human_action_instructions") if isinstance(payload.get("human_action_instructions"), dict) else {}
    mappings = {str(key): dict(value) for key, value in instructions.items() if isinstance(value, dict)}
    projected = 0
    for target in human_action_targets(latest, work_items):
        issue_id, _issue = _target_issue(target, root_issue_id, {}, issues_by_work_item)
        if not issue_id:
            continue
        mapping = mappings.get(target["wait_id"]) or {}
        comment_id = str(mapping.get("linear_comment_id") or "")
        body = human_action_instruction_body(
            run_id=run_id,
            work_item_id=target["work_item_id"],
            reason=target["reason"],
            required_action=target["required_action"],
        )
        result = await _upsert_instruction_comment(comment_issue, update_comment, comment_id, issue_id, body)
        saved_comment_id = str(result.get("comment_id") or comment_id)
        if not saved_comment_id:
            raise RuntimeError(f"managed_run_human_action_comment_missing_id run_id={run_id} wait_id={target['wait_id']}")
        waiting = mapping.get("wait_state") == "waiting"
        cycle = int(mapping.get("cycle") or 0) + int(bool(mapping) and not waiting)
        mappings[target["wait_id"]] = {
            **mapping,
            "wait_id": target["wait_id"],
            "target_kind": target["target_kind"],
            "work_item_id": target["work_item_id"],
            "structured_reason": target["reason"],
            "linear_issue_id": issue_id,
            "linear_comment_id": saved_comment_id,
            "expected_blocked_style": bool(mapping.get("expected_blocked_style")) if waiting else False,
            "wait_state": "waiting",
            "cycle": cycle or 1,
        }
        projected += 1
    if projected:
        store.merge_run_payload(run_id, {"human_action_instructions": mappings})
    return projected


def _target_issue(
    target: dict[str, str],
    root_issue_id: str,
    root_issue: dict[str, Any],
    issues_by_work_item: dict[str, dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    if target["target_kind"] != "work_item":
        return root_issue_id, root_issue
    issue = issues_by_work_item.get(target["work_item_id"]) or {}
    return str(issue.get("id") or ""), issue


def _ingest_target_state_flip(
    *,
    coordinator: ConductorManagedRunCoordinator,
    run_id: str,
    target: dict[str, str],
    issue_id: str,
    issue: dict[str, Any],
    mapping: dict[str, Any],
) -> tuple[bool, bool]:
    current_blocked = linear_issue_is_blocked_style(issue)
    mapping["last_observed_state"] = str(issue.get("state") or "")
    mapping["last_observed_state_type"] = str(issue.get("state_type") or "")
    mapping["last_observed_blocked_style"] = current_blocked
    if mapping.get("wait_state") != "waiting":
        return True, False
    if not mapping.get("expected_blocked_style"):
        mapping["expected_blocked_style"] = current_blocked
        return True, False
    if current_blocked:
        return True, False
    event_id = _state_flip_event_id(target["wait_id"], issue_id, issue)
    outcome = ingest_managed_run_human_action_event(
        coordinator,
        run_id,
        {
            "event_type": "state_changed",
            "target_kind": target["target_kind"],
            "work_item_id": target["work_item_id"],
            "from_blocked_style": True,
            "to_blocked_style": False,
            "event_id": event_id,
        },
    )
    mapping["last_state_flip"] = {"event_id": event_id, **outcome}
    mapping["wait_state"] = "resolved" if outcome.get("applied") else "state_flip_rejected"
    if not outcome.get("applied"):
        reason = str(outcome.get("reason") or "state_flip_not_resumable")
        LOGGER.warning(
            "event=managed_run_human_action_state_flip_ignored run_id=%s work_item_id=%s error_code=%s sanitized_reason=%s action_required=provide_approved_resolution retryable=false next_action=keep_blocked",
            run_id,
            target["work_item_id"] or "parent",
            reason,
            reason,
        )
    return True, bool(outcome.get("applied"))


async def _upsert_instruction_comment(
    comment_issue: Any,
    update_comment: Any,
    comment_id: str,
    issue_id: str,
    body: str,
) -> dict[str, Any]:
    if comment_id and callable(update_comment):
        return await update_comment(comment_id, body)
    if comment_id:
        return {"comment_id": comment_id}
    return await comment_issue(issue_id, body)


def _state_flip_event_id(wait_id: str, issue_id: str, issue: dict[str, Any]) -> str:
    state = str(issue.get("state") or "unknown").strip().lower().replace(" ", "_")
    return f"linear_state_flip:{wait_id}:{issue_id}:{state}"


__all__ = ["ingest_linear_human_action_state_flips", "project_human_action_instructions"]
