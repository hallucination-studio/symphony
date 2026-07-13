from __future__ import annotations

from typing import Any

from .performer_profiles import PerformerProfileLoadError, load_profile_bundle


class PodiumPerformerProfilesMixin:
    async def ensure_performer_binding(self, project_binding: dict[str, Any]) -> dict[str, Any]:
        workspace_id = str(project_binding.get("user_id") or "")
        project_binding_id = str(project_binding.get("id") or "")
        try:
            bundle = load_profile_bundle(
                getattr(self.config, "performer_profile_dir", ""),
                workspace_id=workspace_id,
                profile_name=str(getattr(self.config, "performer_profile_name", "default") or "default"),
            )
            selected = await self.store.ensure_performer_binding(
                project_binding_id=project_binding_id,
                workspace_id=workspace_id,
                runtime_profile=bundle.runtime_profile,
                performer_profile=bundle.performer_profile,
            )
        except PerformerProfileLoadError:
            raise
        return {
            **project_binding,
            "performer_binding_id": str(selected["id"]),
            "performer_binding_generation": int(selected.get("generation") or 1),
        }


__all__ = ["PodiumPerformerProfilesMixin"]
