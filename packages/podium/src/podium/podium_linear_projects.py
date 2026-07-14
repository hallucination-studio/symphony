from __future__ import annotations

from typing import Any

from .linear_installation_acceptance import LinearInstallationRejected


class LinearProjectSelectionError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class PodiumLinearProjectsMixin:
    async def list_selected_linear_projects(self, user_id: str) -> list[dict[str, Any]]:
        return await self.store.list_selected_linear_projects(user_id)

    async def linear_projects_public(self, user_id: str) -> list[dict[str, Any]]:
        installation = await self.get_active_linear_installation(user_id)
        if installation is None:
            raise LinearProjectSelectionError(
                "linear_installation_required",
                "An active Linear installation is required",
            )
        selected = {
            str(row.get("linear_project_id") or "")
            for row in await self.list_selected_linear_projects(user_id)
        }
        bound_project_ids = {
            str(row.get("linear_project_id") or "")
            for row in await self.store.list_project_bindings_for_user(user_id)
            if row.get("active", True)
        }
        return [
            {
                "id": str(project.get("id") or ""),
                "name": str(project.get("name") or ""),
                "slug_id": str(project.get("slug_id") or ""),
                "selected": str(project.get("id") or "") in selected,
                "access_state": "ready",
                "bound": str(project.get("id") or "") in bound_project_ids,
            }
            for project in installation.get("projects") or []
            if isinstance(project, dict)
        ]

    async def select_linear_projects(self, user_id: str, project_ids: list[str]) -> list[dict[str, Any]]:
        if not project_ids:
            raise LinearProjectSelectionError("linear_project_required", "Select at least one Linear project")
        if len(project_ids) != len(set(project_ids)):
            raise LinearProjectSelectionError("duplicate_linear_project", "Linear project ids must be unique")
        installation = await self.get_active_linear_installation(user_id)
        if installation is None:
            raise LinearProjectSelectionError(
                "linear_installation_required",
                "An active Linear installation is required",
            )
        projects = {
            str(project.get("id") or ""): project
            for project in installation.get("projects") or []
            if isinstance(project, dict)
        }
        missing = sorted(project_id for project_id in project_ids if project_id not in projects)
        if missing:
            raise LinearProjectSelectionError(
                "linear_project_not_accessible",
                f"Linear projects are not accessible: {', '.join(missing)}",
            )
        rows = [
            {
                "user_id": user_id,
                "linear_organization_id": str(installation.get("linear_organization_id") or ""),
                "linear_project_id": project_id,
                "project_slug": str(projects[project_id].get("slug_id") or ""),
                "project_name": str(projects[project_id].get("name") or ""),
                "access_state": "ready",
            }
            for project_id in sorted(project_ids)
        ]
        bound_removals = await self.store.replace_selected_linear_projects(user_id, rows)
        if bound_removals:
            raise LinearProjectSelectionError(
                "linear_project_bound",
                "Unbind the active Conductor before removing a Linear project",
            )
        await self._mark_onboarding(user_id, "scope_selection")
        return await self.linear_projects_public(user_id)

    async def validate_candidate_project_access(
        self,
        user_id: str,
        candidate: dict[str, Any],
    ) -> None:
        selected = await self.list_selected_linear_projects(user_id)
        if not selected:
            return
        selected_organization_ids = {
            str(row.get("linear_organization_id") or "") for row in selected
        }
        candidate_organization_id = str(candidate.get("linear_organization_id") or "")
        if selected_organization_ids != {candidate_organization_id}:
            raise LinearInstallationRejected(
                "linear_organization_mismatch",
                "The replacement application authorized a different Linear organization",
            )
        accessible = {
            str(project.get("id") or "")
            for project in candidate.get("projects") or []
            if isinstance(project, dict)
        }
        missing = sorted(
            str(row.get("linear_project_id") or "")
            for row in selected
            if str(row.get("linear_project_id") or "") not in accessible
        )
        if missing:
            raise LinearInstallationRejected(
                "linear_selected_project_missing",
                f"The replacement application cannot access selected Linear projects: {', '.join(missing)}",
            )
