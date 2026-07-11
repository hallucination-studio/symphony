from __future__ import annotations

from datetime import datetime
from typing import Any

from .conductor_service_types import CoordinationResult
from .workflow_driver import WorkflowDriver


class PodiumBackgroundMixin:
    async def coordinate_background_once(self) -> CoordinationResult:
        self._managed_run_reconcile_findings: list[dict[str, Any]] = []
        managed_run_driver = await WorkflowDriver(self).drive_once()
        remediations: dict[str, Any] = {}
        managed_run_projections = 0
        dispatch_acks = {"acked": 0, "failed": 0, "skipped": 0}
        project_labels_synced = 0
        crash_restarts = 0
        crash_loops = 0
        return CoordinationResult(
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
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
            linear_managed_run_projections=managed_run_projections,
            dispatchable=0,
            blocked_waiting=0,
            reconcile_findings=getattr(self, "_managed_run_reconcile_findings", []),
            remediations=remediations,
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    async def _sync_project_labels_if_due(self, now: datetime) -> int:
        if not self.coordination_cadence.project_labels_due(now):
            return 0
        self.coordination_cadence.mark_project_labels(now)
        return await self.sync_project_labels_once()
