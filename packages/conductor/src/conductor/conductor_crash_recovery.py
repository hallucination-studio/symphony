from __future__ import annotations

from typing import Any

from performer_api.phase import RunPhase

from .conductor_phase import PhaseTransitionError


ACTIVE_PHASES = {RunPhase.IMPLEMENTING, RunPhase.REVIEWING, RunPhase.REWORKING}
RUNTIME_PROCESS_STATUSES = {"starting", "running", "unhealthy", "crash_loop"}


def normalize_stale_runtime_state(*, store: Any, runtime_manager: Any, phase_reducer: Any) -> None:
    for instance in store.list_instances():
        if instance.process_status not in RUNTIME_PROCESS_STATUSES:
            continue
        active_runs = store.list_orchestration_runs(instance_id=instance.id, phases=ACTIVE_PHASES)
        candidate_pids = [
            pid
            for pid in [instance.pid, *(run.process_pid for run in active_runs)]
            if pid is not None
        ]
        recovered_by_pid: dict[int, Any] = {}
        for pid in dict.fromkeys(candidate_pids):
            recovered = runtime_manager.recover(instance.with_updates(process_status="running", pid=pid))
            if recovered is not None and recovered.pid is not None:
                recovered_by_pid[recovered.pid] = recovered
        if instance.pid in recovered_by_pid:
            store.update_instance(recovered_by_pid[instance.pid])
        elif recovered_by_pid:
            store.update_instance(next(iter(recovered_by_pid.values())))
        else:
            store.update_instance(instance.with_updates(process_status="stopped", pid=None))
        for run in active_runs:
            if run.process_pid not in recovered_by_pid:
                clear_orphaned_active_runs(
                    store=store,
                    phase_reducer=phase_reducer,
                    instance_id=instance.id,
                    reason="orphaned performer process was not recoverable",
                    process_pid=run.process_pid,
                )


def clear_orphaned_active_runs(
    *,
    store: Any,
    phase_reducer: Any,
    instance_id: str,
    reason: str,
    process_pid: int | None = None,
) -> None:
    runs = store.list_orchestration_runs(instance_id=instance_id, phases=ACTIVE_PHASES)
    for run in runs:
        if process_pid is not None and run.process_pid != process_pid:
            continue
        try:
            phase_reducer.performer_start_failed(run.run_id, error=reason)
        except PhaseTransitionError:
            continue
