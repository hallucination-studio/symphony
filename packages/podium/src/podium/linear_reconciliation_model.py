from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

from .podium_shared import utc_now_iso


def initial_reconciliation_state(binding_id: str) -> dict[str, Any]:
    return {
        "binding_id": binding_id,
        "baseline_complete": False,
        "checkpoint_updated_at": "",
        "checkpoint_issue_id": "",
        "page_cursor": "",
        "scan_started_at": "",
        "scan_high_water_updated_at": "",
        "scan_high_water_issue_id": "",
        "scan_issue_count": 0,
        "last_success_at": None,
        "last_error_code": "",
        "last_error": "",
        "retry_count": 0,
        "next_retry_at": None,
    }


def reconciliation_deferred(state: dict[str, Any]) -> bool:
    value = str(state.get("next_retry_at") or "")
    if not value:
        return False
    try:
        next_retry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return next_retry > datetime.now(timezone.utc)


def page_state(
    current: dict[str, Any],
    *,
    mode: str,
    scan_started_at: str,
    page_cursor: str,
    issues: list[dict[str, Any]],
    final_page: bool,
) -> dict[str, Any]:
    high_water = max([_state_high_water(current), *(issue_order_key(issue) for issue in issues)])
    updated = {
        **current,
        "page_cursor": "" if final_page else page_cursor,
        "scan_started_at": "" if final_page else scan_started_at,
        "scan_high_water_updated_at": "" if final_page else high_water[0],
        "scan_high_water_issue_id": "" if final_page else high_water[1],
        "scan_issue_count": int(current.get("scan_issue_count") or 0) + len(issues),
        "last_error_code": "",
        "last_error": "",
        "retry_count": 0,
        "next_retry_at": None,
    }
    if not final_page:
        return updated
    updated["last_success_at"] = utc_now_iso()
    updated["last_issue_count"] = updated["scan_issue_count"]
    updated["scan_issue_count"] = 0
    if mode == "baseline":
        updated["baseline_complete"] = True
        updated["checkpoint_updated_at"] = scan_started_at
        updated["checkpoint_issue_id"] = ""
    else:
        updated["checkpoint_updated_at"] = high_water[0]
        updated["checkpoint_issue_id"] = high_water[1]
    return updated


def failure_state(current: dict[str, Any], binding_id: str, code: str, reason: str) -> dict[str, Any]:
    retry_count = int(current.get("retry_count") or 0) + 1
    base_seconds = min(300, 5 * (2 ** min(retry_count - 1, 6)))
    digest = hashlib.sha256(f"{binding_id}:{retry_count}".encode()).digest()
    jitter = int.from_bytes(digest[:2], "big") % max(1, base_seconds // 4 + 1)
    next_retry = datetime.now(timezone.utc) + timedelta(seconds=base_seconds + jitter)
    return {
        **current,
        "binding_id": binding_id,
        "last_error_code": code,
        "last_error": reason,
        "retry_count": retry_count,
        "next_retry_at": next_retry.isoformat().replace("+00:00", "Z"),
    }


def issue_order_key(issue: dict[str, Any]) -> tuple[str, str]:
    return str(issue.get("updatedAt") or ""), str(issue.get("id") or "")


def after_checkpoint(issue: dict[str, Any], state: dict[str, Any], mode: str) -> bool:
    if mode == "baseline":
        return True
    checkpoint_updated_at = str(state.get("checkpoint_updated_at") or "")
    return str(issue.get("updatedAt") or "") >= checkpoint_updated_at


def observation_and_event(
    installation: dict[str, Any],
    project: dict[str, Any],
    binding_id: str,
    issue: dict[str, Any],
    previous: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    issue_id = str(issue.get("id") or "")
    updated_at = str(issue.get("updatedAt") or "")
    if not issue_id or not updated_at:
        return None, None
    if previous and str(previous.get("last_updated_at") or "") > updated_at:
        return None, None
    delegated = _delegated_to_installation(issue, installation, project)
    prior_delegated = bool((previous or {}).get("delegated"))
    epoch = int((previous or {}).get("delegation_epoch") or 0)
    if delegated and not prior_delegated:
        epoch += 1
    observation = {
        "binding_id": binding_id,
        "issue_id": issue_id,
        "issue_identifier": str(issue.get("identifier") or ""),
        "delegated": delegated,
        "delegation_epoch": epoch,
        "last_updated_at": updated_at,
    }
    if not delegated or _parent_issue_id(issue) or _is_projection_issue(issue):
        return observation, None
    return observation, _event(installation, project, issue, epoch)


def _event(
    installation: dict[str, Any],
    project: dict[str, Any],
    issue: dict[str, Any],
    epoch: int,
) -> dict[str, Any]:
    issue_id = str(issue["id"])
    delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else {}
    return {
        "event_type": "linear.delegated_issue",
        "linear_organization_id": str(installation.get("linear_organization_id") or ""),
        "workspace_id": str(installation.get("user_id") or ""),
        "linear_project_id": str(project.get("linear_project_id") or ""),
        "project_slug": str(project.get("project_slug") or ""),
        "issue_id": issue_id,
        "issue_identifier": str(issue.get("identifier") or ""),
        "issue_title": str(issue.get("title") or ""),
        "issue_description": str(issue.get("description") or ""),
        "agent_app_user_id": str(installation.get("app_user_id") or ""),
        "issue_delegate_id": str(delegate.get("id") or ""),
        "blocked_by": _blocked_by_ids(issue),
        "parent_issue_id": "",
        "managed_run_intent": {},
        "intake_key": f"linear-issue:{issue_id}:epoch:{epoch}",
    }


def _delegated_to_installation(
    issue: dict[str, Any], installation: dict[str, Any], project: dict[str, Any]
) -> bool:
    delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else {}
    issue_project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    return bool(
        str(delegate.get("id") or "") == str(installation.get("app_user_id") or "")
        and str(issue_project.get("id") or "") == str(project.get("linear_project_id") or "")
    )


def _blocked_by_ids(issue: dict[str, Any]) -> list[str]:
    relations = issue.get("inverseRelations") if isinstance(issue.get("inverseRelations"), dict) else {}
    result: list[str] = []
    for relation in relations.get("nodes") or []:
        if not isinstance(relation, dict) or relation.get("type") != "blocks":
            continue
        blocker = relation.get("issue") if isinstance(relation.get("issue"), dict) else relation.get("relatedIssue")
        if isinstance(blocker, dict) and blocker.get("id"):
            result.append(str(blocker["id"]))
    return result


def _parent_issue_id(issue: dict[str, Any]) -> str:
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else {}
    return str(parent.get("id") or "")


def _is_projection_issue(issue: dict[str, Any]) -> bool:
    title = str(issue.get("title") or "").strip()
    description = str(issue.get("description") or "")
    return title.startswith("[Human Action]") or "symphony:run-summary:start" in description or "SYMPHONY WORK ITEM" in description


def _state_high_water(state: dict[str, Any]) -> tuple[str, str]:
    return (
        str(state.get("scan_high_water_updated_at") or state.get("checkpoint_updated_at") or ""),
        str(state.get("scan_high_water_issue_id") or state.get("checkpoint_issue_id") or ""),
    )
