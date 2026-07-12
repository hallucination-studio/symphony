from __future__ import annotations

from datetime import datetime
from typing import Any

from .conductor_podium_sync_dispatch import PodiumDispatchMixin
from .conductor_podium_sync_failure import PodiumSyncFailureMixin
from .conductor_podium_sync_reporter import PodiumReportMixin
from .conductor_podium_sync_smoke import PodiumSmokeCheckMixin
from .conductor_podium_sync_commands import PodiumCommandMixin
from .conductor_service_helpers import _desired_project_labels
from .conductor_service_types import CoordinationResult
from .workflow_driver import WorkflowDriver


class ConductorPodiumSyncMixin(
    PodiumSyncFailureMixin,
    PodiumDispatchMixin,
    PodiumReportMixin,
    PodiumSmokeCheckMixin,
    PodiumCommandMixin,
):
    async def coordinate_background_once(self) -> CoordinationResult:
        self._managed_run_reconcile_findings: list[dict[str, Any]] = []
        managed_run_driver = await WorkflowDriver(self).drive_once()
        return CoordinationResult(
            dispatch_acks={"acked": 0, "failed": 0, "skipped": 0},
            project_labels_synced=0,
            managed_run_turns_started=managed_run_driver.get("started", 0),
            managed_run_results_applied=managed_run_driver.get("applied", 0),
            managed_run_integrations_processed=0,
            managed_run_timeouts=0,
            managed_run_crash_retries=0,
            managed_run_crash_failures=0,
            managed_run_human_actions_created=0,
            managed_run_human_actions_completed=0,
            managed_run_human_actions_missing_response=0,
            managed_run_human_actions_failed=0,
            managed_run_runtime_waits_observed=0,
            linear_managed_run_ingestions=0,
            linear_managed_run_projections=0,
            dispatchable=0,
            blocked_waiting=0,
            reconcile_findings=getattr(self, "_managed_run_reconcile_findings", []),
            remediations={},
            crash_restarts=0,
            crash_loops=0,
        )

    async def _sync_project_labels_if_due(self, now: datetime) -> int:
        if not self.coordination_cadence.project_labels_due(now):
            return 0
        self.coordination_cadence.mark_project_labels(now)
        return await self.sync_project_labels_once()

    async def sync_project_labels_once(self) -> int:
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


__all__ = ["ConductorPodiumSyncMixin"]
