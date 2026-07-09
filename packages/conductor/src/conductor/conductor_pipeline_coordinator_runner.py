from __future__ import annotations

from .conductor_pipeline_coordinator_common import *


class RunnerMixin:
    async def start_due_attempts(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        context = self._scheduler_start_context(now)
        active_by_mode, active_global = self._active_attempt_counts()
        started = 0
        for mode in (RuntimeMode.PLAN, RuntimeMode.EXECUTE, RuntimeMode.VERIFY):
            remaining = context["envelope"].scheduler_policy.remaining_for_mode(
                mode,
                active_global=active_global,
                active_by_mode=active_by_mode,
            )
            if remaining == 0:
                self._handle_capacity_starved(instance, mode, context)
                continue
            started_for_mode = 0
            for node_id in self.scheduler.dispatchable_nodes(mode):
                if remaining is not None and started_for_mode >= remaining:
                    break
                if self.store.active_lease(node_id, mode) is not None:
                    continue
                if not await self._try_start_node_attempt(instance, mode, node_id, now, context):
                    continue
                started += 1
                started_for_mode += 1
                active_global += 1
                active_by_mode[mode] = active_by_mode.get(mode, 0) + 1
        return started

    def _scheduler_start_context(self, now: datetime) -> dict[str, Any]:
        envelope = self.store.active_runtime_config()
        graph_record = self.store.current_graph_revision_record()
        graph_revision = graph_record.revision if graph_record is not None else self.store.current_graph_revision()
        self.store.record_scheduler_tick_policy(
            envelope,
            policy_source=self.store.active_runtime_config_source(),
            at=now,
        )
        self.scheduler.promote_ready_nodes()
        return {
            "envelope": envelope,
            "graph_revision_record": graph_record,
            "graph_revision": graph_revision,
            "policy_revision": envelope.scheduler_policy.version,
        }

    def _active_attempt_counts(self) -> tuple[dict[RuntimeMode, int], int]:
        active_leases = self.store._active_leases()
        active_by_mode: dict[RuntimeMode, int] = {mode: 0 for mode in RuntimeMode}
        for lease in active_leases:
            active_by_mode[lease.mode] = active_by_mode.get(lease.mode, 0) + 1
        return active_by_mode, len(active_leases)

    def _handle_capacity_starved(self, instance: Any, mode: RuntimeMode, context: dict[str, Any]) -> None:
        policy = context["envelope"].scheduler_policy
        capacity_configured_zero = policy.capacity.global_limit == 0 or policy.capacity.by_mode.get(mode) == 0
        for node_id in self.scheduler.dispatchable_nodes(mode):
            _append_instance_log(
                instance,
                (
                    "pipeline_capacity_starved "
                    f"mode={mode.value} node_id={node_id} graph_revision={context['graph_revision']} "
                    f"policy_revision={context['policy_revision']} action_required=increase_runtime_capacity"
                ),
            )
            if capacity_configured_zero and not self._has_open_human_wait(node_id):
                self.store.create_human_wait(
                    node_id,
                    reason=HumanEscalationReason.CAPACITY_STARVED.value,
                    details={
                        "mode": mode.value,
                        "error": f"runtime capacity exhausted for {mode.value}",
                        "graph_revision": context["graph_revision"],
                        "policy_revision": context["policy_revision"],
                        "action_required": "increase_runtime_capacity",
                    },
                )

    async def _try_start_node_attempt(
        self,
        instance: Any,
        mode: RuntimeMode,
        node_id: str,
        now: datetime,
        context: dict[str, Any],
    ) -> bool:
        profile = context["envelope"].profiles.get(mode)
        preflight_error = _runtime_profile_preflight_error(mode, profile)
        if preflight_error is not None:
            self._record_backend_ineligible(instance, mode, node_id, preflight_error, context)
            return False
        attempt_id = f"{mode.value}-{uuid4().hex}"
        lease = self.store.start_attempt(
            mode,
            node_id=node_id,
            attempt_id=attempt_id,
            now=now,
            graph_revision=context["graph_revision"],
            policy_revision=context["policy_revision"],
            kind=profile.backend if profile is not None else None,
        )
        try:
            await self._start_runtime_process(instance, mode, node_id, attempt_id, lease, profile, context)
        except Exception as exc:
            self._handle_attempt_start_exception(instance, mode, node_id, attempt_id, lease, exc, now, context)
            return False
        return True

    def _record_backend_ineligible(
        self,
        instance: Any,
        mode: RuntimeMode,
        node_id: str,
        error: str,
        context: dict[str, Any],
    ) -> None:
        _append_instance_log(
            instance,
            (
                "pipeline_backend_ineligible "
                f"mode={mode.value} node_id={node_id} error={error} "
                f"graph_revision={context['graph_revision']} "
                f"policy_revision={context['policy_revision']}"
            ),
        )
        self.store.create_human_wait(
            node_id,
            reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
            details={"mode": mode.value, "error": error, "action_required": "update_runtime_profile"},
        )

    async def _start_runtime_process(
        self,
        instance: Any,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        profile: Any,
        context: dict[str, Any],
    ) -> None:
        paths = self._attempt_paths(Path(instance.instance_dir), attempt_id)
        request = self._attempt_request(
            mode,
            node_id=node_id,
            attempt_id=attempt_id,
            lease=lease,
            instance=instance,
            attempt_dir=paths["request_path"].parent,
            graph_revision_record=context["graph_revision_record"],
            graph_revision=context["graph_revision"],
            policy_revision=context["policy_revision"],
        )
        env = prepare_mode_environment(
            Path(instance.instance_dir),
            profile,
            workspace_path=_attempt_workspace_for_mode(mode, request),
            home_scope=attempt_id,
        )
        _write_json_atomic(paths["request_path"], request)
        result_path = paths["result_path"]
        if result_path.exists():
            result_path.unlink()
        started_instance = await self.runtime_manager.start(
            instance,
            env=env,
            mode=mode.value,
            attempt_id=attempt_id,
            lease_id=lease.lease_id,
            attempt_request_path=str(paths["request_path"]),
            attempt_result_path=str(result_path),
        )
        self._record_attempt_started(instance, mode, node_id, attempt_id, lease, started_instance, paths, context)

    def _record_attempt_started(
        self,
        instance: Any,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        started_instance: Any,
        paths: dict[str, Path],
        context: dict[str, Any],
    ) -> None:
        process_pid = getattr(started_instance, "pid", None)
        result_path = paths["result_path"]
        self.store.record_attempt_process_pid(attempt_id, process_pid)
        _append_instance_log(
            instance,
            (
                "pipeline_attempt_started "
                f"mode={mode.value} node_id={node_id} attempt_id={attempt_id} "
                f"lease_id={lease.lease_id} graph_revision={context['graph_revision']} "
                f"policy_revision={context['policy_revision']} process_pid={process_pid} "
                f"request_path={paths['request_path']} result_path={result_path}"
            ),
        )

    def _handle_attempt_start_exception(
        self,
        instance: Any,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        exc: Exception,
        now: datetime,
        context: dict[str, Any],
    ) -> None:
        error = _sanitize_error(exc)
        if mode is RuntimeMode.EXECUTE and isinstance(exc, _MergeConflictError):
            self._handle_merge_conflict_start_failure(instance, node_id, attempt_id, lease, exc, error, now, context)
            return
        _append_instance_log(
            instance,
            f"pipeline_attempt_start_failed mode={mode.value} node_id={node_id} attempt_id={attempt_id} error={error}",
        )
        self._fail_started_attempt_for_backend_error(
            mode=mode,
            node_id=node_id,
            attempt_id=attempt_id,
            lease_id=lease.lease_id,
            error=error,
            at=now,
        )

    def _handle_merge_conflict_start_failure(
        self,
        instance: Any,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        exc: Exception,
        error: str,
        now: datetime,
        context: dict[str, Any],
    ) -> None:
        result = ExecuteAttemptResult(
            attempt_id=attempt_id,
            node_id=node_id,
            status=AttemptState.CANCELLED,
            graph_revision=context["graph_revision"],
            policy_revision=context["policy_revision"],
            gate_snapshot_hash=self.store.get_node(node_id).gate_snapshot_hash or "",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error=error,
        )
        self.store._finish_attempt(result, state=AttemptState.CANCELLED, at=now, error=error)
        self.store._deactivate_lease(lease.lease_id)
        self.store.insert_merge_conflict_resolver(node_id, error=error)
        _append_pipeline_log_event(
            instance,
            "pipeline_merge_conflict_resolver_inserted",
            graph_revision=context["graph_revision"],
            policy_revision=context["policy_revision"],
            node_id=node_id,
            attempt_id=attempt_id,
            mode=RuntimeMode.EXECUTE.value,
            lease_id=lease.lease_id,
            error_type=exc.__class__.__name__,
            sanitized_reason=error,
            action_required="resolver_execute",
        )

    def _has_open_human_wait(self, node_id: str) -> bool:
        return any(
            str(wait.get("node_id") or "") == node_id and str(wait.get("status") or "waiting") == "waiting"
            for wait in self.store.list_human_waits()
        )

    def _fail_started_attempt_for_backend_error(
        self,
        *,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        lease_id: str,
        error: str,
        at: datetime,
    ) -> None:
        result_type: type[PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult]
        if mode is RuntimeMode.PLAN:
            result_type = PlanAttemptResult
        elif mode is RuntimeMode.EXECUTE:
            result_type = ExecuteAttemptResult
        else:
            result_type = VerifyAttemptResult
        result = result_type(
            attempt_id=attempt_id,
            node_id=node_id,
            status=AttemptState.FAILED,
            graph_revision=self.store.current_graph_revision(),
            policy_revision=self.store.active_runtime_config().scheduler_policy.version,
            gate_snapshot_hash=self.store.get_node(node_id).gate_snapshot_hash or "",
            lease_id=lease_id,
            fencing_token="",
            error=error,
            kind=_runtime_kind_for_mode(self.store.active_runtime_config(), mode),
        )
        self.store._finish_attempt(result, state=AttemptState.FAILED, at=at, error=error)
        self.store._deactivate_lease(lease_id)
        self.store.create_human_wait(
            node_id,
            reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
            details={"mode": mode.value, "attempt_id": attempt_id, "lease_id": lease_id, "error": error},
        )
