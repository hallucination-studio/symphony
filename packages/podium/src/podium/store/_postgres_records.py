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
    }


def _record_to_runtime_group(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "linear_workspace_id": str(row["linear_workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "linear_agent_app_user_id": str(row["linear_agent_app_user_id"]),
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
        "name": str(row["name"]),
        "public_id": str(row["public_id"]),
        "enrollment_state": str(row["enrollment_state"]),
        "service_identity": str(row["service_identity"]),
        "data_root": str(row["data_root"]),
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
        "name": str(row["name"]),
        "public_id": str(row["public_id"]),
        "enrollment_state": str(row["enrollment_state"]),
        "service_identity": str(row["service_identity"]),
        "data_root": str(row["data_root"]),
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
        "linear_project_id": str(row["linear_project_id"]),
        "project_name": str(row["project_name"]),
        "project_slug": str(row["project_slug"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "installation_id": str(row["installation_id"]),
        "process_status": str(row["process_status"]),
        "constraint_labels": list(_pg_json_value(row["constraint_labels"], [])),
        "repo_source": _pg_json_value(row["repo_source"], {}),
        "state": str(row["state"]),
        "active": bool(row["active"]),
        "config_version": int(row["config_version"]),
        "acknowledged_config_version": int(row["acknowledged_config_version"]),
        "candidate_installation_id": str(row["candidate_installation_id"]),
        "candidate_agent_app_user_id": str(row["candidate_agent_app_user_id"]),
        "candidate_config_version": int(row["candidate_config_version"]),
        "candidate_acknowledged_config_version": int(row["candidate_acknowledged_config_version"]),
        "label_id": str(row["label_id"]),
        "label_name": str(row["label_name"]),
        "replacement_conductor_id": str(row["replacement_conductor_id"]),
        "replacement_repo_source": _pg_json_value(row["replacement_repo_source"], {}),
        "replacement_state": str(row["replacement_state"]),
        "replacement_binding_id": str(row["replacement_binding_id"]),
        "error_code": str(row["error_code"]),
        "sanitized_reason": str(row["sanitized_reason"]),
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] is not None else "",
    }


def _record_to_dispatch(row: Any) -> dict[str, Any]:
    blocked_by = _pg_json_value(row["blocked_by"], [])
    return {
        "dispatch_id": str(row["id"]),
        "project_binding_id": str(row["project_binding_id"]),
        "user_id": str(row["user_id"]),
        "issue_id": str(row["issue_id"]),
        "issue_identifier": str(row["issue_identifier"]),
        "issue_title": str(row["issue_title"]),
        "issue_description": str(row["issue_description"]),
        "managed_run_intent": _pg_json_value(row["managed_run_intent"], {}),
        "intake_key": str(row["intake_key"]),
        "linear_workspace_id": str(row["workspace_id"]),
        "project_slug": str(row["project_slug"]),
        "agent_app_user_id": str(row["agent_app_user_id"]),
        "issue_delegate_id": str(row["issue_delegate_id"]),
        "blocked_by": [item for item in blocked_by if isinstance(item, str) and item] if isinstance(blocked_by, list) else [],
        "status": str(row["status"]),
        "reason": str(row["reason"]),
        "leased_runtime_id": row["leased_conductor_id"],
        "leased_conductor_id": row["leased_conductor_id"],
        "leased_until": row["leased_until"].isoformat() if row["leased_until"] is not None else None,
        "fencing_token": int(row["fencing_token"] or 0),
        "run_id": str(row["run_id"]),
        "parent_issue_id": str(row["parent_issue_id"]),
        "active_work_item_id": str(row["active_work_item_id"]),
        "managed_run_state": str(row["managed_run_state"]),
        "plan_version": int(row["plan_version"] or 0),
        "backend_session_id": str(row["backend_session_id"]),
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
        "status": str(row["status"] or "queued"),
        "lease_expires_at": row["lease_expires_at"].isoformat() if row["lease_expires_at"] is not None else None,
        "fencing_token": int(row["fencing_token"] or 0),
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] is not None else None,
        "result": dict(_pg_json_value(row["result_json"], {})),
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
