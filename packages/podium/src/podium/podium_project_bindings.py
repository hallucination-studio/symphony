from __future__ import annotations

import logging
from typing import Any

from .podium_project_labels import LinearProjectLabelError
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)


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
        prior_bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        if any(row.get("active", True) for row in prior_bindings):
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
            "config_version": max((int(row.get("config_version") or 0) for row in prior_bindings), default=0) + 1,
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

    async def begin_project_unbind(
        self,
        user_id: str,
        conductor_id: str,
    ) -> tuple[dict[str, Any], bool]:
        conductor = await self.conductor_for_user(conductor_id, user_id)
        if conductor is None:
            raise ProjectBindingError("conductor_not_found", "Conductor not found")
        bindings = await self.store.list_project_bindings_for_conductor(conductor_id)
        active = next((row for row in bindings if row.get("active", True)), None)
        if active is None:
            previous = bindings[-1] if bindings else None
            if previous is None:
                raise ProjectBindingError("project_binding_not_found", "Conductor has no project binding")
            return previous, False
        if str(active.get("state") or "") == "pending_unbind":
            return active, True
        if await self.store.count_open_dispatches_for_binding(str(active["id"])):
            LOGGER.warning(
                "event=project_unbind_blocked conductor_id=%s instance_id=%s linear_project_id=%s "
                "error_code=managed_runs_active sanitized_reason=%s action_required=drain retryable=true "
                "next_action=wait_for_managed_runs",
                conductor_id,
                active.get("instance_id"),
                active.get("linear_project_id"),
                "Managed Runs must finish before unbinding",
            )
            raise ProjectBindingError("managed_runs_active", "Managed Runs must finish before unbinding")
        pending = {
            **active,
            "state": "pending_unbind",
            "config_version": int(active.get("config_version") or 0) + 1,
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(pending)
        await self.enqueue_runtime_command(
            conductor_id,
            {
                "type": "project.unconfigure",
                "binding_id": str(pending["id"]),
                "config_version": int(pending["config_version"]),
                "delete_repository": False,
            },
        )
        LOGGER.info(
            "event=project_unbind_requested conductor_id=%s instance_id=%s linear_project_id=%s "
            "config_version=%s",
            conductor_id,
            pending.get("instance_id"),
            pending.get("linear_project_id"),
            pending.get("config_version"),
        )
        return pending, True

    async def acknowledge_project_unbind(
        self,
        conductor_id: str,
        report: dict[str, Any],
    ) -> dict[str, Any]:
        binding_id = str(report.get("unbound_binding_id") or "")
        version = int(report.get("unbound_config_version") or 0)
        binding = await self.store.get_project_binding(binding_id)
        if binding is None or str(binding.get("conductor_id") or "") != conductor_id:
            raise ProjectBindingError("project_unbind_mismatch", "Runtime unbind does not match its Conductor")
        if not binding.get("active", True) and str(binding.get("state") or "") == "unbound":
            return binding
        if str(binding.get("state") or "") != "pending_unbind" or version != int(binding.get("config_version") or 0):
            raise ProjectBindingError("project_unbind_version_mismatch", "Runtime unbind config version is stale")
        try:
            await self.remove_managed_project_label(binding)
        except LinearProjectLabelError as exc:
            failed = {
                **binding,
                "error_code": "linear_project_label_remove_failed",
                "sanitized_reason": "Linear project label removal failed",
                "updated_at": utc_now_iso(),
            }
            await self.store.upsert_project_binding(failed)
            raise ProjectBindingError(
                "linear_project_label_remove_failed",
                "Linear project label removal failed",
            ) from exc
        unbound = {
            **binding,
            "state": "unbound",
            "active": False,
            "acknowledged_config_version": version,
            "process_status": "",
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(unbound)
        await self._clear_runtime_group_binding(conductor_id)
        LOGGER.info(
            "event=project_unbound conductor_id=%s instance_id=%s linear_project_id=%s config_version=%s",
            conductor_id,
            unbound.get("instance_id"),
            unbound.get("linear_project_id"),
            version,
        )
        return unbound

    async def _clear_runtime_group_binding(self, conductor_id: str) -> None:
        conductor = await self.store.get_runtime(conductor_id)
        group_id = str((conductor or {}).get("runtime_group_id") or "")
        group = await self.store.get_runtime_group(group_id)
        if group is None:
            return
        await self.store.upsert_runtime_group(
            {
                **group,
                "project_slug": "",
                "linear_agent_app_user_id": "",
                "project_binding_id": "",
            }
        )

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
        try:
            ready = await self.ensure_managed_project_label(ready)
        except LinearProjectLabelError as exc:
            raise ProjectBindingError(
                "linear_project_label_sync_failed",
                "Linear project label operation failed",
            ) from exc
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
