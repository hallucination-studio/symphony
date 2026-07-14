from __future__ import annotations

from typing import Any

from .podium_shared import utc_now_iso


class ProjectBindingError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def build_project_binding(
    user_id: str,
    conductor_id: str,
    *,
    project: dict[str, Any],
    installation: dict[str, Any],
    repository: dict[str, Any],
    prior_bindings: list[dict[str, Any]],
) -> dict[str, Any]:
    repository_mode, repository_value = repository_details(repository)
    return {
        "id": f"binding_{conductor_id}",
        "conductor_id": conductor_id,
        "user_id": user_id,
        "instance_id": "",
        "name": str(project.get("project_name") or ""),
        "linear_project": str(project.get("project_slug") or ""),
        "linear_project_id": str(project.get("linear_project_id") or ""),
        "project_name": str(project.get("project_name") or ""),
        "project_slug": str(project.get("project_slug") or ""),
        "agent_app_user_id": str(installation.get("app_user_id") or ""),
        "installation_id": str(installation.get("id") or ""),
        "process_status": "",
        "constraint_labels": [],
        "repo_source": {
            "type": "git" if repository_mode == "git_url" else "local_path",
            "value": repository_value,
        },
        "state": "pending_ack",
        "active": True,
        "config_version": max(
            (int(row.get("config_version") or 0) for row in prior_bindings),
            default=0,
        ) + 1,
        "acknowledged_config_version": 0,
        "candidate_installation_id": "",
        "candidate_agent_app_user_id": "",
        "candidate_config_version": 0,
        "candidate_acknowledged_config_version": 0,
        "performer_binding_id": "",
        "label_id": "",
        "label_name": "",
        "replacement_conductor_id": "",
        "replacement_repo_source": {},
        "replacement_state": "",
        "replacement_binding_id": "",
        "error_code": "",
        "sanitized_reason": "",
        "updated_at": utc_now_iso(),
    }


def project_binding_conflict(code: str) -> ProjectBindingError:
    reasons = {
        "replacement_conductor_reserved": "Conductor is reserved by an active project replacement",
        "conductor_already_bound": "Conductor already has a project binding",
        "linear_project_already_bound": "Linear project already has an active Conductor",
        "linear_project_not_selected": "Linear project is not selected",
    }
    return ProjectBindingError(code, reasons.get(code, "Project binding conflict"))


def repository_details(raw: dict[str, Any]) -> tuple[str, str]:
    mode = str(raw.get("mode") or "") if isinstance(raw, dict) else ""
    value = str(raw.get("value") or "").strip() if isinstance(raw, dict) else ""
    if mode not in {"local_path", "git_url"} or not value:
        raise ProjectBindingError("invalid_repository", "Repository mode and value are required")
    if mode == "git_url" and not value.startswith(("https://", "git@")):
        raise ProjectBindingError("invalid_repository", "Git repository URL is invalid")
    return mode, value


def repository_public(raw: Any) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    source_type = str(source.get("type") or source.get("mode") or "")
    return {
        "mode": "git_url" if source_type == "git" else source_type,
        "value": str(source.get("value") or ""),
    }
