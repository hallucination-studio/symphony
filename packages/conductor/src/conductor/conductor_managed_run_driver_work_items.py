from __future__ import annotations

from pathlib import Path
from typing import Any

from performer_api.managed_runs import GateSnapshot, ManagedRunRuntimeRole, ManagedRunState, RuntimeConfigEnvelope, WorkItemResult

from .conductor_managed_run_branch_join import prepare_checkpoint_workspace, prepare_execution_workspace
from .conductor_managed_run_driver_helpers import (
    _active_attempts,
    _attempt_paths,
    _attempt_payload,
    _complete_attempt,
    _completed_attempt_for_work_item,
    _completed_attempts,
    _role_capacity,
    _sanitize,
    _task_output_manifest,
    _verification_input_snapshot,
    _write_json,
)
from .conductor_managed_run_fencing import attempt_fencing_fields, build_turn_context
from .conductor_managed_run_runtime_waits import runtime_wait_probe_requested
from .conductor_managed_run_driver_attempt_collection import ConductorManagedRunAttemptCollectionMixin
from .conductor_managed_run_execution import ExecutionHandoff
from .conductor_managed_run_verifier import run_local_verifier
from .conductor_managed_run_workspace_events import log_workspace_failure
from .conductor_models import InstanceRecord
from .runtime_backends import prepare_backend_environment


class ConductorManagedRunWorkItemMixin(ConductorManagedRunAttemptCollectionMixin):
    async def _start_or_checkpoint_next_work_item(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        checkpoint = self._run_pending_checkpoint(run, instance)
        if checkpoint is not None and not checkpoint.get("passed"):
            return {"failed": 1}
        envelope = self._runtime_config_or_fail(str(run["run_id"]))
        if envelope is None:
            return {"failed": 1}
        limit = _role_capacity(envelope, ManagedRunRuntimeRole.WORK_ITEM)
        started = 0
        while started < limit:
            item = self.coordinator.next_ready_work_item(str(run["run_id"]))
            if item is None:
                break
            workspace = prepare_execution_workspace(
                self.store,
                Path(instance.resolved_repo_path),
                run=run,
                item=item,
                state_root=Path(instance.instance_dir) / "state",
            )
            if workspace.failed or workspace.workspace_path is None:
                reason = workspace.reason or "execution_workspace_missing"
                if not workspace.failed:
                    self.store.update_run_state(str(run["run_id"]), ManagedRunState.FAILED, reason=reason)
                log_workspace_failure(
                    run,
                    instance,
                    work_item_id=str(item.get("work_item_id") or ""),
                    reason=reason,
                    branch_name=workspace.branch_name,
                )
                return {"started": started, "failed": 1} if started else {"failed": 1}
            await self._start_work_item_turn(
                run,
                instance,
                item,
                envelope=envelope,
                workspace_path=workspace.workspace_path,
                base_revision=workspace.base_revision,
                branch_name=workspace.branch_name,
            )
            started += 1
            refreshed = self.store.get_run(str(run["run_id"]))
            if refreshed is not None:
                run = refreshed
        return {"started": started} if started else {}

    async def _start_work_item_turn(
        self,
        run: dict[str, Any],
        instance: InstanceRecord,
        item: dict[str, Any],
        *,
        envelope: RuntimeConfigEnvelope,
        workspace_path: Path,
        base_revision: str,
        branch_name: str,
    ) -> dict[str, int]:
        started_item = self.coordinator.start_work_item(str(run["run_id"]), str(item["work_item_id"]))
        attempt = _attempt_paths(instance, run, "work_item", str(item["work_item_id"]))
        context = build_turn_context(
            run,
            attempt,
            work_item_id=str(item["work_item_id"]),
            policy_revision=envelope.managed_run_policy.version,
        )
        if attempt["result_path"].exists():
            attempt["result_path"].unlink()
        _write_json(
            attempt["request_path"],
            {
                "turn_kind": "work_item",
                "workspace_path": str(workspace_path),
                "thread_id": run.get("backend_session_id") or "",
                "work_item": started_item.get("payload") or item.get("payload") or {},
                "context": context.to_dict(),
                "runtime_wait_probe": runtime_wait_probe_requested(
                    run.get("payload") if isinstance(run.get("payload"), dict) else {},
                    str(item["work_item_id"]),
                    (envelope.profiles.get(ManagedRunRuntimeRole.WORK_ITEM).settings or {}).get("emit_runtime_wait_probe"),
                ),
            },
        )
        env = prepare_backend_environment(
            Path(instance.instance_dir) / "state",
            envelope.profiles.get(ManagedRunRuntimeRole.WORK_ITEM),
            workspace_path=str(workspace_path),
            home_scope=attempt["attempt_id"],
        )
        started = await self.runtime_manager.start(
            instance,
            env=env,
            mode="execute",
            attempt_id=attempt["attempt_id"],
            attempt_request_path=str(attempt["request_path"]),
            attempt_result_path=str(attempt["result_path"]),
            lease_id=context.lease_id,
        )
        self.instance_update(started)
        attempt_payload = {
            **_attempt_payload(attempt, "work_item", work_item_id=str(item["work_item_id"])),
            "workspace_path": str(workspace_path),
            "base_revision": base_revision,
            "branch_name": branch_name,
            **attempt_fencing_fields(context),
        }
        active_attempts = _active_attempts(self.store.get_run(str(run["run_id"])) or run)
        self.store.merge_run_payload(
            str(run["run_id"]),
            {
                "active_attempt": attempt_payload,
                "active_attempts": [*active_attempts, attempt_payload],
                "last_managed_run_policy_id": envelope.managed_run_policy.policy_id,
                "last_managed_run_policy_version": envelope.managed_run_policy.version,
            },
        )
        return {"started": 1}

    def _verify_active_work_item(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, int]:
        items = [row for row in self.store.list_work_items(str(run["run_id"])) if row["state"] == "in_review" and isinstance(row.get("result"), dict)]
        if not items:
            return {}
        applied = 0
        for item in items:
            result = WorkItemResult.from_dict(item["result"])
            handoff_payload = self.store.get_execution_handoff(str(run["run_id"]), str(item["work_item_id"]))
            if handoff_payload is None:
                self.coordinator.verify_work_item(str(run["run_id"]), str(item["work_item_id"]), gate_status="execution_handoff_missing", passed=False)
                return {"failed": 1}
            handoff = ExecutionHandoff.from_dict(handoff_payload)
            verify_attempt = _attempt_payload(_attempt_paths(instance, self.store.get_run(str(run["run_id"])) or run, "verify", str(item["work_item_id"])), "verify", work_item_id=str(item["work_item_id"]))
            execute_attempt = _completed_attempt_for_work_item(run, str(item["work_item_id"]))
            gate_hash = str(execute_attempt.get("gate_snapshot_hash") or "")
            gate_payload = self.store.get_gate_snapshot(gate_hash) if gate_hash else None
            score = 0
            if gate_payload is None:
                status = f"gate_snapshot_missing:{gate_hash or 'execute_attempt_gate_hash_missing'}"
                evidence = {"execute_attempt_id": str(execute_attempt.get("attempt_id") or ""), "gate_snapshot_hash": gate_hash}
                passed = False
            else:
                gate = GateSnapshot.from_dict(gate_payload)
                try:
                    outcome = run_local_verifier(
                        gate,
                        result,
                        source_workspace=Path(instance.resolved_repo_path),
                        state_root=Path(instance.instance_dir) / "state",
                        verify_attempt_id=str(verify_attempt["attempt_id"]),
                        execute_commit_sha=handoff.commit_sha,
                        artifact_hashes=handoff.artifact_hashes,
                    )
                    status = outcome.gate_status
                    evidence = outcome.evidence
                    passed = outcome.passed
                    score = outcome.score if passed else 0
                except Exception as exc:
                    status = f"verification_runner_failed:{_sanitize(exc)}"
                    evidence = {}
                    passed = False
            completed = _complete_attempt(
                {
                    **verify_attempt,
                    "gate_snapshot_hash": gate_hash,
                    "verify_score": score,
                    "verification_evidence": evidence,
                    "sanitized_error": "" if passed else status,
                },
                state="succeeded" if passed else "failed",
            )
            self._append_completed_attempt(str(run["run_id"]), completed)
            if not passed:
                self.coordinator.verify_work_item(str(run["run_id"]), str(item["work_item_id"]), gate_status=status, passed=False)
                return {"failed": 1}
            self.coordinator.verify_work_item(
                str(run["run_id"]),
                str(item["work_item_id"]),
                gate_status="verification passed",
                score=score,
            )
            self._record_successful_verification(
                run,
                item,
                result,
                handoff,
                verify_attempt=completed,
                score=score,
            )
            applied += 1
        checkpoint = self._run_pending_checkpoint(self.store.get_run(str(run["run_id"])) or run, instance)
        if checkpoint is not None and not checkpoint.get("passed"):
            return {"applied": applied, "failed": 1}
        return {"applied": applied}

    def _append_completed_attempt(self, run_id: str, attempt: dict[str, Any]) -> None:
        current = self.store.get_run(run_id) or {}
        completed = _completed_attempts(current)
        attempt_id = str(attempt.get("attempt_id") or "")
        if not any(str(candidate.get("attempt_id") or "") == attempt_id for candidate in completed):
            completed.append(attempt)
            self.store.merge_run_payload(run_id, {"completed_attempts": completed})

    def _record_successful_verification(
        self,
        run: dict[str, Any],
        item: dict[str, Any],
        result: WorkItemResult,
        handoff: ExecutionHandoff,
        *,
        verify_attempt: dict[str, Any],
        score: int,
    ) -> None:
        run_id = str(run["run_id"])
        work_item_id = str(item["work_item_id"])
        attempt = _completed_attempt_for_work_item(run, work_item_id)
        gate = next((snapshot for snapshot in self.store.list_gate_snapshots(run_id) if snapshot.get("work_item_id") == work_item_id), {})
        gate_hash = str(gate.get("content_hash") or "")
        self.store.record_verification_input(
            run_id,
            _verification_input_snapshot(item, result, attempt=attempt, gate_snapshot_hash=gate_hash, handoff=handoff),
        )
        self.store.publish_task_output_manifest(
            run_id,
            _task_output_manifest(
                item,
                result,
                attempt=attempt,
                verify_attempt_id=str(verify_attempt.get("attempt_id") or ""),
                plan_version=int(run.get("plan_version") or 0),
                handoff=handoff,
                score=score,
            ),
        )

    def _run_pending_checkpoint(self, run: dict[str, Any], instance: InstanceRecord) -> dict[str, Any] | None:
        run_id = str(run["run_id"])
        checkpoint = self.coordinator.pending_checkpoint(run_id)
        if checkpoint is None:
            return None
        workspace = prepare_checkpoint_workspace(
            self.store,
            Path(instance.resolved_repo_path),
            run=run,
            after_work_item_ids=checkpoint.after,
            state_root=Path(instance.instance_dir) / "state",
        )
        if workspace.failed or workspace.workspace_path is None:
            reason = workspace.reason or "checkpoint_workspace_missing"
            log_workspace_failure(
                run,
                instance,
                work_item_id=f"checkpoint:{'-'.join(checkpoint.after)}",
                reason=reason,
                branch_name=workspace.branch_name,
            )
            self.coordinator.record_checkpoint_result(run_id, after_work_item_id=checkpoint.after[0], passed=False, reason=reason)
            return {"passed": False, "reason": reason}
        return self.coordinator.run_pending_checkpoint(run_id, workspace_path=workspace.workspace_path)

__all__ = ["ConductorManagedRunWorkItemMixin"]
