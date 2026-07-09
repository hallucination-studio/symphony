from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .conductor_pipeline_coordinator_types import PipelineDispatchAccepted
from .conductor_pipeline_coordinator_dispatch import DispatchMixin
from .conductor_pipeline_coordinator_runner import RunnerMixin
from .conductor_pipeline_coordinator_runtime_observation import RuntimeObservationMixin
from .conductor_pipeline_coordinator_results import ResultsMixin
from .conductor_pipeline_scheduler import PipelineScheduler
from .conductor_pipeline_store import ConductorPipelineStore


class PipelineCoordinator(
    DispatchMixin,
    RunnerMixin,
    RuntimeObservationMixin,
    ResultsMixin,
):
    def __init__(self, *, store: ConductorPipelineStore, runtime_manager: Any):
        self.store = store
        self.runtime_manager = runtime_manager
        self.scheduler = PipelineScheduler(store)

    def drive_convergence_once(self) -> int:
        return len(self.scheduler.promote_ready_nodes())

    def heartbeat_active_leases(self, *, at=None, ttl_seconds: int = 300) -> int:
        now = at or datetime.now(timezone.utc)
        heartbeats = 0
        for lease in self.store.list_active_leases():
            if self.store.heartbeat_lease(lease.lease_id, lease.fencing_token, at=now, ttl_seconds=ttl_seconds):
                heartbeats += 1
        return heartbeats


__all__ = ["PipelineCoordinator", "PipelineDispatchAccepted"]
