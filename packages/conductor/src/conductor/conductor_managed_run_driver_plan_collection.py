from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunPlan, ManagedRunState

from .conductor_managed_run_driver_helpers import _active_attempt, _complete_attempt, _completed_attempts, _events_from_payload, _read_json, _sanitize
from .conductor_managed_run_fencing import log_result_rejection, result_context_error
from .conductor_managed_run_runtime_waits import build_runtime_wait_record, runtime_wait_from_turn_payload


class ConductorManagedRunPlanCollectionMixin:
    def _collect_plan_turn(self, run: dict[str, Any]) -> dict[str, int]:
        attempt = _active_attempt(run)
        if not attempt:
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason="plan_attempt_missing")
            return {"failed": 1}
        result_path = Path(str(attempt.get("result_path") or ""))
        if not result_path.exists():
            exited = self._active_attempt_exit(run)
            if exited is not None:
                self._fail_missing_turn_result(str(run["run_id"]), attempt, exited, "plan")
                return {"failed": 1}
            return {}
        payload: dict[str, Any] = {}
        try:
            payload = _read_json(result_path)
            context_error = result_context_error(run, attempt, payload)
            if context_error:
                log_result_rejection(run, attempt, context_error)
                raise ValueError(context_error)
            runtime_wait = runtime_wait_from_turn_payload(payload)
            if runtime_wait is not None:
                self._record_plan_runtime_wait(run, attempt, runtime_wait, payload)
                return {"applied": 1}
            plan_payload = payload.get("plan")
            if not isinstance(plan_payload, dict):
                raise ValueError("plan_result_missing")
            plan = ManagedRunPlan.from_dict(plan_payload)
            revision = self._approved_plan_revision(run)
            version = self._apply_collected_plan(run, attempt, plan, revision, payload)
        except Exception as exc:
            reason = f"plan_result_failed:{_sanitize(exc)}"
            self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
            self._complete_plan_attempt(run, attempt, state="failed", reason=reason, payload=payload)
            return {"failed": 1}
        return self._finish_collected_plan(run, attempt, version, payload)

    def _apply_collected_plan(
        self,
        run: dict[str, Any],
        attempt: dict[str, Any],
        plan: ManagedRunPlan,
        revision: dict[str, Any],
        payload: dict[str, Any],
    ) -> int:
        if revision:
            return self.coordinator.approve_plan_revision(
                str(run["run_id"]),
                plan,
                backend_session_id=str(payload.get("thread_id") or ""),
                approval_id=str(revision.get("approval_id") or ""),
                creator_attempt_id=str(attempt.get("attempt_id") or ""),
            )
        return self.coordinator.apply_plan(
            str(run["run_id"]),
            plan,
            backend_session_id=str(payload.get("thread_id") or ""),
            creator_attempt_id=str(attempt.get("attempt_id") or ""),
        )

    def _finish_collected_plan(self, run: dict[str, Any], attempt: dict[str, Any], version: int, payload: dict[str, Any]) -> dict[str, int]:
        latest = self.store.get_run(str(run["run_id"])) or run
        if version == 0:
            retryable = latest.get("state") == ManagedRunState.PLANNING.value
            self._complete_plan_attempt(
                run,
                attempt,
                state="failed",
                reason=str(latest.get("latest_reason") or "plan_validation_failed"),
                payload=payload,
                retryable=retryable,
            )
            return {"applied": 1} if retryable else {"failed": 1}
        completed = _completed_attempts(run)
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": {},
                "active_attempts": [],
                "completed_attempts": [
                    *completed,
                    _complete_attempt(attempt, state="succeeded", events=_events_from_payload(payload), thread_id=str(payload.get("thread_id") or "")),
                ],
                "last_plan_attempt": attempt,
                "last_plan_version": version,
            },
        )
        return {"applied": 1}

    def _record_plan_runtime_wait(self, run: dict[str, Any], attempt: dict[str, Any], runtime_wait: Any, payload: dict[str, Any]) -> None:
        record = build_runtime_wait_record(run, attempt, runtime_wait)
        self.coordinator.record_runtime_wait(str(run["run_id"]), record)
        self._complete_plan_attempt(run, attempt, state="blocked", reason=f"runtime_wait:{record['wait_id']}", payload=payload)

    def _complete_plan_attempt(
        self,
        run: dict[str, Any],
        attempt: dict[str, Any],
        *,
        state: str,
        reason: str,
        payload: dict[str, Any],
        retryable: bool = False,
    ) -> None:
        current = self.store.get_run(str(run["run_id"])) or run
        completed = _completed_attempts(current)
        attempt_id = str(attempt.get("attempt_id") or "")
        if not any(str(candidate.get("attempt_id") or "") == attempt_id for candidate in completed):
            completed.append(
                _complete_attempt(
                    {**attempt, "sanitized_error": reason, "retryable": retryable},
                    state=state,
                    events=_events_from_payload(payload),
                    thread_id=str(payload.get("thread_id") or ""),
                )
            )
        self.store.merge_run_payload(
            str(run["run_id"]),
            {"active_attempt": {}, "active_attempts": [], "completed_attempts": completed, "last_plan_attempt": attempt},
        )

    @staticmethod
    def _approved_plan_revision(run: dict[str, Any]) -> dict[str, Any]:
        payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
        revision = payload.get("approved_plan_revision") if isinstance(payload.get("approved_plan_revision"), dict) else {}
        return dict(revision) if revision.get("state") == "planning" and revision.get("work_item_id") else {}


__all__ = ["ConductorManagedRunPlanCollectionMixin"]
