from __future__ import annotations

from typing import Any

from .linear_token_service import LinearTokenUnavailable
from .podium_shared import managed_run_view_matches_binding, utc_now_iso


class LinearCutoverError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumLinearCutoverMixin:
    async def advance_linear_installation_cutover(self, user_id: str) -> dict[str, Any]:
        active = await self.get_active_linear_installation(user_id)
        candidate = await self.get_candidate_linear_installation(user_id)
        if active is None or candidate is None:
            raise LinearCutoverError("linear_cutover_not_available", "No replacement installation is waiting")
        if candidate.get("state") == "draining":
            if await self._workspace_has_active_work(user_id):
                return {"cutover_state": "waiting_for_drain", "active": active, "candidate": candidate}
            bindings = await self.store.list_project_bindings_for_user(user_id)
            if not bindings:
                await self.store.switch_workspace_installation(
                    user_id,
                    str(candidate["id"]),
                    str(candidate["app_user_id"]),
                )
                retirement_error = not await self._retire_linear_credentials(active)
                return {
                    "cutover_state": "switched",
                    "active": await self.get_active_linear_installation(user_id),
                    "candidate": None,
                    "retirement_error": retirement_error,
                }
            await self._prepare_candidate(candidate, bindings)
            candidate = {
                **candidate,
                "state": "preparing",
                "action_required": "wait",
                "next_action": "wait_for_conductor_preparation",
                "updated_at": utc_now_iso(),
            }
            await self.save_linear_installation_record(candidate)
            return {"cutover_state": "waiting_for_conductors", "active": active, "candidate": candidate}
        if candidate.get("state") != "preparing":
            raise LinearCutoverError("linear_cutover_state_invalid", "Replacement installation cannot advance")
        bindings = await self.store.list_project_bindings_for_user(user_id)
        if not all(_binding_prepared(binding, candidate) for binding in bindings):
            return {"cutover_state": "waiting_for_conductors", "active": active, "candidate": candidate}
        await self.store.switch_workspace_installation(
            user_id,
            str(candidate["id"]),
            str(candidate["app_user_id"]),
        )
        retirement_error = not await self._retire_linear_credentials(active)
        switched_bindings = await self.store.list_project_bindings_for_user(user_id)
        for binding in switched_bindings:
            await self.enqueue_runtime_command(
                str(binding["conductor_id"]),
                {
                    "type": "project.activate_installation",
                    "installation_id": str(candidate["id"]),
                    "config_version": int(binding.get("config_version") or 0),
                },
            )
        return {
            "cutover_state": "switched",
            "active": await self.get_active_linear_installation(user_id),
            "candidate": None,
            "retirement_error": retirement_error,
        }

    async def _retire_linear_credentials(self, installation: dict[str, Any]) -> bool:
        try:
            await self._revoke_linear_credentials(
                {**installation, "active": False, "state": "retired", "updated_at": utc_now_iso()}
            )
        except LinearTokenUnavailable:
            return False
        return True

    async def _prepare_candidate(
        self,
        candidate: dict[str, Any],
        bindings: list[dict[str, Any]],
    ) -> None:
        for binding in bindings:
            candidate_version = int(binding.get("config_version") or 0) + 1
            staged = {
                **binding,
                "candidate_installation_id": str(candidate["id"]),
                "candidate_agent_app_user_id": str(candidate["app_user_id"]),
                "candidate_config_version": candidate_version,
                "candidate_acknowledged_config_version": 0,
                "updated_at": utc_now_iso(),
            }
            await self.store.upsert_project_binding(staged)
            await self.enqueue_runtime_command(
                str(binding["conductor_id"]),
                {
                    "type": "project.prepare_installation",
                    "linear_project_id": str(binding.get("linear_project_id") or ""),
                    "installation_id": str(candidate["id"]),
                    "agent_app_user_id": str(candidate["app_user_id"]),
                    "config_version": candidate_version,
                },
            )

    async def _workspace_has_active_work(self, user_id: str) -> bool:
        if await self.store.count_open_dispatches_for_user(user_id):
            return True
        terminal = {"done", "failed", "cancelled", "canceled"}
        for binding in await self.store.list_project_bindings_for_user(user_id):
            view = await self.store.get_managed_run_view(str(binding["conductor_id"])) or {}
            if not managed_run_view_matches_binding(view, binding):
                continue
            if _active_runs_total(view) > 0:
                return True
            for run in view.get("runs") or []:
                if isinstance(run, dict) and str(run.get("state") or "") not in terminal:
                    return True
        return False


def _active_runs_total(view: dict[str, Any]) -> int:
    value = view.get("active_runs_total")
    if value is None:
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 1


def _binding_prepared(binding: dict[str, Any], candidate: dict[str, Any]) -> bool:
    return bool(
        str(binding.get("candidate_installation_id") or "") == str(candidate.get("id") or "")
        and int(binding.get("candidate_config_version") or 0) > 0
        and int(binding.get("candidate_acknowledged_config_version") or 0)
        == int(binding.get("candidate_config_version") or 0)
    )
