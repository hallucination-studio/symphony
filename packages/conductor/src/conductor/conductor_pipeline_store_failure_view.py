from __future__ import annotations

from .conductor_pipeline_store_common import *


class FailureViewMixin:
    def _deactivate_lease(self, lease_id: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE worker_leases SET active = 0 WHERE lease_id = ?", (lease_id,))

    def fail_running_attempt_for_recovery(
        self,
        attempt_id: str,
        *,
        error: str,
        at: datetime,
    ) -> bool:
        try:
            attempt = self.get_attempt(attempt_id)
        except KeyError:
            return False
        if attempt.state is not AttemptState.RUNNING:
            return False
        lease = self.active_lease(attempt.node_id, attempt.mode)
        if lease is None or lease.attempt_id != attempt.attempt_id:
            return False
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=AttemptState.FAILED,
            graph_revision=attempt.graph_revision,
            policy_revision=attempt.policy_revision,
            lease_id=attempt.lease_id,
            fencing_token=attempt.fencing_token,
            gate_snapshot_hash=attempt.gate_snapshot_hash,
            score=attempt.score,
            started_at=attempt.started_at,
            completed_at=_format_time(_utc(at)),
            result_uri=attempt.result_uri,
            error=error,
            process_pid=attempt.process_pid,
            thread_id=attempt.thread_id,
            kind=attempt.kind,
        )
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE attempts
                SET state = ?, payload_json = ?
                WHERE attempt_id = ?
                """,
                (AttemptState.FAILED.value, _json_dumps(updated.to_dict()), updated.attempt_id),
            )
            connection.execute("UPDATE worker_leases SET active = 0 WHERE lease_id = ?", (lease.lease_id,))
        self.update_node_state(attempt.node_id, _retry_state_for_attempt_mode(attempt.mode))
        self.resolve_runtime_waits_for_attempt(updated.attempt_id, resolution="attempt failed during startup recovery")
        return True

    def _create_attempt_failure_human_wait(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        error: str | None = None,
    ) -> None:
        visible_error = error if error is not None else _visible_attempt_error(result)
        if isinstance(result, PlanAttemptResult):
            node = self.get_node(result.node_id)
            if node.state is GraphNodeState.REPLANNING and self.latest_failed_verify_attempt_for_node(result.node_id) is not None:
                reason = HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
            else:
                reason = _plan_failure_human_reason(visible_error)
        elif result.mode is RuntimeMode.VERIFY:
            reason = HumanEscalationReason.GATE_UNEXECUTABLE
        elif visible_error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in visible_error.lower():
            reason = HumanEscalationReason.THREAD_LOST
        else:
            reason = HumanEscalationReason.BACKEND_UNAVAILABLE
        self.create_human_wait(
            result.node_id,
            reason=reason.value,
            details={
                "mode": result.mode.value,
                "attempt_id": result.attempt_id,
                "lease_id": result.lease_id,
                "error": visible_error,
            },
        )

    def _handle_same_stage_attempt_failure(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        error: str,
    ) -> None:
        if error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in error.lower():
            self._create_attempt_failure_human_wait(result, error=error)
            return
        node = self.get_node(result.node_id)
        next_retry_count = node.rework_count + 1
        max_retries = self.active_runtime_config().scheduler_policy.max_rework_attempts
        if next_retry_count >= max_retries:
            reason = (
                HumanEscalationReason.GATE_UNEXECUTABLE
                if result.mode is RuntimeMode.VERIFY
                else HumanEscalationReason.BACKEND_UNAVAILABLE
            )
            self.create_human_wait(
                result.node_id,
                reason=reason.value,
                details={
                    "mode": result.mode.value,
                    "attempt_id": result.attempt_id,
                    "lease_id": result.lease_id,
                    "error": error,
                    "retry_count": next_retry_count,
                    "max_retries": max_retries,
                },
            )
            self.update_node_state(
                result.node_id,
                GraphNodeState.NEED_HUMAN,
                rework_count=next_retry_count,
                human_reason=reason,
            )
            return
        self.update_node_state(
            result.node_id,
            _retry_state_for_attempt_mode(result.mode),
            rework_count=next_retry_count,
            human_reason=None,
        )

    def pipeline_view(self) -> PipelineView:
        envelope = self.active_runtime_config()
        policy_source = self.active_runtime_config_source()
        scheduler_policy = self.latest_scheduler_tick_policy()
        nodes = self.list_nodes()
        active_leases = self._active_leases()
        modes: list[PipelineModeView] = []
        for mode in RuntimeMode:
            active_node_ids = sorted(lease.node_id for lease in active_leases if lease.mode is mode)
            queued = [
                node.node_id
                for node in nodes
                if _queued_mode_for_state(node.state) is mode and node.node_id not in active_node_ids
            ]
            modes.append(
                PipelineModeView(
                    mode=mode,
                    active=len(active_node_ids),
                    limit=envelope.scheduler_policy.capacity.by_mode.get(mode),
                    queued=len(queued),
                    node_ids=active_node_ids + sorted(queued),
                )
            )
        return PipelineView(
            graph_revision=self.current_graph_revision(),
            policy_revision=envelope.scheduler_policy.version,
            policy_id=envelope.scheduler_policy.policy_id,
            policy_source=policy_source,
            last_scheduler_policy_id=str(scheduler_policy.get("policy_id") or ""),
            last_scheduler_policy_version=int(scheduler_policy.get("policy_version") or 0),
            last_scheduler_policy_source=str(scheduler_policy.get("policy_source") or "no_scheduler_tick"),
            last_scheduler_tick_at=str(scheduler_policy.get("recorded_at") or ""),
            nodes=[
                {
                    **node.to_dict(),
                    "graph_revision": self.current_graph_revision(),
                    "progress_measure": self._node_progress_measure(node, envelope),
                }
                for node in nodes
            ],
            modes=modes,
            predicted_call_order=self._predicted_call_order(nodes),
            capacity=envelope.scheduler_policy.capacity.to_dict(),
            blocks=self.current_blocks(),
            gates=[
                gate.to_dict()
                for node in nodes
                for gate in [self.gate_for_node(node.node_id)]
                if gate is not None
            ],
            leases=[lease.to_dict() for lease in active_leases],
            attempts=[attempt.to_dict() for attempt in self.list_attempts()],
            integration_queue=self.list_integration_queue(),
            manifests=[manifest.to_dict() for manifest in self.list_task_output_manifests()],
            human_waits=self.list_human_waits(),
            runtime_waits=self.list_runtime_waits(),
            stuck_observations=self.list_stuck_node_observations(),
            linear_projections=self._current_linear_projections(nodes),
            graph_deliveries=self.list_graph_deliveries(),
            prediction_basis={
                "graph_revision": self.current_graph_revision(),
                "policy_revision": envelope.scheduler_policy.version,
                "assumption": "unknown verifies pass",
                "generated_at": _now(),
                "pass_threshold": PASS_THRESHOLD,
                "policy_id": str(scheduler_policy.get("policy_id") or envelope.scheduler_policy.policy_id),
                "policy_version": int(scheduler_policy.get("policy_version") or envelope.scheduler_policy.version),
                "policy_source": str(scheduler_policy.get("policy_source") or policy_source),
                "last_scheduler_tick_at": str(scheduler_policy.get("recorded_at") or ""),
                "basis": "current graph revision, active leases, last scheduler policy, and VERIFY_PASSED blockers",
            },
            runtime_config=envelope.sanitized().to_dict(),
        )

    def _active_leases(self) -> list[WorkerLease]:
        with self.connect() as connection:
            rows = connection.execute("SELECT payload_json FROM worker_leases WHERE active = 1").fetchall()
        return [WorkerLease.from_dict(_json_loads(row["payload_json"])) for row in rows]

    def _predicted_call_order(self, nodes: list[GraphNode]) -> list[PredictedCall]:
        envelope = self.active_runtime_config()
        capacity = envelope.scheduler_policy.capacity
        node_by_id = {node.node_id: node for node in nodes}
        predicted_by_node: dict[str, int] = {}
        active_leases = self._active_leases()
        wave_usage: dict[int, dict[RuntimeMode, int]] = {1: {}}
        wave_global_usage: dict[int, int] = {1: len(active_leases)}
        for lease in active_leases:
            wave_usage[1][lease.mode] = wave_usage[1].get(lease.mode, 0) + 1
        order: list[PredictedCall] = []
        for node in self._topological_nodes(nodes):
            blocked_by: list[str] = []
            earliest_mode = _mode_for_state(node.state) if node.state in _DISPATCHABLE_STATES or node.state is GraphNodeState.PLANNED else None
            if node.state is GraphNodeState.NEED_HUMAN:
                reason = f" ({node.human_reason.value})" if node.human_reason is not None else ""
                blocked_by.append(f"{node.node_id}: awaiting human{reason}")
            elif node.state not in _PREDICTABLE_DISPATCH_STATES:
                blocked_by.append(f"{node.node_id}: {node.state.value} is not dispatchable")
            if node.state in _PREDICTABLE_DISPATCH_STATES:
                for blocker_id in self.blockers_for(node.node_id):
                    blocker = node_by_id.get(blocker_id)
                    if blocker is None:
                        continue
                    blocked_by.extend(self._dependency_block_reasons(blocker))
            predicted_position = None
            if not blocked_by and earliest_mode is not None:
                earliest_position = 1 + max(
                    (predicted_by_node[blocker_id] for blocker_id in self.blockers_for(node.node_id) if blocker_id in predicted_by_node),
                    default=0,
                )
                predicted_position = self._reserve_prediction_wave(
                    earliest_position,
                    earliest_mode,
                    capacity,
                    wave_usage,
                    wave_global_usage,
                )
                predicted_by_node[node.node_id] = predicted_position
            order.append(
                PredictedCall(
                    node_id=node.node_id,
                    predicted_position=predicted_position,
                    blocked_by=blocked_by,
                    earliest_mode=earliest_mode,
                )
            )
        return order

    def _topological_nodes(self, nodes: list[GraphNode]) -> list[GraphNode]:
        node_by_id = {node.node_id: node for node in nodes}
        indegree = {node.node_id: 0 for node in nodes}
        outgoing = {node.node_id: [] for node in nodes}
        for node in nodes:
            for blocker_id in self.blockers_for(node.node_id):
                if blocker_id not in node_by_id:
                    continue
                outgoing[blocker_id].append(node.node_id)
                indegree[node.node_id] += 1
        ready = sorted(node_id for node_id, count in indegree.items() if count == 0)
        ordered: list[GraphNode] = []
        while ready:
            node_id = ready.pop(0)
            ordered.append(node_by_id[node_id])
            for dependent_id in sorted(outgoing[node_id]):
                indegree[dependent_id] -= 1
                if indegree[dependent_id] == 0:
                    ready.append(dependent_id)
                    ready.sort()
        if len(ordered) != len(nodes):
            return sorted(nodes, key=lambda item: item.node_id)
        return ordered

    def _dependency_block_reasons(self, blocker: GraphNode) -> list[str]:
        if blocker.state is GraphNodeState.NEED_HUMAN:
            reason = f" ({blocker.human_reason.value})" if blocker.human_reason is not None else ""
            return [f"{blocker.node_id}: awaiting human{reason}"]
        if blocker.state is GraphNodeState.FAILED:
            return [f"{blocker.node_id}: failed"]
        if not _node_verify_passed(blocker):
            return [f"{blocker.node_id}: verify not passed"]
        if self.verified_branch_manifest_for_node(blocker.node_id) is None:
            return [f"{blocker.node_id}: verified branch output missing"]
        return []

    def _reserve_prediction_wave(
        self,
        earliest_position: int,
        mode: RuntimeMode,
        capacity: SchedulerCapacity,
        wave_usage: dict[int, dict[RuntimeMode, int]],
        wave_global_usage: dict[int, int],
    ) -> int:
        if capacity.global_limit == 0 or capacity.by_mode.get(mode) == 0:
            return earliest_position
        position = earliest_position
        while not self._prediction_wave_has_capacity(position, mode, capacity, wave_usage, wave_global_usage):
            position += 1
        wave_usage.setdefault(position, {})
        wave_usage[position][mode] = wave_usage[position].get(mode, 0) + 1
        wave_global_usage[position] = wave_global_usage.get(position, 0) + 1
        return position

    def _prediction_wave_has_capacity(
        self,
        position: int,
        mode: RuntimeMode,
        capacity: SchedulerCapacity,
        wave_usage: dict[int, dict[RuntimeMode, int]],
        wave_global_usage: dict[int, int],
    ) -> bool:
        global_limit = capacity.global_limit
        if global_limit is not None and wave_global_usage.get(position, 0) >= global_limit:
            return False
        mode_limit = capacity.by_mode.get(mode)
        if mode_limit is not None and wave_usage.get(position, {}).get(mode, 0) >= mode_limit:
            return False
        return True

    def _node_progress_measure(self, node: GraphNode, envelope: RuntimeConfigEnvelope) -> dict[str, Any]:
        return {
            "replan_depth": node.replan_depth,
            "rework_count": node.rework_count,
            "max_rework_attempts": envelope.scheduler_policy.max_rework_attempts,
            "terminal": node.state
            in {
                GraphNodeState.VERIFY_PASSED,
                GraphNodeState.FAILED,
                GraphNodeState.SUPERSEDED,
                GraphNodeState.NEED_HUMAN,
            },
            "next_action": _node_next_action(node),
        }
