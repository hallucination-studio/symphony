from __future__ import annotations

from typing import Any


def managed_run_ack_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "run_id",
            "parent_issue_id",
            "active_work_item_id",
            "managed_run_state",
            "plan_version",
            "backend_session_id",
        )
    }


def linear_payload_is_mutation(payload: dict[str, Any]) -> bool:
    query = str(payload.get("query") or "").lstrip().lower()
    return query.startswith("mutation") or "\nmutation" in query


def linear_installation_actor_is_app(installation: dict[str, Any] | None) -> bool:
    if not isinstance(installation, dict):
        return False
    actor = str(installation.get("actor") or installation.get("token_actor") or "").strip().lower()
    return actor in {"app", "application"}


def normalize_agent_session_event(payload: dict[str, Any]) -> dict[str, Any]:
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    agent = session.get("agent") if isinstance(session.get("agent"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else payload.get("parent")
    managed_run_intent = _managed_run_intent(payload, issue)
    return {
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
        "issue_title": str(issue.get("title") or payload.get("issue_title") or payload.get("title") or ""),
        "issue_description": str(
            issue.get("description") or payload.get("issue_description") or payload.get("description") or ""
        ),
        "agent_session_id": str(session.get("id") or payload.get("agent_session_id") or ""),
        "agent_app_user_id": str(
            session.get("appUserId")
            or session.get("app_user_id")
            or agent.get("appUserId")
            or agent.get("app_user_id")
            or payload.get("appUserId")
            or payload.get("app_user_id")
            or payload.get("agent_app_user_id")
            or ""
        ),
        "issue_delegate_id": str(((issue.get("delegate") or {}) if isinstance(issue.get("delegate"), dict) else {}).get("id") or ""),
        "blocked_by": _issue_ref_ids(issue.get("blocked_by") or payload.get("blocked_by")),
        "parent_issue_id": _issue_ref_id(issue.get("parent_issue_id") or parent or payload.get("parent_issue_id")),
        "managed_run_intent": dict(managed_run_intent) if isinstance(managed_run_intent, dict) else {},
    }


def _managed_run_intent(payload: dict[str, Any], issue: dict[str, Any]) -> dict[str, Any]:
    managed_run_intent = payload.get("managed_run_intent")
    if not isinstance(managed_run_intent, dict):
        managed_run_intent = payload.get("intent")
    if not isinstance(managed_run_intent, dict):
        managed_run_intent = issue.get("managed_run_intent")
    if not isinstance(managed_run_intent, dict):
        managed_run_intent = issue.get("intent")
    return managed_run_intent if isinstance(managed_run_intent, dict) else {}


def _issue_ref_ids(value: Any) -> list[str]:
    if value is None:
        return []
    raw_items = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in raw_items:
        ref = _issue_ref_id(item)
        if ref:
            result.append(ref)
    return result


def _issue_ref_id(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("id") or value.get("issue_id") or value.get("identifier") or "").strip()
    return str(value or "").strip()
