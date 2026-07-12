from __future__ import annotations

import base64
import hashlib
import shlex
from datetime import datetime, timezone
from typing import Any

from cryptography.fernet import Fernet

def dispatch_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    project_binding_id = str(dispatch.get("project_binding_id") or "")
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

def runtime_group_alias(conductor_id: str) -> str:
    return f"group_{conductor_id}"

def managed_run_view_matches_binding(view: Any, binding: dict[str, Any]) -> bool:
    if not isinstance(view, dict):
        return False
    if str(view.get("binding_id") or "") != str(binding.get("id") or ""):
        return False
    try:
        return int(view.get("binding_config_version") or 0) == int(binding.get("config_version") or 0)
    except (TypeError, ValueError):
        return False

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

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
