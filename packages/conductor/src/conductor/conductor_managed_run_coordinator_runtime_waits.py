from __future__ import annotations

from typing import Any

from .conductor_managed_run_coordinator_helpers import LOGGER
from .conductor_managed_run_runtime_waits import (
    RUNTIME_WAIT_GATE_PREFIX,
    RUNTIME_WAIT_PENDING_GATE_PREFIX,
    RUNTIME_WAIT_RESOLVED_GATE_PREFIX,
    merge_runtime_wait,
    runtime_waits,
)
from .conductor_managed_run_state import ManagedRunState, WorkItemState


class ConductorManagedRunRuntimeWaitMixin:
    def record_runtime_wait(self, run_id: str, record: dict[str, Any]) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        wait_id = str(record.get("wait_id") or "")
        work_item_id = str(record.get("work_item_id") or "")
        if not wait_id or str(record.get("status") or "") != "waiting":
            raise ValueError("runtime_wait_invalid")
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        self.store.merge_run_payload(run_id, {"runtime_waits": merge_runtime_wait(runtime_waits(payload), record)})
        if work_item_id:
            self.store.update_work_item_state(run_id, work_item_id, WorkItemState.BLOCKED, gate_status=f"{RUNTIME_WAIT_GATE_PREFIX}{wait_id}")
        self.store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=work_item_id, reason=f"runtime_wait:{wait_id}")
        LOGGER.error(
            "event=managed_run_runtime_wait_created run_id=%s work_item_id=%s attempt_id=%s lease_id=%s wait_id=%s error_code=%s sanitized_reason=%s action_required=complete_runtime_wait_child retryable=false next_action=project_runtime_wait",
            run_id,
            work_item_id or "parent",
            record.get("attempt_id") or "-",
            record.get("lease_id") or "-",
            wait_id,
            record.get("wait_kind") or "runtime_wait",
            record.get("sanitized_message") or "runtime_input_required",
        )
        return record

    def resolve_runtime_wait(self, run_id: str, wait_id: str) -> bool:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        waits = runtime_waits(payload)
        target = next((wait for wait in waits if str(wait.get("wait_id") or "") == wait_id), None)
        if target is None or target.get("status") != "waiting":
            return False
        resolved = {**target, "status": "resolved", "resolution": "child_completed"}
        self.store.merge_run_payload(run_id, {"runtime_waits": merge_runtime_wait(waits, resolved)})
        for item in self.store.list_work_items(run_id):
            gate_status = str(item.get("gate_status") or "")
            if gate_status not in {f"{RUNTIME_WAIT_GATE_PREFIX}{wait_id}", f"{RUNTIME_WAIT_PENDING_GATE_PREFIX}{wait_id}"}:
                continue
            self.store.update_work_item_state(
                run_id,
                str(item.get("work_item_id") or ""),
                WorkItemState.TODO,
                gate_status=f"{RUNTIME_WAIT_RESOLVED_GATE_PREFIX}{wait_id}",
            )
        next_state = ManagedRunState.PLANNING if target.get("turn_kind") == "plan" else ManagedRunState.READY
        self.store.update_run_state(run_id, next_state, reason=f"runtime_wait_resolved:{wait_id}")
        LOGGER.info(
            "event=managed_run_runtime_wait_resolved run_id=%s wait_id=%s action_required=none retryable=true next_action=%s",
            run_id,
            wait_id,
            next_state.value,
        )
        return True


__all__ = ["ConductorManagedRunRuntimeWaitMixin"]
