from __future__ import annotations

from typing import Any

from performer_api.managed_runs import (
    ManagedRunPlan,
    ManagedRunPlanValidator,
    WorkItemResult,
    WorkItemResultStatus,
)

from .conductor_managed_run_coordinator_checkpoints import ConductorManagedRunCheckpointMixin
from .conductor_managed_run_coordinator_helpers import (
    LOGGER,
    _active_work_item_ids,
    _log_blocked,
    _parallel_compatible,
    _review_relevant_file,
)
from .conductor_managed_run_coordinator_human import ConductorManagedRunHumanActionMixin
from .conductor_managed_run_coordinator_runtime_waits import ConductorManagedRunRuntimeWaitMixin
from .conductor_managed_run_state import ManagedRunState, WorkItemState
from .conductor_managed_run_store import ConductorManagedRunStore, ManagedRunDispatchAccepted


class ConductorManagedRunCoordinator(
    ConductorManagedRunRuntimeWaitMixin,
    ConductorManagedRunHumanActionMixin,
    ConductorManagedRunCheckpointMixin,
):
    def __init__(
        self,
        *,
        store: ConductorManagedRunStore,
        plan_validation_retry_limit: int = 2,
    ) -> None:
        self.store = store
        self.plan_validation_retry_limit = max(0, int(plan_validation_retry_limit))

    def accept_dispatch(self, event: dict[str, Any], *, instance_id: str) -> ManagedRunDispatchAccepted:
        accepted = self.store.accept_dispatch(event, instance_id=instance_id)
        self.store.update_run_state(accepted.run_id, ManagedRunState.PLANNING)
        return accepted

    def apply_plan(
        self,
        run_id: str,
        plan: ManagedRunPlan,
        *,
        backend_session_id: str = "",
        creator_attempt_id: str = "",
    ) -> int:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        if int(run.get("plan_version") or 0) > 0:
            raise ValueError("accepted plan is immutable; use approve_plan_revision")
        errors = ManagedRunPlanValidator().validate(plan)
        if errors:
            reason = ",".join(error.value for error in errors)
            failure_count = self.store.record_plan_validation_failure(run_id, reason=reason)
            exhausted = failure_count > self.plan_validation_retry_limit
            if exhausted:
                visible_reason = f"plan_validation_retries_exhausted:{reason}"
                self.store.update_run_state(run_id, ManagedRunState.BLOCKED, reason=visible_reason)
                _log_blocked(
                    run_id=run_id,
                    work_item_id="",
                    error_code="plan_validation_retries_exhausted",
                    reason=visible_reason,
                    action_required="revise_plan",
                )
            else:
                visible_reason = f"plan_validation_retry:{failure_count}/{self.plan_validation_retry_limit}:{reason}"
                self.store.update_run_state(run_id, ManagedRunState.PLANNING, reason=visible_reason)
                LOGGER.warning(
                    "event=managed_run_plan_validation_retry run_id=%s error_code=invalid_plan sanitized_reason=%s retryable=true attempt_number=%s next_action=retry_plan",
                    run_id,
                    visible_reason,
                    failure_count,
                )
            return 0
        self.store.update_run_state(run_id, ManagedRunState.PROJECTING_PLAN)
        version = self.store.save_plan(
            run_id,
            plan,
            backend_session_id=backend_session_id,
            creator_attempt_id=creator_attempt_id,
        )
        if plan.approval_required:
            self.store.update_run_state(run_id, ManagedRunState.AWAITING_APPROVAL, reason="plan_approval_required")
            LOGGER.info(
                "event=managed_run_plan_approval_required run_id=%s plan_version=%s action_required=approve_plan",
                run_id,
                version,
            )
            return version
        self.store.update_run_state(run_id, ManagedRunState.READY)
        return version

    def next_ready_work_item(self, run_id: str) -> dict[str, Any] | None:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        if run.get("state") not in {ManagedRunState.READY.value, ManagedRunState.EXECUTING.value}:
            return None
        if self._pending_checkpoint(run_id) is not None:
            return None
        items = self.store.list_work_items(run_id)
        done_ids = {item["work_item_id"] for item in items if item["state"] == WorkItemState.DONE.value}
        for item in items:
            if item["state"] != WorkItemState.TODO.value:
                continue
            dependencies = item["payload"].get("dependencies") if isinstance(item.get("payload"), dict) else []
            if all(str(dependency) in done_ids for dependency in dependencies or []) and self._can_start_next(run, item, items):
                return item
        return None

    def start_work_item(self, run_id: str, work_item_id: str) -> dict[str, Any]:
        current = self._work_item(run_id, work_item_id)
        if current["state"] != WorkItemState.TODO.value:
            raise ValueError(f"work item is not ready to start: {work_item_id}")
        payload = current.get("payload") if isinstance(current.get("payload"), dict) else {}
        if bool(payload.get("needs_human_approval")) and not str(current.get("gate_status") or "").startswith("human_approval_approved:"):
            reason = "human_approval_required"
            self.store.update_run_state(run_id, ManagedRunState.AWAITING_APPROVAL, active_work_item_id=work_item_id, reason=reason)
            self.store.update_work_item_state(run_id, work_item_id, WorkItemState.BLOCKED, gate_status=reason)
            _log_blocked(run_id=run_id, work_item_id=work_item_id, error_code=reason, reason=reason, action_required="approve_work_item")
            return self._work_item(run_id, work_item_id)
        self.store.update_run_state(run_id, ManagedRunState.EXECUTING, active_work_item_id=work_item_id)
        self.store.update_work_item_state(run_id, work_item_id, WorkItemState.IN_PROGRESS, gate_status="turn started")
        updated = self._work_item(run_id, work_item_id)
        return updated

    def submit_work_item_result(self, run_id: str, result: WorkItemResult) -> dict[str, Any]:
        current = self._work_item(run_id, result.work_item_id)
        if current["state"] != WorkItemState.IN_PROGRESS.value:
            raise ValueError(f"work item is not in progress: {result.work_item_id}")
        if result.status_claimed is WorkItemResultStatus.BLOCKED:
            reason = result.blocked_reason or "blocked"
            self.store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=result.work_item_id, reason=reason)
            self.store.update_work_item_state(
                run_id,
                result.work_item_id,
                WorkItemState.BLOCKED,
                gate_status=reason,
                result=result.to_dict(),
            )
            _log_blocked(run_id=run_id, work_item_id=result.work_item_id, error_code="backend_blocked", reason=reason, action_required="operator_review")
            return self._work_item(run_id, result.work_item_id)
        if result.status_claimed is WorkItemResultStatus.PLAN_REVISION_REQUESTED:
            self.store.update_run_state(
                run_id,
                ManagedRunState.BLOCKED,
                active_work_item_id=result.work_item_id,
                reason="plan_revision_requested",
            )
            self.store.update_work_item_state(
                run_id,
                result.work_item_id,
                WorkItemState.BLOCKED,
                gate_status="plan_revision_requested",
                result=result.to_dict(),
            )
            _log_blocked(run_id=run_id, work_item_id=result.work_item_id, error_code="plan_revision_requested", reason="plan_revision_requested", action_required="approve_plan_revision")
            return self._work_item(run_id, result.work_item_id)
        review_errors = self._review_gate_errors(current, result)
        if review_errors:
            reason = ",".join(review_errors)
            self.store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=result.work_item_id, reason=reason)
            self.store.update_work_item_state(
                run_id,
                result.work_item_id,
                WorkItemState.BLOCKED,
                gate_status=reason,
                result=result.to_dict(),
            )
            _log_blocked(run_id=run_id, work_item_id=result.work_item_id, error_code="review_gate_failed", reason=reason, action_required="revise_or_fix_work_item")
            return self._work_item(run_id, result.work_item_id)
        self.store.update_run_state(run_id, ManagedRunState.REVIEWING, active_work_item_id=result.work_item_id)
        self.store.update_work_item_state(
            run_id,
            result.work_item_id,
            WorkItemState.IN_REVIEW,
            gate_status="result ready for managed_run verification",
            result=result.to_dict(),
        )
        return self._work_item(run_id, result.work_item_id)

    def verify_work_item(
        self,
        run_id: str,
        work_item_id: str,
        *,
        gate_status: str,
        passed: bool = True,
        score: int = 3,
    ) -> dict[str, Any]:
        current = self._work_item(run_id, work_item_id)
        if current["state"] != WorkItemState.IN_REVIEW.value:
            raise ValueError(f"work item is not in review: {work_item_id}")
        if passed and score < 3:
            gate_status = f"verification_score_below_threshold:{score}"
            passed = False
        elif passed and score > 4:
            gate_status = f"verification_score_out_of_range:{score}"
            passed = False
        if not passed:
            reason = gate_status or "verification_failed"
            self.store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=work_item_id, reason=reason)
            self.store.update_work_item_state(run_id, work_item_id, WorkItemState.BLOCKED, gate_status=reason)
            _log_blocked(run_id=run_id, work_item_id=work_item_id, error_code="verification_failed", reason=reason, action_required="fix_work_item")
            return self._work_item(run_id, work_item_id)
        self.store.update_work_item_state(run_id, work_item_id, WorkItemState.DONE, gate_status=gate_status)
        pending_checkpoint = self._pending_checkpoint(run_id)
        if pending_checkpoint is not None:
            self.store.update_run_state(
                run_id,
                ManagedRunState.READY,
                reason=f"checkpoint_pending:{','.join(pending_checkpoint.after)}",
            )
        elif self._all_work_items_terminal(run_id):
            self.store.update_run_state(run_id, ManagedRunState.VERIFIED, reason="awaiting_final_projection")
        else:
            self.store.update_run_state(run_id, ManagedRunState.READY)
        return self._work_item(run_id, work_item_id)

    def _review_gate_errors(self, current: dict[str, Any], result: WorkItemResult) -> list[str]:
        errors: list[str] = []
        payload = current.get("payload") if isinstance(current.get("payload"), dict) else {}
        declared_files = {str(path) for path in payload.get("files_likely_touched") or []}
        undeclared_files = sorted({path for path in result.undeclared_files if _review_relevant_file(path)})
        unplanned_files = sorted({changed.path for changed in result.changed_files if not changed.planned and _review_relevant_file(changed.path)})
        changed_paths = {changed.path for changed in result.changed_files if _review_relevant_file(changed.path)}
        out_of_scope = sorted(path for path in changed_paths if declared_files and path not in declared_files)
        if undeclared_files:
            errors.append(f"undeclared_files:{'|'.join(undeclared_files)}")
        if unplanned_files:
            errors.append(f"unplanned_changed_files:{'|'.join(unplanned_files)}")
        if out_of_scope:
            errors.append(f"out_of_scope_files:{'|'.join(out_of_scope)}")
        tests = result.tests if isinstance(result.tests, dict) else {}
        if not tests.get("red_observed"):
            errors.append("red_not_observed")
        expected_green = set((payload.get("verification") or {}).get("green_commands") or []) if isinstance(payload.get("verification"), dict) else set()
        observed_green = set(tests.get("green_commands_run") or []) if isinstance(tests.get("green_commands_run"), list) else set()
        if expected_green and not expected_green.issubset(observed_green):
            errors.append("missing_green_commands")
        if "secret_scan_passed" not in tests:
            errors.append("secrets_check_missing")
        elif tests.get("secret_scan_passed") is not True:
            errors.append("secrets_check_failed")
        acceptance_results = result.acceptance_results
        if not acceptance_results or any(str(item.get("status") or "").lower() not in {"passed", "pass", "ok"} for item in acceptance_results):
            errors.append("acceptance_failed")
        return errors

    def _work_item(self, run_id: str, work_item_id: str) -> dict[str, Any]:
        for item in self.store.list_work_items(run_id):
            if item["work_item_id"] == work_item_id:
                return item
        raise KeyError(work_item_id)

    def _can_start_next(self, run: dict[str, Any], candidate: dict[str, Any], items: list[dict[str, Any]]) -> bool:
        if run.get("state") == ManagedRunState.READY.value:
            return True
        active_ids = _active_work_item_ids(run)
        if not active_ids:
            return False
        active_items = [item for item in items if str(item.get("work_item_id") or "") in active_ids]
        return bool(active_items) and all(_parallel_compatible(candidate, active) for active in active_items)



__all__ = ["ConductorManagedRunCoordinator"]
