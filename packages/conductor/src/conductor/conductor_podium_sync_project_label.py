from __future__ import annotations

from .conductor_service_helpers import _desired_project_labels


class PodiumProjectLabelMixin:
    async def sync_project_labels_once(self) -> int:
        """Sync project labels for instances whose scope changed since last run.

        Best-effort: a Linear failure for one instance is swallowed so it retries
        next tick without blocking the rest of the background loop.
        """
        synced = 0
        for instance in self.store.list_instances():
            signature = "\0".join([instance.linear_project, *_desired_project_labels(instance)])
            if self._project_label_signatures.get(instance.id) == signature:
                continue
            try:
                result = await self.sync_instance_project_labels(instance)
            except Exception:
                continue
            if result.get("status") in {"synced", "unchanged"}:
                self._project_label_signatures[instance.id] = signature
            if result.get("status") == "synced":
                synced += 1
        return synced
