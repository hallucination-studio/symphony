from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from performer_api.managed_runs import Checkpoint, ManagedRunState, WorkItemState

from conductor.conductor_managed_run_coordinator_helpers import _log_blocked, _output_tail
from conductor.conductor_managed_run_store_rows import checkpoint_key_for


class ConductorManagedRunCheckpointMixin:
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

    def pending_checkpoint(self, run_id: str) -> Checkpoint | None:
        return self._pending_checkpoint(run_id)

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

