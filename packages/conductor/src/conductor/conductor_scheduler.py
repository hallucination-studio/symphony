from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from performer_api.phase import PhaseAdvanceRequest, RunPhase

from .conductor_models import InstanceRecord
from .conductor_phase import PhaseTransitionError


@dataclass(frozen=True)
class SchedulerPolicy:
    global_capacity: int | None = None

    def remaining_capacity(self, active_count: int) -> int | None:
        if self.global_capacity is None:
            return None
        return max(0, self.global_capacity - active_count)


class OrchestrationScheduler:
    def __init__(
        self,
        *,
        store: Any,
        phase_reducer: Any,
        runtime_manager: Any,
        runtime_env: Callable[[], dict[str, str]],
        get_instance: Callable[[str], InstanceRecord | None],
        policy: SchedulerPolicy | None = None,
    ):
        self.store = store
        self.phase_reducer = phase_reducer
        self.runtime_manager = runtime_manager
        self.runtime_env = runtime_env
        self.get_instance = get_instance
        self.policy = policy or SchedulerPolicy()
        self._last_readiness_counts = {"dispatchable": 0, "blocked_waiting": 0}

    async def start_due_runs(self) -> int:
        started_count = 0
        active_count = len(self.store.list_orchestration_runs(phases=self._active_phases()))
        remaining_capacity = self.policy.remaining_capacity(active_count)
        if remaining_capacity == 0:
            return 0
        due_runs = self.store.list_due_orchestration_runs()
        dispatchable_runs = self._dispatchable_due_runs(due_runs)
        self._last_readiness_counts = {
            "dispatchable": len(dispatchable_runs),
            "blocked_waiting": len(due_runs) - len(dispatchable_runs),
        }
        for run in self._fair_due_runs(dispatchable_runs):
            if remaining_capacity is not None and started_count >= remaining_capacity:
                break
            instance = self.store.get_instance(run.instance_id)
            if instance is None:
                continue
            refreshed = self.get_instance(instance.id) or instance
            if refreshed.process_status in {"running", "starting"}:
                continue
            try:
                started = await self.start_run(run, refreshed)
            except PhaseTransitionError:
                continue
            except Exception:
                continue
            self.store.update_instance(started)
            started_count += 1
        return started_count

    def readiness_counts(self) -> dict[str, int]:
        due_runs = self.store.list_due_orchestration_runs()
        dispatchable_runs = self._dispatchable_due_runs(due_runs)
        return {
            "dispatchable": len(dispatchable_runs),
            "blocked_waiting": len(due_runs) - len(dispatchable_runs),
        }

    async def start_run(self, run: Any, instance: InstanceRecord) -> InstanceRecord:
        paths = phase_file_paths(instance, run.run_id)
        result_path = paths["result_path"]
        if result_path.exists():
            result_path.unlink()
        request = PhaseAdvanceRequest(
            run_id=run.run_id,
            instance_id=run.instance_id,
            issue_id=run.issue_id,
            issue_identifier=run.issue_identifier,
            current_phase=run.phase,
            attempt=run.attempt,
            human_response=run.human_response,
            workflow_profile=run.workflow_profile or instance.workflow_profile,
            workspace_context={
                "instance_dir": instance.instance_dir,
                "workspace_root": instance.workspace_root,
                "persistence_path": instance.persistence_path,
                "ops_snapshot_path": str(Path(instance.persistence_path).parent / "ops.json"),
            },
        )
        _write_json_atomic(paths["request_path"], request.to_dict())
        starting_instance = instance.with_updates(process_status="starting", pid=None, last_error=None)
        self.store.update_instance(starting_instance)
        self.phase_reducer.performer_started(
            run.run_id,
            request_path=str(paths["request_path"]),
            result_path=str(result_path),
            pid=None,
        )
        try:
            started = await self.runtime_manager.start(
                starting_instance,
                env=self.runtime_env(),
                advance_request_path=str(paths["request_path"]),
                phase_result_path=str(result_path),
            )
        except Exception as exc:
            self.phase_reducer.performer_start_failed(run.run_id, error=str(exc))
            self.store.update_instance(instance.with_updates(process_status="idle", pid=None, last_error=str(exc)))
            raise
        self.phase_reducer.performer_started(
            run.run_id,
            request_path=str(paths["request_path"]),
            result_path=str(result_path),
            pid=started.pid,
        )
        return started

    def _fair_due_runs(self, runs: list[Any]) -> list[Any]:
        by_instance: dict[str, list[Any]] = {}
        order: list[str] = []
        for run in runs:
            if run.instance_id not in by_instance:
                by_instance[run.instance_id] = []
                order.append(run.instance_id)
            by_instance[run.instance_id].append(run)
        fair: list[Any] = []
        while any(by_instance.values()):
            for instance_id in order:
                queue = by_instance[instance_id]
                if queue:
                    fair.append(queue.pop(0))
        return fair

    def _dispatchable_due_runs(self, runs: list[Any]) -> list[Any]:
        return [run for run in runs if self._is_dispatchable(run)]

    def is_dispatchable(self, run: Any) -> bool:
        for blocker_issue_id in getattr(run, "blocked_by", []) or []:
            has_terminal = getattr(self.store, "has_terminal_orchestration_run_for_issue", None)
            if callable(has_terminal) and has_terminal(blocker_issue_id):
                continue
            blocker = self.store.get_latest_orchestration_run_for_issue(blocker_issue_id)
            if blocker is None:
                return False
            if blocker.phase not in {RunPhase.DONE, RunPhase.FAILED}:
                return False
        return True

    def _is_dispatchable(self, run: Any) -> bool:
        return self.is_dispatchable(run)

    def _active_phases(self) -> set[RunPhase]:
        return {
            RunPhase.IMPLEMENTING,
            RunPhase.REVIEWING,
            RunPhase.REWORKING,
        }


def phase_file_paths(instance: InstanceRecord, run_id: str) -> dict[str, Path]:
    root = Path(instance.instance_dir) / "state" / "orchestration" / run_id
    root.mkdir(parents=True, exist_ok=True)
    return {
        "request_path": root / "advance-request.json",
        "result_path": root / "phase-result.json",
    }


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)
