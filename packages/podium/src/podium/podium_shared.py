from __future__ import annotations

import base64
import hashlib
import shlex
from datetime import datetime, timezone
from typing import Any

from cryptography.fernet import Fernet

def dispatch_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    project_binding_id = str(dispatch.get("project_binding_id") or dispatch.get("runtime_group_id") or "")
    payload = {
        "dispatch_id": dispatch["dispatch_id"],
        "project_binding_id": project_binding_id,
        "instance_id": str(dispatch.get("instance_id") or "")
        or (project_binding_id.split(":", 1)[1] if ":" in project_binding_id else ""),
        "issue_id": dispatch["issue_id"],
        "issue_identifier": dispatch["issue_identifier"],
        "issue_title": dispatch.get("issue_title") or "",
        "issue_description": dispatch.get("issue_description") or "",
        "linear_workspace_id": dispatch["linear_workspace_id"],
        "project_slug": dispatch["project_slug"],
        "agent_app_user_id": dispatch.get("agent_app_user_id") or "",
        "routing_rule_id": dispatch.get("routing_rule_id") or project_binding_id,
        "managed_run_profile": dispatch.get("managed_run_profile") or "default",
        "blocked_by": list(dispatch.get("blocked_by") or []),
        "parent_issue_id": dispatch.get("parent_issue_id") or "",
        "status": dispatch["status"],
        "fencing_token": int(dispatch.get("fencing_token") or 0),
        "reason": dispatch.get("reason") or "",
    }
    managed_run_intent = dispatch.get("managed_run_intent")
    if isinstance(managed_run_intent, dict):
        payload["managed_run_intent"] = managed_run_intent
    for key in (
        "run_id",
        "parent_issue_id",
        "active_work_item_id",
        "plan_version",
        "backend_session_id",
    ):
        if dispatch.get(key) not in {None, ""}:
            payload[key] = dispatch[key]
    managed_run_state = dispatch.get("managed_run_state")
    if managed_run_state not in {None, ""}:
        payload["managed_run_state"] = managed_run_state
    return payload

def sanitize_runtime_config(value: Any, *, hide_runtime_sources: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    payload = dict(value)
    profiles = payload.get("profiles")
    if isinstance(profiles, dict):
        payload["profiles"] = {
            str(role): {
                **(profile if isinstance(profile, dict) else {}),
                "role": str((profile or {}).get("role") or role) if isinstance(profile, dict) else str(role),
                "settings": _sanitize_profile_settings(
                    profile.get("settings") if isinstance(profile, dict) and isinstance(profile.get("settings"), dict) else {},
                    hide_runtime_sources=hide_runtime_sources,
                ),
            }
            for role, profile in profiles.items()
        }
    return payload

def _sanitize_profile_settings(settings: dict[str, Any], *, hide_runtime_sources: bool = False) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, value in settings.items():
        lowered = str(key).lower()
        if hide_runtime_sources and lowered in {"codex_home_source"}:
            continue
        if any(marker in lowered for marker in ("token", "secret", "password", "cookie", "api_key", "apikey")):
            continue
        sanitized[str(key)] = value
    return sanitized

def runtime_belongs_to_workspace(
    runtime: dict[str, Any],
    workspace_id: str,
    runtime_groups: dict[str, dict[str, Any]],
) -> bool:
    group_id = str(runtime.get("runtime_group_id") or "")
    return group_id == f"group_{workspace_id}" or str(
        runtime_groups.get(group_id, {}).get("linear_workspace_id") or ""
    ) == workspace_id

def dispatch_belongs_to_workspace(
    dispatch: dict[str, Any],
    workspace_id: str,
    runtime_groups: dict[str, dict[str, Any]],
) -> bool:
    group_id = str(dispatch.get("runtime_group_id") or "")
    return group_id == f"group_{workspace_id}" or str(
        runtime_groups.get(group_id, {}).get("linear_workspace_id") or ""
    ) == workspace_id

def runtime_public(runtime: dict[str, Any], presence: dict[str, str]) -> dict[str, Any]:
    runtime_id = str(runtime["id"])
    metadata = runtime.get("metadata")
    return {
        "runtime_id": runtime_id,
        "online": runtime_id in presence,
        "last_heartbeat": presence.get(runtime_id),
        "version": runtime.get("version"),
        "metadata": metadata if isinstance(metadata, dict) else {},
    }

def run_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    status = run_status_from_dispatch(str(dispatch.get("status") or "queued"))
    completed_at = dispatch.get("completed_at")
    if completed_at is None and status in {"success", "failed", "cancelled"}:
        completed_at = dispatch.get("updated_at") or dispatch.get("created_at")
    return {
        "run_id": str(dispatch["dispatch_id"]),
        "issue_identifier": dispatch.get("issue_identifier"),
        "runtime_id": dispatch.get("leased_runtime_id"),
        "status": status,
        "started_at": dispatch.get("created_at"),
        "completed_at": completed_at,
        "duration_seconds": dispatch.get("duration_seconds"),
        "failure_reason": dispatch.get("reason") if status == "failed" else None,
    }

def run_status_from_dispatch(status: str) -> str:
    if status in {"queued"}:
        return "pending"
    if status in {"leased", "accepted", "running"}:
        return "running"
    if status in {"completed", "success", "succeeded"}:
        return "success"
    if status in {"cancelled", "canceled"}:
        return "cancelled"
    if status in {"failed", "error"}:
        return "failed"
    return "running"

def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()

def bearer_token(authorization: str) -> str:
    return authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else authorization.strip()

def optional_int(value: Any, default: int | None) -> int | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def query_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _datetime_to_json(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return value


def _datetime_from_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed
