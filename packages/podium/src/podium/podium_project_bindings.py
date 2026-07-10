from __future__ import annotations

from typing import Any

from .podium_shared import utc_now_iso


class ProjectBindingError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumProjectBindingsMixin:
    async def bind_conductor_project(
        self,
        user_id: str,
        conductor_id: str,
        *,
        linear_project_id: str,
        repository: dict[str, Any],
    ) -> dict[str, Any]:
        conductor = await self.conductor_for_user(conductor_id, user_id)
        if conductor is None:
            raise ProjectBindingError("conductor_not_found", "Conductor not found")
        if conductor.get("enrollment_state") != "enrolled":
            raise ProjectBindingError("conductor_not_enrolled", "Conductor is not enrolled")
        if not await self.is_runtime_online(conductor_id):
            raise ProjectBindingError("conductor_offline", "Conductor must be online before binding")
        if await self.store.list_project_bindings_for_conductor(conductor_id):
            raise ProjectBindingError("conductor_already_bound", "Conductor already has a project binding")
        selected = {
            str(row.get("linear_project_id") or ""): row
            for row in await self.list_selected_linear_projects(user_id)
        }
        project = selected.get(linear_project_id)
        if project is None:
            raise ProjectBindingError("linear_project_not_selected", "Linear project is not selected")
        existing = await self.store.get_active_project_binding_for_project(user_id, linear_project_id)
        if existing is not None:
            raise ProjectBindingError("linear_project_already_bound", "Linear project already has an active Conductor")
        repository_mode, repository_value = _repository(repository)
        installation = await self.get_active_linear_installation(user_id)
        if installation is None:
            raise ProjectBindingError("linear_installation_required", "An active Linear installation is required")
        binding = {
            "id": f"binding_{conductor_id}",
            "conductor_id": conductor_id,
            "user_id": user_id,
            "instance_id": "",
            "name": str(project.get("project_name") or ""),
            "linear_project": str(project.get("project_slug") or ""),
            "linear_project_id": linear_project_id,
            "project_name": str(project.get("project_name") or ""),
            "project_slug": str(project.get("project_slug") or ""),
            "agent_app_user_id": str(installation.get("app_user_id") or ""),
            "installation_id": str(installation.get("id") or ""),
            "managed_run_profile": "default",
            "process_status": "",
            "constraint_labels": [],
            "repo_source": {
                "type": "git" if repository_mode == "git_url" else "local_path",
                "value": repository_value,
            },
            "state": "pending_ack",
            "active": True,
            "config_version": 1,
            "acknowledged_config_version": 0,
            "candidate_installation_id": "",
            "candidate_agent_app_user_id": "",
            "candidate_config_version": 0,
            "candidate_acknowledged_config_version": 0,
            "label_id": "",
            "label_name": "",
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(binding)
        await self.enqueue_runtime_command(conductor_id, self.project_binding_command(binding))
        return binding

    def project_binding_command(self, binding: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "project.configure",
            "binding_id": str(binding["id"]),
            "config_version": int(binding.get("config_version") or 0),
            "linear_project_id": str(binding.get("linear_project_id") or ""),
            "project_slug": str(binding.get("project_slug") or ""),
            "project_name": str(binding.get("project_name") or ""),
            "agent_app_user_id": str(binding.get("agent_app_user_id") or ""),
            "repository": _repository_public(binding.get("repo_source")),
        }

    async def acknowledge_project_binding(
        self,
        conductor_id: str,
        report: dict[str, Any],
    ) -> dict[str, Any]:
        bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        if not bindings:
            raise ProjectBindingError("unexpected_project_binding", "Conductor has no assigned project")
        binding = bindings[0]
        checks = {
            "linear_project_id": str(report.get("linear_project_id") or ""),
            "agent_app_user_id": str(report.get("agent_app_user_id") or ""),
        }
        for key, actual in checks.items():
            if actual != str(binding.get(key) or ""):
                raise ProjectBindingError("project_binding_mismatch", f"Runtime {key} does not match assigned project")
        version = int(report.get("binding_config_version") or 0)
        if version != int(binding.get("config_version") or 0):
            raise ProjectBindingError("project_binding_version_mismatch", "Runtime binding config version is stale")
        if _repository_public(report.get("repo_source")) != _repository_public(binding.get("repo_source")):
            raise ProjectBindingError("project_repository_mismatch", "Runtime repository does not match assigned repository")
        ready = {
            **binding,
            "instance_id": str(report.get("instance_id") or ""),
            "process_status": str(report.get("process_status") or ""),
            "state": "ready",
            "acknowledged_config_version": version,
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(ready)
        await self._mark_onboarding(str(binding.get("user_id") or ""), "repository_mapping")
        return ready

    async def acknowledge_candidate_installation(
        self,
        conductor_id: str,
        report: dict[str, Any],
    ) -> None:
        prepared_id = str(report.get("prepared_installation_id") or "")
        if not prepared_id:
            return
        bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        if not bindings:
            raise ProjectBindingError("unexpected_project_binding", "Conductor has no assigned project")
        binding = bindings[0]
        version = int(report.get("prepared_binding_config_version") or 0)
        if (
            prepared_id != str(binding.get("candidate_installation_id") or "")
            or version != int(binding.get("candidate_config_version") or 0)
        ):
            raise ProjectBindingError(
                "installation_prepare_mismatch",
                "Runtime prepared installation does not match candidate",
            )
        await self.store.upsert_project_binding(
            {
                **binding,
                "candidate_acknowledged_config_version": version,
                "updated_at": utc_now_iso(),
            }
        )

    async def fail_project_binding(
        self,
        conductor_id: str,
        error: ProjectBindingError,
    ) -> None:
        bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        if not bindings:
            return
        await self.store.upsert_project_binding(
            {
                **bindings[0],
                "state": "failed",
                "error_code": error.code,
                "sanitized_reason": error.reason,
                "updated_at": utc_now_iso(),
            }
        )


def _repository(raw: dict[str, Any]) -> tuple[str, str]:
    mode = str(raw.get("mode") or "") if isinstance(raw, dict) else ""
    value = str(raw.get("value") or "").strip() if isinstance(raw, dict) else ""
    if mode not in {"local_path", "git_url"} or not value:
        raise ProjectBindingError("invalid_repository", "Repository mode and value are required")
    if mode == "git_url" and not value.startswith(("https://", "git@")):
        raise ProjectBindingError("invalid_repository", "Git repository URL is invalid")
    return mode, value


def _repository_public(raw: Any) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    source_type = str(source.get("type") or source.get("mode") or "")
    return {
        "mode": "git_url" if source_type == "git" else source_type,
        "value": str(source.get("value") or ""),
    }
