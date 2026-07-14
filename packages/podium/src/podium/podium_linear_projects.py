from __future__ import annotations

from typing import Any

from .linear_installation_acceptance import LinearInstallationRejected


class LinearProjectSelectionError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def bound_project_access_rejection(project_ids: list[str]) -> LinearInstallationRejected:
    missing = ", ".join(sorted(project_ids))
    return LinearInstallationRejected(
        "linear_bound_project_missing",
        f"The replacement application cannot access bound Linear projects: {missing}",
    )


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
        bindings = await self.store.list_project_bindings_for_user(user_id)
        bound_project_ids = {
            str(binding.get("linear_project_id") or "")
            for binding in bindings
            if binding.get("active", True)
        }
        if not bound_project_ids:
            return
        selected = await self.list_selected_linear_projects(user_id)
        selected_organization_ids = {
            str(row.get("linear_organization_id") or "")
            for row in selected
            if str(row.get("linear_project_id") or "") in bound_project_ids
        }
        candidate_organization_id = str(candidate.get("linear_organization_id") or "")
        if (
            selected_organization_ids
            and selected_organization_ids != {candidate_organization_id}
        ):
            raise LinearInstallationRejected(
                "linear_organization_mismatch",
                "The replacement application authorized a different Linear organization",
            )
        accessible = {
            str(project.get("id") or "")
            for project in candidate.get("projects") or []
            if isinstance(project, dict)
        }
        missing = sorted(bound_project_ids - accessible)
        if missing:
            raise bound_project_access_rejection(missing)

    def linear_projects_for_reauthorization(
        self,
        user_id: str,
        installation: dict[str, Any],
    ) -> list[dict[str, Any]]:
        return [
            {
                "user_id": user_id,
                "linear_organization_id": str(
                    installation.get("linear_organization_id") or ""
                ),
                "linear_project_id": str(project.get("id") or ""),
                "project_slug": str(project.get("slug_id") or ""),
                "project_name": str(project.get("name") or ""),
                "access_state": "ready",
            }
            for project in installation.get("projects") or []
            if isinstance(project, dict)
        ]
