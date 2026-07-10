from __future__ import annotations

from performer_api.managed_runs import ManagedRunPlan, ManagedRunPlanValidator, ManagedRunState, WorkItemResultStatus, WorkItemState

from .conductor_managed_run_coordinator_helpers import LOGGER, _log_blocked


class ConductorManagedRunHumanActionMixin:
    def approve_plan(self, run_id: str, *, approval_id: str = "") -> None:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        if run.get("state") != ManagedRunState.AWAITING_APPROVAL.value or run.get("latest_reason") != "plan_approval_required":
            raise ValueError("run is not awaiting plan approval")
        marker = approval_id or "approved"
        self.store.update_run_state(run_id, ManagedRunState.READY, reason=f"plan_approved:{marker}")
        LOGGER.info(
            "event=managed_run_plan_approved run_id=%s action_required=none approval_id=%s",
            run_id,
            marker,
        )

    def approve_plan_revision(
        self,
        run_id: str,
        plan: ManagedRunPlan,
        *,
        backend_session_id: str = "",
        approval_id: str = "",
    ) -> int:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        active_work_item_id = str(run.get("active_work_item_id") or "")
        if run.get("state") != ManagedRunState.BLOCKED.value or run.get("latest_reason") != "plan_revision_requested":
            raise ValueError("run is not awaiting an approved plan revision")
        current = self._work_item(run_id, active_work_item_id)
        result = current.get("result") if isinstance(current.get("result"), dict) else {}
        if result.get("status_claimed") != WorkItemResultStatus.PLAN_REVISION_REQUESTED.value:
            raise ValueError("active work item did not request a plan revision")
        errors = ManagedRunPlanValidator().validate(plan)
        if errors:
            reason = ",".join(error.value for error in errors)
            self.store.update_run_state(run_id, ManagedRunState.BLOCKED, active_work_item_id=active_work_item_id, reason=reason)
            self.store.update_work_item_state(run_id, active_work_item_id, WorkItemState.BLOCKED, gate_status=reason)
            _log_blocked(run_id=run_id, work_item_id=active_work_item_id, error_code="invalid_plan_revision", reason=reason, action_required="revise_plan")
            return 0
        self.store.update_run_state(run_id, ManagedRunState.PROJECTING_PLAN, active_work_item_id=active_work_item_id)
        version = self.store.save_plan(run_id, plan, backend_session_id=backend_session_id)
        approval_marker = approval_id or "approved"
        self.store.update_work_item_state(
            run_id,
            active_work_item_id,
            WorkItemState.TODO,
            gate_status=f"plan_revision_approved:{approval_marker}",
        )
        self.store.update_run_state(run_id, ManagedRunState.READY, reason=f"plan_revision_approved:{approval_marker}")
        return version

    def approve_work_item(self, run_id: str, work_item_id: str, *, approval_id: str = "") -> dict[str, object]:
        current = self._work_item(run_id, work_item_id)
        if current["state"] != WorkItemState.BLOCKED.value or current.get("gate_status") != "human_approval_required":
            raise ValueError(f"work item is not awaiting human approval: {work_item_id}")
        marker = approval_id or "approved"
        self.store.update_work_item_state(
            run_id,
            work_item_id,
            WorkItemState.TODO,
            gate_status=f"human_approval_approved:{marker}",
        )
        self.store.update_run_state(run_id, ManagedRunState.READY, active_work_item_id=work_item_id, reason=f"human_approval_approved:{marker}")
        return self._work_item(run_id, work_item_id)

    def reopen_blocked_work_item(self, run_id: str, work_item_id: str, *, action_id: str = "") -> dict[str, object]:
        current = self._work_item(run_id, work_item_id)
        reason = str(current.get("gate_status") or "")
        if current["state"] != WorkItemState.BLOCKED.value or not reason:
            raise ValueError(f"work item is not blocked: {work_item_id}")
        if reason == "plan_revision_requested":
            raise ValueError("plan revision requires an approved plan")
        marker = action_id or "operator"
        resumed_reason = f"operator_reopened:{marker}"
        self.store.update_work_item_state(run_id, work_item_id, WorkItemState.TODO, gate_status=resumed_reason)
        self.store.update_run_state(run_id, ManagedRunState.READY, active_work_item_id=work_item_id, reason=resumed_reason)
        LOGGER.info(
            "event=managed_run_blocked_work_item_reopened run_id=%s work_item_id=%s error_code=%s action_required=none",
            run_id,
            work_item_id,
            reason,
        )
        return self._work_item(run_id, work_item_id)

    def reopen_blocked_run(self, run_id: str, *, action_id: str = "") -> None:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        reason = str(run.get("latest_reason") or "")
        if run.get("state") != ManagedRunState.BLOCKED.value or not reason:
            raise ValueError("run is not blocked")
        if reason == "plan_revision_requested":
            raise ValueError("plan revision requires an approved plan")
        marker = action_id or "operator"
        resumed_reason = f"operator_reopened:{marker}"
        state = ManagedRunState.PLANNING if int(run.get("plan_version") or 0) == 0 else ManagedRunState.READY
        self.store.update_run_state(
            run_id,
            state,
            active_work_item_id=str(run.get("active_work_item_id") or ""),
            reason=resumed_reason,
        )
        self.store.merge_run_payload(
            run_id,
            {"last_human_action_resolution": {"action_id": marker, "previous_reason": reason}},
        )
        LOGGER.info(
            "event=managed_run_blocked_run_reopened run_id=%s error_code=%s sanitized_reason=%s action_required=none retryable=true next_action=%s",
            run_id,
            reason,
            reason,
            state.value,
        )
