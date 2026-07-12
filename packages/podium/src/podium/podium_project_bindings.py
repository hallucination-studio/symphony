from __future__ import annotations

import logging
from typing import Any

from .podium_project_binding_creation import (
    ProjectBindingError,
    build_project_binding,
    project_binding_conflict,
    repository_public as _repository_public,
)
from .podium_project_labels import LinearProjectLabelError
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)


class PodiumProjectBindingsMixin:
    async def bind_conductor_project(
        self,
        user_id: str,
        conductor_id: str,
        *,
        linear_project_id: str,
        repository: dict[str, Any],
        replacement_owner_binding_id: str = "",
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
        installation = await self.get_active_linear_installation(user_id)
        if installation is None:
            raise ProjectBindingError("linear_installation_required", "An active Linear installation is required")
        binding = build_project_binding(
            user_id,
            conductor_id,
            project=project,
            installation=installation,
            repository=repository,
            prior_bindings=prior_bindings,
        )
        created, conflict = await self.store.create_project_binding(
            binding,
            replacement_owner_binding_id=replacement_owner_binding_id,
        )
        if created is None:
            raise project_binding_conflict(conflict)
        binding = created
        await self.enqueue_runtime_command(conductor_id, self.project_binding_command(binding))
        return binding

    async def begin_project_unbind(
        self,
        user_id: str,
        conductor_id: str,
        replacement: dict[str, Any] | None = None,
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
        replacement = replacement or {}
        replacement_repo_source = replacement.get("replacement_repo_source")
        pending, command_created = await self.store.claim_project_unbind(
            str(active["id"]),
            user_id,
            conductor_id,
            replacement_conductor_id=str(replacement.get("replacement_conductor_id") or ""),
            replacement_repo_source=(replacement_repo_source if isinstance(replacement_repo_source, dict) else {}),
            updated_at=utc_now_iso(),
        )
        if pending is None:
            raise ProjectBindingError("project_binding_not_found", "Conductor has no project binding")
        if not pending.get("active", True):
            return pending, False
        if str(pending.get("state") or "") != "pending_unbind":
            replacement_target = str(replacement.get("replacement_conductor_id") or "")
            if replacement_target:
                target_bindings = await self.store.list_project_bindings_for_conductor(
                    replacement_target
                )
                if any(row.get("active", True) for row in target_bindings):
                    raise ProjectBindingError(
                        "replacement_conductor_already_bound",
                        "Replacement Conductor is already bound",
                    )
            LOGGER.warning(
                "event=project_unbind_blocked conductor_id=%s instance_id=%s linear_project_id=%s "
                "error_code=managed_runs_active sanitized_reason=%s action_required=drain retryable=true "
                "next_action=wait_for_managed_runs",
                conductor_id,
                pending.get("instance_id"),
                pending.get("linear_project_id"),
                "Managed Runs must finish before unbinding",
            )
            raise ProjectBindingError("managed_runs_active", "Managed Runs must finish before unbinding")
        if command_created:
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
            await self.advance_project_replacement(binding)
            return binding
        if str(binding.get("state") or "") != "pending_unbind" or version != int(binding.get("config_version") or 0):
            raise ProjectBindingError("project_unbind_version_mismatch", "Runtime unbind config version is stale")
        try:
            await self.remove_managed_project_label(binding)
        except LinearProjectLabelError as exc:
            failed = await self.store.record_project_unbind_error(
                binding_id,
                conductor_id=conductor_id,
                expected_state="pending_unbind",
                expected_config_version=version,
                error_code="linear_project_label_remove_failed",
                sanitized_reason="Linear project label removal failed",
                updated_at=utc_now_iso(),
            )
            if failed is None:
                raise ProjectBindingError(
                    "project_unbind_version_mismatch",
                    "Runtime unbind config version is stale",
                ) from exc
            raise ProjectBindingError(
                "linear_project_label_remove_failed",
                "Linear project label removal failed",
            ) from exc
        unbound = await self.store.complete_project_unbind(
            binding_id,
            conductor_id=conductor_id,
            expected_state="pending_unbind",
            expected_config_version=version,
            acknowledged_config_version=version,
            updated_at=utc_now_iso(),
        )
        if unbound is None:
            raise ProjectBindingError(
                "project_unbind_version_mismatch",
                "Runtime unbind config version is stale",
            )
        await self.advance_project_replacement(unbound)
        LOGGER.info(
            "event=project_unbound conductor_id=%s instance_id=%s linear_project_id=%s config_version=%s",
            conductor_id,
            unbound.get("instance_id"),
            unbound.get("linear_project_id"),
            version,
        )
        return unbound

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
        await self.complete_project_replacement(ready)
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
        failed = {
            **bindings[0],
            "state": "failed",
            "error_code": error.code,
            "sanitized_reason": error.reason,
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(failed)
        LOGGER.error(
            "event=project_binding_failed conductor_id=%s instance_id=%s linear_project_id=%s "
            "error_type=ProjectBindingError error_code=%s sanitized_reason=%s action_required=retry "
            "retryable=true next_action=retry_project_binding_report",
            conductor_id,
            failed.get("instance_id"),
            failed.get("linear_project_id"),
            error.code,
            error.reason,
        )
        await self.fail_project_replacement_for_binding(failed, error.code, error.reason)
