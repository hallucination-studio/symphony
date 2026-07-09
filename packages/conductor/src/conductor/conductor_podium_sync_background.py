from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from .conductor_service_types import CoordinationResult


class PodiumBackgroundMixin:
    async def coordinate_background_once(self) -> CoordinationResult:
        self._pipeline_reconcile_findings: list[dict[str, Any]] = []
        closeout = {"closed_out": 0, "failed": 0, "skipped": 0}
        startup_reconciled_attempts = self.reconcile_pipeline_attempts_on_startup()
        dispatches_drained = await self._drain_podium_dispatch_queue()
        remediations: dict[str, Any] = {}
        pipeline_results_applied = 0
        pipeline_integrations_processed = 0
        pipeline_leases_reclaimed = 0
        pipeline_lease_heartbeats = 0
        pipeline_runtime_waits_observed = 0
        linear_pipeline_ingestions = 0
        linear_pipeline_projections = 0
        pipeline_attempts_started = 0
        pipeline_results_applied = self._collect_pipeline_result_files()
        pipeline_crash_failures = startup_reconciled_attempts + self._fail_exited_pipeline_attempts()
        pipeline_runtime_waits_observed = self._collect_pipeline_runtime_waits()
        pipeline_integrations_processed = self._process_pipeline_integrations()
        self._drive_pipeline_convergence()
        pipeline_human_actions_created = await self.reconcile_pipeline_human_actions_once()
        pipeline_human_actions_created += await self.reconcile_pipeline_runtime_wait_actions_once()
        pipeline_human_actions_completed = await self.reconcile_completed_pipeline_human_actions_once()
        pipeline_lease_heartbeats = self._heartbeat_running_pipeline_leases()
        pipeline_leases_reclaimed = self.pipeline_store.reclaim_expired_leases(datetime.now(timezone.utc))
        pipeline_stuck_nodes_surfaced = self._surface_stuck_nodes()
        linear_pipeline_ingestions = await self.ingest_linear_pipeline_changes_once()
        linear_pipeline_projections = await self.reconcile_linear_pipeline_projections_once()
        pipeline_attempts_started = await self._start_due_pipeline_attempts()
        dispatch_acks = dispatches_drained
        project_labels_synced = 0
        crash_restarts = 0
        crash_loops = 0
        return CoordinationResult(
            repository_handoff=closeout,
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
            pipeline_attempts_started=pipeline_attempts_started,
            pipeline_results_applied=pipeline_results_applied,
            pipeline_integrations_processed=pipeline_integrations_processed,
            pipeline_leases_reclaimed=pipeline_leases_reclaimed,
            pipeline_timeouts=0,
            pipeline_crash_retries=0,
            pipeline_crash_failures=pipeline_crash_failures,
            pipeline_human_actions_created=pipeline_human_actions_created,
            pipeline_human_actions_completed=pipeline_human_actions_completed,
            pipeline_human_actions_missing_response=0,
            pipeline_human_actions_failed=0,
            pipeline_runtime_waits_observed=pipeline_runtime_waits_observed,
            linear_pipeline_ingestions=linear_pipeline_ingestions,
            linear_pipeline_projections=linear_pipeline_projections,
            dispatchable=0,
            blocked_waiting=0,
            reconcile_findings=getattr(self, "_pipeline_reconcile_findings", []),
            remediations=remediations,
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    async def _run_repository_handoff_closeouts_if_due(self, now: datetime) -> dict[str, Any]:
        if not self.coordination_cadence.repository_handoff_due(now):
            return {"closed_out": 0, "failed": 0, "skipped": 1}
        self.coordination_cadence.mark_repository_handoff(now)
        return await self.coordinate_repository_handoff_closeouts()

    async def _sync_project_labels_if_due(self, now: datetime) -> int:
        if not self.coordination_cadence.project_labels_due(now):
            return 0
        self.coordination_cadence.mark_project_labels(now)
        return await self.sync_project_labels_once()

    async def ack_completed_podium_dispatches(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> dict[str, Any]:
        return {"acked": 0, "failed": 0, "skipped": 0}
