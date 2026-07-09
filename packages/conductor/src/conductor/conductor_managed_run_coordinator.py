from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from performer_api.managed_runs import (
    Checkpoint,
    ManagedRunPlan,
    ManagedRunPlanValidator,
    ManagedRunState,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemState,
)

from .conductor_managed_run_store import ConductorManagedRunStore, ManagedRunDispatchAccepted, checkpoint_key_for

LOGGER = logging.getLogger(__name__)


class ConductorManagedRunCoordinator:
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

    def apply_plan(self, run_id: str, plan: ManagedRunPlan, *, backend_session_id: str = "") -> int:
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
            visible_reason = f"plan_validation_retries_exhausted:{reason}" if exhausted else reason
            self.store.update_run_state(
                run_id,
                ManagedRunState.BLOCKED,
                reason=visible_reason,
            )
            _log_blocked(
                run_id=run_id,
                work_item_id="",
                error_code="plan_validation_retries_exhausted" if exhausted else "invalid_plan",
                reason=visible_reason,
                action_required="revise_plan",
            )
            return 0
        self.store.update_run_state(run_id, ManagedRunState.PROJECTING_PLAN)
        version = self.store.save_plan(run_id, plan, backend_session_id=backend_session_id)
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

    def approve_plan(self, run_id: str, *, approval_id: str = "") -> None:
        run = self.store.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        if run.get("state") != ManagedRunState.AWAITING_APPROVAL.value or run.get("latest_reason") != "plan_approval_required":
            raise ValueError("run is not awaiting plan approval")
        marker = approval_id or "approved"
        self.store.update_run_state(run_id, ManagedRunState.READY, reason=f"plan_approved:{marker}")

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

    def approve_work_item(self, run_id: str, work_item_id: str, *, approval_id: str = "") -> dict[str, Any]:
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

    def verify_work_item(self, run_id: str, work_item_id: str, *, gate_status: str, passed: bool = True) -> dict[str, Any]:
        current = self._work_item(run_id, work_item_id)
        if current["state"] != WorkItemState.IN_REVIEW.value:
            raise ValueError(f"work item is not in review: {work_item_id}")
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

    def record_checkpoint_result(self, run_id: str, *, after_work_item_id: str, passed: bool, reason: str = "") -> None:
        checkpoint = self._checkpoint_for_after(run_id, after_work_item_id) or Checkpoint(after=[after_work_item_id], verify=[])
        self.store.record_checkpoint_result(
            run_id,
            after=checkpoint.after,
            verify=checkpoint.verify,
            passed=passed,
            reason=reason,
        )
        if not passed:
            sanitized = f"checkpoint_failed:{','.join(checkpoint.after)}:{reason or 'checkpoint failed'}"
            self.store.update_run_state(run_id, ManagedRunState.BLOCKED, reason=sanitized)
            _log_blocked(run_id=run_id, work_item_id=",".join(checkpoint.after), error_code="checkpoint_failed", reason=sanitized, action_required="fix_checkpoint")
            return
        pending = self._pending_checkpoint(run_id)
        if pending is not None:
            self.store.update_run_state(run_id, ManagedRunState.READY, reason=f"checkpoint_pending:{','.join(pending.after)}")
        elif self._all_work_items_terminal(run_id):
            self.store.update_run_state(run_id, ManagedRunState.VERIFIED, reason="awaiting_final_projection")
        else:
            self.store.update_run_state(run_id, ManagedRunState.READY)

    def run_pending_checkpoint(self, run_id: str, *, workspace_path: Path | str, timeout_seconds: int = 300) -> dict[str, Any] | None:
        checkpoint = self._pending_checkpoint(run_id)
        if checkpoint is None:
            return None
        workspace = Path(workspace_path)
        if not workspace.is_dir():
            reason = f"checkpoint_workspace_missing:{workspace}"
            self.record_checkpoint_result(run_id, after_work_item_id=checkpoint.after[0], passed=False, reason=reason)
            return self.store.list_checkpoint_results(run_id)[-1]
        for command in checkpoint.verify:
            try:
                completed = subprocess.run(
                    command,
                    cwd=workspace,
                    shell=True,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                reason = f"command_timeout:{command}:{_output_tail(exc.stdout or '', exc.stderr or '')}"
                self.record_checkpoint_result(run_id, after_work_item_id=checkpoint.after[0], passed=False, reason=reason)
                return self.store.list_checkpoint_results(run_id)[-1]
            if completed.returncode != 0:
                reason = f"command_failed:{command}:exit_{completed.returncode}:{_output_tail(completed.stdout, completed.stderr)}"
                self.record_checkpoint_result(run_id, after_work_item_id=checkpoint.after[0], passed=False, reason=reason)
                return self.store.list_checkpoint_results(run_id)[-1]
        reason = " && ".join(checkpoint.verify) if checkpoint.verify else "checkpoint passed"
        self.record_checkpoint_result(run_id, after_work_item_id=checkpoint.after[0], passed=True, reason=reason)
        return self.store.list_checkpoint_results(run_id)[-1]

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

    def _checkpoint_for_after(self, run_id: str, after_work_item_id: str) -> Checkpoint | None:
        plan = self.store.get_plan(run_id)
        if plan is None:
            return None
        for checkpoint in plan.checkpoints:
            if after_work_item_id in checkpoint.after:
                return checkpoint
        return None

    def _pending_checkpoint(self, run_id: str) -> Checkpoint | None:
        plan = self.store.get_plan(run_id)
        if plan is None:
            return None
        items = self.store.list_work_items(run_id)
        done_ids = {
            item["work_item_id"]
            for item in items
            if item["state"] in {WorkItemState.DONE.value, WorkItemState.CANCELLED.value}
        }
        passed = {
            result["checkpoint_key"]
            for result in self.store.list_checkpoint_results(run_id)
            if result.get("passed") is True
        }
        for checkpoint in plan.checkpoints:
            if all(item_id in done_ids for item_id in checkpoint.after) and checkpoint_key_for(checkpoint) not in passed:
                return checkpoint
        return None

    def _all_work_items_terminal(self, run_id: str) -> bool:
        items = self.store.list_work_items(run_id)
        return bool(items) and all(
            item["state"] in {WorkItemState.DONE.value, WorkItemState.CANCELLED.value}
            for item in items
        )


def _log_blocked(*, run_id: str, work_item_id: str, error_code: str, reason: str, action_required: str) -> None:
    LOGGER.error(
        "event=managed_run_blocked run_id=%s work_item_id=%s error_code=%s sanitized_reason=%s action_required=%s retryable=false",
        run_id,
        work_item_id or "-",
        error_code,
        _sanitize_reason(reason),
        action_required,
    )


def _sanitize_reason(reason: str) -> str:
    text = str(reason or "blocked").replace("\n", " ").replace("\r", " ")
    for marker in ("token=", "password=", "secret=", "authorization="):
        if marker in text.lower():
            return "redacted_sensitive_reason"
    return text[:300]


def _output_tail(stdout: Any, stderr: Any) -> str:
    text = f"{_to_text(stdout)}\n{_to_text(stderr)}".replace("\n", " ").replace("\r", " ").strip()
    return _sanitize_reason(text or "no output")[-200:]


def _review_relevant_file(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip()
    if not normalized:
        return False
    parts = [part for part in normalized.rstrip("/").split("/") if part]
    if any(part in {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".tox", ".nox"} for part in parts):
        return False
    return not normalized.endswith((".pyc", ".pyo", ".coverage"))


def _active_work_item_ids(run: dict[str, Any]) -> set[str]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    attempts = payload.get("active_attempts") if isinstance(payload.get("active_attempts"), list) else []
    ids = {
        str(attempt.get("work_item_id") or "")
        for attempt in attempts
        if isinstance(attempt, dict)
    }
    active = str(run.get("active_work_item_id") or "")
    if active:
        ids.add(active)
    return {item_id for item_id in ids if item_id}


def _parallel_compatible(candidate: dict[str, Any], active: dict[str, Any]) -> bool:
    candidate_policy = _parallel_policy(candidate)
    active_policy = _parallel_policy(active)
    if not (candidate_policy.get("safe_to_parallelize") and active_policy.get("safe_to_parallelize")):
        return False
    candidate_group = str(candidate_policy.get("parallel_group") or "")
    active_group = str(active_policy.get("parallel_group") or "")
    return not (candidate_group and active_group and candidate_group != active_group)


def _parallel_policy(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    policy = payload.get("parallelization") if isinstance(payload.get("parallelization"), dict) else {}
    return policy


def _to_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return str(value or "")


__all__ = ["ConductorManagedRunCoordinator"]
