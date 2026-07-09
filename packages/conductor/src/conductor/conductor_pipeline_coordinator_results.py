from __future__ import annotations

from .conductor_pipeline_coordinator_common import *


class ResultsMixin:
    def collect_result_files(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        root = Path(instance.instance_dir) / "state" / "pipeline"
        if not root.exists():
            return 0
        applied = 0
        for result_path in sorted(root.glob("*/attempt-result.json")):
            result = self._read_attempt_result(instance, result_path)
            if result is None:
                continue
            if self.store.complete_attempt_with_fencing(result, at=now):
                self._record_result_applied(instance, result, result_path)
                applied += 1
            else:
                self._record_result_rejected(instance, result, result_path)
        return applied

    def _read_attempt_result(self, instance: Any, result_path: Path) -> Any | None:
        try:
            payload = _json_loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _append_instance_log(
                instance,
                (
                    "event=pipeline_result_file_invalid "
                    f"attempt_id={result_path.parent.name} result_path={result_path} "
                    f"error_type={exc.__class__.__name__} sanitized_reason={_sanitize_error(exc)}"
                ),
            )
            return None
        result = _attempt_result_from_payload(payload)
        if result is None:
            _append_instance_log(
                instance,
                (
                    "event=pipeline_result_file_invalid "
                    f"attempt_id={result_path.parent.name} result_path={result_path} "
                    "error_type=InvalidAttemptResult sanitized_reason=invalid_attempt_result"
                ),
            )
        return result

    def _record_result_applied(self, instance: Any, result: Any, result_path: Path) -> None:
        applied_path = result_path.with_suffix(".json.applied")
        result_path.rename(applied_path)
        _append_pipeline_log_event(
            instance,
            "pipeline_result_applied",
            graph_revision=result.graph_revision,
            policy_revision=result.policy_revision,
            node_id=result.node_id,
            attempt_id=result.attempt_id,
            mode=result.mode.value,
            lease_id=result.lease_id,
            result_path=str(applied_path),
        )
        if isinstance(result, VerifyAttemptResult) and result.passed and result.score >= PASS_THRESHOLD:
            self._record_verify_success_artifacts(instance, result, applied_path)

    def _record_verify_success_artifacts(self, instance: Any, result: VerifyAttemptResult, result_path: Path) -> None:
        integration_id = f"integration-{result.node_id}-{result.attempt_id}"
        for event, extra in [
            ("pipeline_manifest_published", {"result_path": str(result_path)}),
            ("pipeline_integration_queued", {"integration_id": integration_id}),
        ]:
            _append_pipeline_log_event(
                instance,
                event,
                graph_revision=result.graph_revision,
                policy_revision=result.policy_revision,
                node_id=result.node_id,
                attempt_id=result.attempt_id,
                mode=result.mode.value,
                lease_id=result.lease_id,
                **extra,
            )

    def _record_result_rejected(self, instance: Any, result: Any, result_path: Path) -> None:
        _append_instance_log(
            instance,
            (
                "event=pipeline_result_rejected "
                f"attempt_id={result.attempt_id} node_id={result.node_id} mode={result.mode.value} "
                f"lease_id={result.lease_id} graph_revision={result.graph_revision} "
                f"policy_revision={result.policy_revision} result_path={result_path} "
                "error_type=FenceRejected sanitized_reason=result_fencing_or_state_mismatch "
                "action_required=inspect_pipeline_state retryable=True"
            ),
        )

    def _attempt_request(
        self,
        mode: RuntimeMode,
        *,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        instance: Any,
        attempt_dir: Path,
        graph_revision_record: GraphRevision | None = None,
        graph_revision: int | None = None,
        policy_revision: int | None = None,
    ) -> dict[str, Any]:
        context = self._attempt_request_context(
            node_id,
            graph_revision_record=graph_revision_record,
            graph_revision=graph_revision,
            policy_revision=policy_revision,
        )
        if mode is RuntimeMode.PLAN:
            return self._plan_attempt_request(instance, attempt_dir, attempt_id, lease, context).to_dict()
        if mode is RuntimeMode.EXECUTE:
            return self._execute_attempt_request(instance, attempt_dir, node_id, attempt_id, lease, context).to_dict()
        return self._verify_attempt_request(attempt_dir, node_id, attempt_id, lease, context).to_dict()

    def _attempt_request_context(
        self,
        node_id: str,
        *,
        graph_revision_record: GraphRevision | None,
        graph_revision: int | None,
        policy_revision: int | None,
    ) -> dict[str, Any]:
        envelope = self.store.active_runtime_config()
        return {
            "node": self.store.get_node(node_id),
            "dispatch_context": self.store.resolved_dispatch_context_for_node(node_id),
            "envelope": envelope,
            "graph_revision_record": graph_revision_record or self.store.current_graph_revision_record(),
            "graph_revision": self.store.current_graph_revision() if graph_revision is None else graph_revision,
            "policy_revision": envelope.scheduler_policy.version if policy_revision is None else policy_revision,
        }

    def _plan_attempt_request(self, instance: Any, attempt_dir: Path, attempt_id: str, lease: WorkerLease, context: dict[str, Any]) -> PlanAttemptRequest:
        node = context["node"]
        dispatch_context = context["dispatch_context"]
        revision = context["graph_revision_record"]
        return PlanAttemptRequest(
            attempt_id=attempt_id,
            graph_id=revision.graph_id if revision is not None else f"graph-{node.node_id}",
            root_node_id=revision.root_node_id if revision is not None else node.node_id,
            node_id=node.node_id,
            issue_id=str(dispatch_context.get("issue_id") or node.issue_id or node.node_id),
            issue_identifier=str(dispatch_context.get("issue_identifier") or node.issue_identifier or node.title),
            title=str(dispatch_context.get("title") or node.title),
            graph_revision=context["graph_revision"],
            policy_revision=context["policy_revision"],
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            workspace_path=str(materialize_planner_workspace(attempt_dir, getattr(instance, "resolved_repo_path", None))),
            thread_state_workspace_path=str(getattr(instance, "resolved_repo_path", "") or ""),
            issue_description=str(dispatch_context.get("description") or ""),
            pipeline_intent=self._pipeline_intent(dispatch_context),
            failure_context=self._plan_failure_context(node.node_id, node),
            expected_thread_id=self.store.latest_thread_id_for_node(node.node_id),
            kind=_runtime_kind_for_mode(context["envelope"], RuntimeMode.PLAN),
        )

    def _pipeline_intent(self, dispatch_context: dict[str, Any]) -> Any:
        intent = dispatch_context.get("pipeline_intent")
        if not isinstance(intent, dict):
            intent = dispatch_context.get("intent") if isinstance(dispatch_context.get("intent"), dict) else {}
        return _jsonable(intent)

    def _plan_failure_context(self, node_id: str, node: GraphNode) -> dict[str, Any]:
        if node.state is not GraphNodeState.REPLANNING:
            return {}
        failed_verify = self.store.latest_failed_verify_attempt_for_node(node_id)
        if failed_verify is None:
            return {}
        return {
            "reason": "verify_failed",
            "failed_attempt_id": failed_verify.attempt_id,
            "score": failed_verify.score,
            "gate_snapshot_hash": failed_verify.gate_snapshot_hash,
            "error": failed_verify.error,
        }

    def _attempt_common(self, mode: RuntimeMode, node_id: str, attempt_id: str, lease: WorkerLease, context: dict[str, Any]) -> dict[str, Any]:
        gate = self.store.gate_for_node(node_id)
        if gate is None:
            raise ValueError(f"node {node_id} has no frozen gate snapshot")
        return {
            "attempt_id": attempt_id,
            "node_id": node_id,
            "graph_revision": context["graph_revision"],
            "policy_revision": context["policy_revision"],
            "gate_snapshot": gate,
            "lease_id": lease.lease_id,
            "fencing_token": lease.fencing_token,
            "kind": _runtime_kind_for_mode(context["envelope"], mode),
        }

    def _execute_attempt_request(
        self,
        instance: Any,
        attempt_dir: Path,
        node_id: str,
        attempt_id: str,
        lease: WorkerLease,
        context: dict[str, Any],
    ) -> ExecuteAttemptRequest:
        node = context["node"]
        dispatch_context = context["dispatch_context"]
        repository_path = str(getattr(instance, "resolved_repo_path", "") or "")
        base_revision, workspace_path, branch_name, upstream_manifests = self._execute_repository_context(
            repository_path,
            node_id,
            attempt_dir,
        )
        return ExecuteAttemptRequest(
            **self._attempt_common(RuntimeMode.EXECUTE, node_id, attempt_id, lease, context),
            task_title=str(dispatch_context.get("title") or node.title),
            issue_identifier=str(dispatch_context.get("issue_identifier") or node.issue_identifier or ""),
            issue_description=str(dispatch_context.get("description") or ""),
            base_revision=base_revision,
            repository={"resolved_repo_path": repository_path, "branch_name": branch_name},
            artifact_paths={"attempt_dir": str(attempt_dir), "workspace_path": workspace_path},
            upstream_manifests=[manifest.to_dict() for manifest in upstream_manifests],
            reason="dependencies_verified",
            expected_thread_id=self.store.latest_thread_id_for_node(node_id),
            thread_state_workspace_path=repository_path,
        )

    def _execute_repository_context(self, repository_path: str, node_id: str, attempt_dir: Path) -> tuple[str, str, str, list[Any]]:
        upstream_manifests = self.store.integrated_manifests_for_blockers(node_id)
        base_revision = _repository_head_revision(repository_path)
        workspace_path = ""
        branch_name = ""
        if repository_path and base_revision:
            prepared = _prepare_execute_worktree(
                repository_path=Path(repository_path),
                node_id=node_id,
                attempt_dir=attempt_dir,
                base_revision=base_revision,
                upstream_manifests=upstream_manifests,
            )
            workspace_path = str(prepared["workspace_path"])
            branch_name = str(prepared["branch_name"])
        return base_revision, workspace_path, branch_name, upstream_manifests

    def _verify_attempt_request(self, attempt_dir: Path, node_id: str, attempt_id: str, lease: WorkerLease, context: dict[str, Any]) -> VerifyAttemptRequest:
        snapshot = self.store.verification_input_for_node(node_id)
        if snapshot is None:
            raise ValueError(f"node {node_id} has no verification input snapshot")
        return VerifyAttemptRequest(
            **self._attempt_common(RuntimeMode.VERIFY, node_id, attempt_id, lease, context),
            execute_attempt_id=snapshot.execute_attempt_id,
            verification_input=snapshot.to_dict(),
            artifact_paths={"attempt_dir": str(attempt_dir)},
            reason="execute_succeeded",
        )

    def _attempt_paths(self, instance_dir: Path, attempt_id: str) -> dict[str, Path]:
        root = instance_dir / "state" / "pipeline" / attempt_id
        root.mkdir(parents=True, exist_ok=True)
        return {"request_path": root / "attempt-request.json", "result_path": root / "attempt-result.json"}
