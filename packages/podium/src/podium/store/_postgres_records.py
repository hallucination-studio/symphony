from __future__ import annotations

from datetime import datetime
import json
from typing import Any


def _record_to_user(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "email": str(row["email"]),
        "password_hash": str(row["password_hash"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "linear_app": _pg_json_value(row["linear_app_json"], None),
    }


def _record_to_runtime_group(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "linear_workspace_id": str(row["linear_workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "linear_agent_app_user_id": str(row["linear_agent_app_user_id"]),
        "pipeline_profile": str(row["pipeline_profile"]),
        "project_binding_id": str(row["project_binding_id"]),
    }


def _record_to_runtime(row: Any) -> dict[str, Any]:
    user_id = str(row["user_id"])
    return {
        "id": str(row["id"]),
        "runtime_group_id": str(row["runtime_group_id"] or f"group_{user_id}"),
        "user_id": user_id,
        "runtime_token_hash": str(row["runtime_token_hash"]),
        "proxy_token_hash": str(row["proxy_token_hash"]),
        "disabled": bool(row["disabled"]),
        "revoked": bool(row["revoked"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "hostname": str(row["hostname"]),
        "label": str(row["label"]),
        "version": str(row["version"]),
    }


def _record_to_conductor(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "user_id": str(row["user_id"]),
        "hostname": str(row["hostname"]),
        "label": str(row["label"]),
        "version": str(row["version"]),
        "conductor_id": str(row["conductor_id"]),
        "runtime_group_id": str(row["runtime_group_id"] or f"group_{row['user_id']}"),
        "runtime_token_hash": str(row["runtime_token_hash"]),
        "proxy_token_hash": str(row["proxy_token_hash"]),
        "disabled": bool(row["disabled"]),
        "revoked": bool(row["revoked"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "last_report_at": row["last_report_at"].isoformat() if row["last_report_at"] is not None else None,
    }


def _record_to_project_binding(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "conductor_id": str(row["conductor_id"]),
        "user_id": str(row["user_id"]),
        "instance_id": str(row["instance_id"]),
        "name": str(row["name"]),
        "linear_project": str(row["linear_project"]),
        "project_slug": str(row["project_slug"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "pipeline_profile": str(row["pipeline_profile"]),
        "process_status": str(row["process_status"]),
        "constraint_labels": list(_pg_json_value(row["constraint_labels"], [])),
        "repo_source": _pg_json_value(row["repo_source"], {}),
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else "",
    }


def _record_to_dispatch(row: Any) -> dict[str, Any]:
    return {
        "dispatch_id": str(row["id"]),
        "project_binding_id": str(row["project_binding_id"]),
        "user_id": str(row["user_id"]),
        "issue_id": str(row["issue_id"]),
        "issue_identifier": str(row["issue_identifier"]),
        "issue_title": str(row["issue_title"]),
        "issue_description": str(row["issue_description"]),
        "pipeline_intent": _pg_json_value(row["pipeline_intent"], {}),
        "linear_workspace_id": str(row["workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "agent_session_id": str(row["agent_session_id"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "issue_delegate_id": str(row["issue_delegate_id"]),
        "status": str(row["status"]),
        "reason": str(row["reason"]),
        "leased_runtime_id": row["leased_conductor_id"],
        "leased_conductor_id": row["leased_conductor_id"],
        "leased_until": row["leased_until"].isoformat() if row["leased_until"] is not None else None,
        "fencing_token": int(row["fencing_token"] or 0),
        "graph_id": str(row["graph_id"]),
        "node_id": str(row["node_id"]),
        "attempt_id": str(row["attempt_id"]),
        "mode": str(row["mode"]),
        "attempt_status": str(row["attempt_status"]),
        "graph_revision": int(row["graph_revision"] or 0),
        "policy_revision": int(row["policy_revision"] or 0),
        "lease_id": str(row["lease_id"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else "",
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] is not None else None,
    }


def _record_to_runtime_command(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "runtime_id": str(row["runtime_id"]),
        "command": dict(_pg_json_value(row["command_json"], {})),
        "created_at": row["created_at"].isoformat() if row["created_at"] is not None else "",
    }


def _pg_datetime(value: Any) -> datetime | None:
    if value in {None, ""}:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    raise TypeError(f"expected datetime-compatible value, got {type(value).__name__}")


def _pg_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _pg_json_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def _row_count(result: str) -> int:
    try:
        return int(str(result).rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return 0
