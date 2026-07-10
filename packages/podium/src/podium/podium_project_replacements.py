from __future__ import annotations

import logging
from typing import Any

from .podium_project_bindings import ProjectBindingError, _repository, _repository_public
from .podium_shared import utc_now_iso


LOGGER = logging.getLogger(__name__)


class ProjectReplacementError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumProjectReplacementsMixin:
    async def start_project_replacement(
        self,
        user_id: str,
        new_conductor_id: str,
        *,
        old_conductor_id: str,
        linear_project_id: str,
        repository: dict[str, Any],
    ) -> dict[str, Any]:
        if not old_conductor_id or old_conductor_id == new_conductor_id:
            raise ProjectReplacementError("invalid_replacement_conductor", "Replacement requires two Conductors")
        old_binding = await self.store.get_active_project_binding_for_project(user_id, linear_project_id)
        if old_binding is None or str(old_binding.get("conductor_id") or "") != old_conductor_id:
            raise ProjectReplacementError("replacement_binding_not_found", "Active project binding was not found")
        existing_target = str(old_binding.get("replacement_conductor_id") or "")
        if existing_target and existing_target != new_conductor_id:
            raise ProjectReplacementError("replacement_in_progress", "Project replacement already has another target")
        if existing_target:
            return old_binding
        if str(old_binding.get("state") or "") not in {"ready", "pending_unbind"}:
            raise ProjectReplacementError("project_binding_not_ready", "Active project binding is not ready")
        new_conductor = await self.conductor_for_user(new_conductor_id, user_id)
        if new_conductor is None:
            raise ProjectReplacementError("conductor_not_found", "Replacement Conductor was not found")
        if new_conductor.get("enrollment_state") != "enrolled" or not await self.is_runtime_online(new_conductor_id):
            raise ProjectReplacementError("replacement_conductor_not_ready", "Replacement Conductor must be online")
        new_bindings = await self.store.list_project_bindings_for_conductor(new_conductor_id)
        if any(row.get("active", True) for row in new_bindings):
            raise ProjectReplacementError("replacement_conductor_already_bound", "Replacement Conductor is already bound")
        mode, value = _repository(repository)
        replacement = {
            "replacement_conductor_id": new_conductor_id,
            "replacement_repo_source": {
                "type": "git" if mode == "git_url" else "local_path",
                "value": value,
            },
            "replacement_state": "pending_unbind",
            "replacement_binding_id": "",
        }
        pending, _ = await self.begin_project_unbind(
            user_id,
            old_conductor_id,
            replacement=replacement,
        )
        LOGGER.info(
            "event=project_replacement_started conductor_id=%s replacement_conductor_id=%s "
            "linear_project_id=%s config_version=%s",
            old_conductor_id,
            new_conductor_id,
            linear_project_id,
            pending.get("config_version"),
        )
        return pending

    async def advance_project_replacement(self, old_binding: dict[str, Any]) -> dict[str, Any] | None:
        new_conductor_id = str(old_binding.get("replacement_conductor_id") or "")
        if not new_conductor_id:
            return None
        replacement_binding_id = str(old_binding.get("replacement_binding_id") or "")
        if replacement_binding_id:
            return await self.store.get_project_binding(replacement_binding_id)
        try:
            new_binding = await self._recover_replacement_binding(old_binding)
            if new_binding is None:
                new_binding = await self.bind_conductor_project(
                    str(old_binding.get("user_id") or ""),
                    new_conductor_id,
                    linear_project_id=str(old_binding.get("linear_project_id") or ""),
                    repository=_repository_public(old_binding.get("replacement_repo_source")),
                )
        except ProjectBindingError as exc:
            await self._fail_project_replacement(old_binding, exc.code, exc.reason)
            raise
        updated = {
            **old_binding,
            "replacement_state": "pending_ack",
            "replacement_binding_id": str(new_binding["id"]),
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(updated)
        if str(new_binding.get("state") or "") == "ready":
            await self.complete_project_replacement(new_binding)
        return new_binding

    async def _recover_replacement_binding(self, old_binding: dict[str, Any]) -> dict[str, Any] | None:
        target_id = str(old_binding.get("replacement_conductor_id") or "")
        bindings = await self.store.list_project_bindings_for_conductor(target_id)
        active = next((row for row in bindings if row.get("active", True)), None)
        if active is None:
            return None
        expected = (
            str(old_binding.get("user_id") or ""),
            str(old_binding.get("linear_project_id") or ""),
            _repository_public(old_binding.get("replacement_repo_source")),
        )
        actual = (
            str(active.get("user_id") or ""),
            str(active.get("linear_project_id") or ""),
            _repository_public(active.get("repo_source")),
        )
        if actual != expected:
            raise ProjectBindingError("conductor_already_bound", "Conductor already has a project binding")
        LOGGER.info(
            "event=project_replacement_binding_recovered conductor_id=%s replacement_conductor_id=%s "
            "linear_project_id=%s project_binding_id=%s",
            old_binding.get("conductor_id"),
            target_id,
            old_binding.get("linear_project_id"),
            active.get("id"),
        )
        return active

    async def complete_project_replacement(self, new_binding: dict[str, Any]) -> None:
        old_binding = await self.store.get_project_binding_replacement_for_new_binding(str(new_binding["id"]))
        if old_binding is None or str(old_binding.get("replacement_state") or "") == "ready":
            return
        ready = {
            **old_binding,
            "replacement_state": "ready",
            "error_code": "",
            "sanitized_reason": "",
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(ready)
        LOGGER.info(
            "event=project_replacement_completed conductor_id=%s replacement_conductor_id=%s "
            "linear_project_id=%s project_binding_id=%s",
            old_binding.get("conductor_id"),
            old_binding.get("replacement_conductor_id"),
            old_binding.get("linear_project_id"),
            new_binding.get("id"),
        )

    async def fail_project_replacement_for_binding(
        self,
        new_binding: dict[str, Any],
        code: str,
        reason: str,
    ) -> None:
        old_binding = await self.store.get_project_binding_replacement_for_new_binding(str(new_binding["id"]))
        if old_binding is not None and str(old_binding.get("replacement_state") or "") != "ready":
            await self._fail_project_replacement(old_binding, code, reason)

    async def project_replacement_for_conductor(
        self,
        user_id: str,
        conductor_id: str,
    ) -> dict[str, Any] | None:
        row = await self.store.get_project_binding_replacement_for_conductor(user_id, conductor_id)
        return replacement_public(row) if row is not None else None

    async def _fail_project_replacement(self, binding: dict[str, Any], code: str, reason: str) -> None:
        failed = {
            **binding,
            "replacement_state": "failed",
            "error_code": code,
            "sanitized_reason": reason,
            "updated_at": utc_now_iso(),
        }
        await self.store.upsert_project_binding(failed)
        LOGGER.error(
            "event=project_replacement_failed conductor_id=%s replacement_conductor_id=%s "
            "linear_project_id=%s error_type=ProjectBindingError error_code=%s sanitized_reason=%s "
            "action_required=retry retryable=true next_action=retry_project_replacement",
            binding.get("conductor_id"),
            binding.get("replacement_conductor_id"),
            binding.get("linear_project_id"),
            code,
            reason,
        )


def replacement_public(binding: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": str(binding.get("replacement_state") or ""),
        "old_binding_id": str(binding.get("id") or ""),
        "old_conductor_id": str(binding.get("conductor_id") or ""),
        "new_conductor_id": str(binding.get("replacement_conductor_id") or ""),
        "linear_project_id": str(binding.get("linear_project_id") or ""),
        "new_binding_id": str(binding.get("replacement_binding_id") or ""),
        "error_code": str(binding.get("error_code") or ""),
        "sanitized_reason": str(binding.get("sanitized_reason") or ""),
    }
