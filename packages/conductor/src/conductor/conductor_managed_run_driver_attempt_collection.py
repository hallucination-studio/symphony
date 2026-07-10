from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunState, WorkItemResult, WorkItemState

from .conductor_managed_run_driver_helpers import (
    _active_attempts,
    _complete_attempt,
    _completed_attempts,
    _events_from_payload,
    _read_json,
    _sanitize,
)
from .conductor_managed_run_execution import freeze_execution_handoff
from .conductor_managed_run_fencing import log_result_rejection, result_context_error
from .conductor_managed_run_runtime_waits import build_runtime_wait_record, runtime_wait_from_turn_payload
from .conductor_managed_run_workspace_events import log_workspace_failure
from .conductor_models import InstanceRecord


class ConductorManagedRunAttemptCollectionMixin:
    async def _collect_work_item_turn(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        attempts = _active_attempts(run, kind="work_item")
        if not attempts:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason="work_item_attempt_missing")
            return {"failed": 1}
        applied = 0
        remaining: list[dict[str, Any]] = []
        completed = _completed_attempts(run)
        for attempt in attempts:
            outcome, count = await self._collect_work_item_attempt(run, instance, attempts, attempt, completed)
            if outcome == "failed":
                return {"applied": applied + count, "failed": 1}
            if outcome == "waiting":
                remaining.append(attempt)
                continue
            if outcome == "runtime_wait":
                return {"applied": applied + count}
            applied += count
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": remaining[-1] if remaining else {},
                "active_attempts": remaining,
                "completed_attempts": completed,
                "last_work_item_attempt": attempts[-1],
            },
        )
        return {"applied": applied} if applied else {}

    async def _collect_work_item_attempt(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempts: list[dict[str, Any]],
        attempt: dict[str, Any],
        completed: list[dict[str, Any]],
    ) -> tuple[str, int]:
        result_path = Path(str(attempt.get("result_path") or ""))
        if not result_path.exists():
            exited = self._active_attempt_exit(run, attempt)
            if exited is None:
                return "waiting", 0
            self._fail_missing_turn_result(str(run["run_id"]), attempt, exited, "work_item")
            await self._cancel_parallel_work_item_attempts(run, instance, attempts, attempt, f"peer_work_item_failed:{attempt.get('work_item_id') or 'unknown'}")
            return "failed", 0
        try:
            payload = _read_json(result_path)
            context_error = result_context_error(run, attempt, payload)
            if context_error:
                log_result_rejection(run, attempt, context_error)
                raise ValueError(context_error)
            runtime_wait = runtime_wait_from_turn_payload(payload)
            if runtime_wait is not None:
                return await self._collect_runtime_wait(run, instance, attempts, attempt, completed, runtime_wait, payload)
            result_payload = payload.get("result")
            if not isinstance(result_payload, dict):
                raise ValueError("work_item_result_missing")
            result = WorkItemResult.from_dict(result_payload)
            expected_work_item_id = str(attempt.get("work_item_id") or "")
            if result.work_item_id != expected_work_item_id:
                reason = f"work_item_result_id_mismatch:expected={expected_work_item_id}:actual={result.work_item_id}"
                self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
                self._complete_work_item_attempt(run, attempt, completed, state="failed", reason=reason, payload=payload)
                await self._cancel_parallel_work_item_attempts(run, instance, attempts, attempt, f"peer_work_item_failed:{expected_work_item_id or 'unknown'}")
                return "failed", 0
            submitted = self.coordinator.submit_work_item_result(str(run["run_id"]), result)
        except Exception as exc:
            reason = f"work_item_result_failed:{_sanitize(exc)}"
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
            self._complete_work_item_attempt(run, attempt, completed, state="failed", reason=reason)
            await self._cancel_parallel_work_item_attempts(run, instance, attempts, attempt, f"peer_work_item_failed:{attempt.get('work_item_id') or 'unknown'}")
            return "failed", 0
        if submitted.get("state") == "blocked":
            reason = str(submitted.get("gate_status") or run.get("latest_reason") or "backend_blocked")
            self._complete_work_item_attempt(run, attempt, completed, state="blocked", reason=reason, payload=payload)
            await self._cancel_parallel_work_item_attempts(run, instance, attempts, attempt, f"peer_work_item_blocked:{attempt.get('work_item_id') or 'unknown'}")
            return "failed", 1
        try:
            handoff = freeze_execution_handoff(
                result,
                execution_workspace=Path(str(attempt.get("workspace_path") or "")),
                expected_base_revision=str(attempt.get("base_revision") or ""),
                expected_branch_name=str(attempt.get("branch_name") or ""),
            )
        except Exception as exc:
            return await self._fail_execution_handoff(run, instance, attempts, attempt, completed, result, payload, exc)
        recorded = self.store.record_execution_handoff(
            str(run["run_id"]),
            work_item_id=str(result.work_item_id),
            execute_attempt_id=str(attempt.get("attempt_id") or ""),
            handoff=handoff.to_dict(),
        )
        gate = next(
            (snapshot for snapshot in self.store.list_gate_snapshots(str(run["run_id"])) if snapshot.get("work_item_id") == result.work_item_id),
            {},
        )
        completed.append(
            _complete_attempt(
                {**attempt, "execution_handoff": recorded, "gate_snapshot_hash": str(gate.get("content_hash") or "")},
                state="succeeded",
                events=_events_from_payload(payload),
                thread_id=str(payload.get("thread_id") or ""),
            )
        )
        return "applied", 1

    async def _fail_execution_handoff(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempts: list[dict[str, Any]],
        attempt: dict[str, Any],
        completed: list[dict[str, Any]],
        result: WorkItemResult,
        payload: dict[str, Any],
        exc: Exception,
    ) -> tuple[str, int]:
        reason = f"execution_handoff_failed:{_sanitize(exc)}"
        log_workspace_failure(
            run,
            instance,
            work_item_id=str(result.work_item_id),
            reason=reason,
            attempt=attempt,
            branch_name=str(attempt.get("branch_name") or ""),
        )
        self.coordinator.verify_work_item(str(run["run_id"]), str(result.work_item_id), gate_status=reason, passed=False)
        self._complete_work_item_attempt(run, attempt, completed, state="failed", reason=reason, payload=payload)
        await self._cancel_parallel_work_item_attempts(run, instance, attempts, attempt, f"peer_work_item_failed:{attempt.get('work_item_id') or 'unknown'}")
        return "failed", 1

    async def _collect_runtime_wait(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempts: list[dict[str, Any]],
        attempt: dict[str, Any],
        completed: list[dict[str, Any]],
        runtime_wait: Any,
        payload: dict[str, Any],
    ) -> tuple[str, int]:
        record = build_runtime_wait_record(run, attempt, runtime_wait)
        self.coordinator.record_runtime_wait(str(run["run_id"]), record)
        reason = f"runtime_wait:{record['wait_id']}"
        self._complete_work_item_attempt(run, attempt, completed, state="blocked", reason=reason, payload=payload)
        await self._pause_parallel_work_item_attempts_for_runtime_wait(run, instance, attempts, attempt, record["wait_id"])
        return "runtime_wait", 1

    def _complete_work_item_attempt(
        self,
        run: dict[str, Any],
        attempt: dict[str, Any],
        completed: list[dict[str, Any]],
        *,
        state: str,
        reason: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        attempt_id = str(attempt.get("attempt_id") or "")
        current = self.store.get_run(str(run["run_id"])) or run
        existing = _completed_attempts(current)
        existing_ids = {str(row.get("attempt_id") or "") for row in existing}
        for candidate in completed:
            if str(candidate.get("attempt_id") or "") not in existing_ids:
                existing.append(candidate)
                existing_ids.add(str(candidate.get("attempt_id") or ""))
        if attempt_id not in existing_ids:
            record = {**attempt, "sanitized_error": reason} if reason else dict(attempt)
            existing.append(_complete_attempt(record, state=state, events=_events_from_payload(payload or {}), thread_id=str((payload or {}).get("thread_id") or "")))
        active = [candidate for candidate in _active_attempts(current) if str(candidate.get("attempt_id") or "") != attempt_id]
        self.store.merge_run_payload(str(run["run_id"]), {"active_attempt": active[-1] if active else {}, "active_attempts": active, "completed_attempts": existing, "last_work_item_attempt": attempt})

    async def _cancel_parallel_work_item_attempts(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempts: list[dict[str, Any]],
        terminal_attempt: dict[str, Any],
        reason: str,
    ) -> None:
        terminal_attempt_id = str(terminal_attempt.get("attempt_id") or "")
        attempt_ids = [str(attempt.get("attempt_id") or "") for attempt in attempts if attempt.get("attempt_id")]
        stop_attempts = getattr(self.runtime_manager, "stop_attempts", None)
        if callable(stop_attempts) and attempt_ids:
            self.instance_update(await stop_attempts(instance, attempt_ids))
        current = self.store.get_run(str(run["run_id"])) or run
        completed = _completed_attempts(current)
        completed_ids = {str(attempt.get("attempt_id") or "") for attempt in completed}
        for attempt in _active_attempts(current, kind="work_item"):
            attempt_id = str(attempt.get("attempt_id") or "")
            if attempt_id and attempt_id != terminal_attempt_id and attempt_id not in completed_ids:
                completed.append(_complete_attempt({**attempt, "sanitized_error": reason}, state="cancelled"))
                self.store.update_work_item_state(
                    str(run["run_id"]),
                    str(attempt.get("work_item_id") or ""),
                    WorkItemState.BLOCKED,
                    gate_status=reason,
                )
        self.store.merge_run_payload(str(run["run_id"]), {"active_attempt": {}, "active_attempts": [], "completed_attempts": completed})

    async def _pause_parallel_work_item_attempts_for_runtime_wait(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        attempts: list[dict[str, Any]],
        waiting_attempt: dict[str, Any],
        wait_id: str,
    ) -> None:
        waiting_attempt_id = str(waiting_attempt.get("attempt_id") or "")
        peer_ids = [
            str(attempt.get("attempt_id") or "")
            for attempt in attempts
            if str(attempt.get("attempt_id") or "") and str(attempt.get("attempt_id") or "") != waiting_attempt_id
        ]
        stop_attempts = getattr(self.runtime_manager, "stop_attempts", None)
        if callable(stop_attempts) and peer_ids:
            self.instance_update(await stop_attempts(instance, peer_ids))
        current = self.store.get_run(str(run["run_id"])) or run
        completed = _completed_attempts(current)
        completed_ids = {str(attempt.get("attempt_id") or "") for attempt in completed}
        for attempt in _active_attempts(current, kind="work_item"):
            attempt_id = str(attempt.get("attempt_id") or "")
            if not attempt_id or attempt_id == waiting_attempt_id or attempt_id in completed_ids:
                continue
            completed.append(_complete_attempt({**attempt, "sanitized_error": f"runtime_wait:{wait_id}"}, state="cancelled"))
            self.store.update_work_item_state(
                str(run["run_id"]),
                str(attempt.get("work_item_id") or ""),
                WorkItemState.TODO,
                gate_status=f"runtime_wait_pending:{wait_id}",
            )
        self.store.merge_run_payload(str(run["run_id"]), {"active_attempt": {}, "active_attempts": [], "completed_attempts": completed})


__all__ = ["ConductorManagedRunAttemptCollectionMixin"]
