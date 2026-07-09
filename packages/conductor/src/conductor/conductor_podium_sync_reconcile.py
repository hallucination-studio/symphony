from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .conductor_pipeline import PipelineScheduler, _append_instance_log
from .conductor_podium_sync_report import _instance_for_attempt_pid
from performer_api.pipeline import AttemptState, HumanEscalationReason


class PodiumReconcileMixin:
    def _surface_stuck_nodes(self) -> int:
        surfaced = 0
        scheduler = PipelineScheduler(self.pipeline_store)
        stuck_node_ids = set(scheduler.find_stuck_nodes())
        self.pipeline_store.clear_stuck_node_observations_except(stuck_node_ids)
        existing_wait_nodes = {
            str(wait.get("node_id") or "")
            for wait in self.pipeline_store.list_human_waits()
            if str(wait.get("status") or "waiting") == "waiting"
        }
        findings = getattr(self, "_pipeline_reconcile_findings", None)
        if findings is None:
            findings = []
            self._pipeline_reconcile_findings = findings
        for node_id in sorted(stuck_node_ids):
            blocked_by: list[str] = []
            for blocker_id in self.pipeline_store.blockers_for(node_id):
                try:
                    blocker = self.pipeline_store.get_node(blocker_id)
                except KeyError:
                    blocked_by.append(f"{blocker_id}: missing blocker")
                    continue
                blocked_by.extend(self.pipeline_store._dependency_block_reasons(blocker))
            reason_text = "; ".join(blocked_by) if blocked_by else "pipeline node has no live driver"
            observation = self.pipeline_store.record_stuck_node_observation(
                node_id,
                reason=reason_text,
            )
            node = self.pipeline_store.get_node(node_id)
            finding = {
                "event": "pipeline_node_stuck",
                "severity": "warning",
                "error_type": "RuntimeError",
                "sanitized_reason": reason_text,
                "action_required": "inspect_pipeline_node",
                "retryable": True,
                "node_id": node_id,
                "state": node.state.value,
                "graph_revision": self.pipeline_store.current_graph_revision(),
                "blocked_by": blocked_by,
                "observation_count": int(observation.get("count") or 0),
                "first_seen_at": observation.get("first_seen_at"),
                "last_seen_at": observation.get("last_seen_at"),
            }
            findings.append(finding)
            if node_id not in existing_wait_nodes:
                self.pipeline_store.create_human_wait(
                    node_id,
                    reason=HumanEscalationReason.CAPACITY_STARVED.value,
                    details={
                        "error": f"pipeline node has no live driver: {reason_text}",
                        "blocked_by": blocked_by,
                        "graph_revision": self.pipeline_store.current_graph_revision(),
                        "state": node.state.value,
                        "observation_count": int(observation.get("count") or 0),
                    },
                )
                existing_wait_nodes.add(node_id)
            surfaced += 1
        return surfaced

    def reconcile_pipeline_attempts_on_startup(self) -> int:
        failed = 0
        attempted: set[str] = set()
        instances = [self.get_instance(instance.id) or instance for instance in self.store.list_instances()]
        if not instances:
            return 0
        recover_attempt = getattr(self.runtime_manager, "recover_attempt", None)
        now = datetime.now(timezone.utc)
        for attempt in self.pipeline_store.list_attempts():
            if attempt.state is not AttemptState.RUNNING or attempt.attempt_id in attempted:
                continue
            if attempt.process_pid is None:
                continue
            attempted.add(attempt.attempt_id)
            instance = _instance_for_attempt_pid(instances, attempt.process_pid) or instances[0]
            result_path = Path(instance.instance_dir) / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
            if result_path.exists() or getattr(instance, "process_status", None) == "exited":
                continue
            recovered_instance = None
            if attempt.process_pid is not None and callable(recover_attempt):
                for instance in instances:
                    recovered_instance = recover_attempt(instance, attempt)
                    if recovered_instance is not None:
                        self.store.update_instance(recovered_instance)
                        break
            if recovered_instance is not None:
                continue
            error = f"running attempt process is not alive process_pid={attempt.process_pid or ''}".strip()
            if self.pipeline_store.fail_running_attempt_for_recovery(attempt.attempt_id, error=error, at=now):
                lease_id = attempt.lease_id
                _append_instance_log(
                    instance,
                    (
                        "pipeline_attempt_orphan_reconciled "
                        f"mode={attempt.mode.value} node_id={attempt.node_id} "
                        f"attempt_id={attempt.attempt_id} lease_id={lease_id} "
                        f"process_pid={attempt.process_pid or ''} "
                        f"error_type=ProcessExited sanitized_reason={error} "
                        "action_required=none retryable=True"
                    ),
                )
                failed += 1
        return failed

    def _fail_exited_pipeline_attempts(self) -> int:
        failed = 0
        for instance in self.store.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            drain_exited_attempts = getattr(self.runtime_manager, "drain_exited_attempts", None)
            if callable(drain_exited_attempts):
                for snapshot in drain_exited_attempts(refreshed):
                    failed += self.pipeline_coordinator.fail_exited_attempt_snapshot(refreshed, snapshot)
            failed += self.pipeline_coordinator.fail_running_attempts_for_exited_process(refreshed)
        return failed

    async def _start_due_pipeline_attempts(self) -> int:
        started = 0
        for instance in self.store.list_instances():
            refreshed = self.get_instance(instance.id) or instance
            started += await self.pipeline_coordinator.start_due_attempts(refreshed)
        return started

    def _collect_pipeline_result_files(self) -> int:
        applied = 0
        for instance in self.store.list_instances():
            applied += self.pipeline_coordinator.collect_result_files(instance)
        return applied

    def _collect_pipeline_runtime_waits(self) -> int:
        observed = 0
        for instance in self.store.list_instances():
            observed += self.pipeline_coordinator.observe_runtime_waits_from_logs(instance)
        return observed

    def _heartbeat_running_pipeline_leases(self) -> int:
        instances = self.store.list_instances()
        if not instances:
            return 0
        for instance in instances:
            self.get_instance(instance.id)
        return self.pipeline_coordinator.heartbeat_active_leases()

    def _process_pipeline_integrations(self) -> int:
        processed = 0
        for instance in self.store.list_instances():
            repo_path = str(getattr(instance, "resolved_repo_path", "") or "").strip()
            if not repo_path:
                continue
            processed += self.pipeline_store.process_queued_integrations(Path(repo_path), instance=instance)
        return processed

    def _drive_pipeline_convergence(self) -> int:
        return self.pipeline_coordinator.drive_convergence_once()
