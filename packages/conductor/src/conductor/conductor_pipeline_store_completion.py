from __future__ import annotations

from .conductor_pipeline_store_common import *


class CompletionMixin:
    def complete_attempt_with_fencing(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        at: datetime,
    ) -> bool:
        if not self._result_fence_is_valid(result, at=at):
            return False
        node = self.get_node(result.node_id)
        attempt = self.get_attempt(result.attempt_id)
        if attempt.mode is not result.mode or attempt.state is not AttemptState.RUNNING:
            return False
        if result.status is not AttemptState.SUCCEEDED:
            return self._complete_failed_attempt(result, at=at)
        if isinstance(result, PlanAttemptResult):
            plan_applied = self._apply_plan_attempt_result(result, node, at=at)
            if plan_applied == "terminal":
                return True
            if not plan_applied:
                return False
        elif isinstance(result, ExecuteAttemptResult):
            if not self._apply_execute_attempt_result(result):
                return False
        elif isinstance(result, VerifyAttemptResult):
            if not self._apply_verify_attempt_result(result):
                return False
        else:
            return False
        self._finish_attempt(
            result,
            state=AttemptState.SUCCEEDED,
            at=at,
            score=getattr(result, "score", None),
            error=result.error,
        )
        self._deactivate_lease(result.lease_id)
        return True

    def _complete_failed_attempt(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        at: datetime,
    ) -> bool:
        visible_error = _visible_attempt_error(result)
        self._finish_attempt(result, state=result.status, at=at, error=visible_error)
        self._deactivate_lease(result.lease_id)
        if result.mode in {RuntimeMode.EXECUTE, RuntimeMode.VERIFY}:
            self._handle_same_stage_attempt_failure(result, error=visible_error)
        else:
            self._create_attempt_failure_human_wait(result, error=visible_error)
        return True

    def _apply_plan_attempt_result(self, result: PlanAttemptResult, node: GraphNode, *, at: datetime) -> bool | str:
        if result.proposal is None:
            return False
        intent_spec = self._intent_spec_for_plan_node(result.node_id)
        proposal = PlanRepair(intent_spec).repair(result.proposal)
        validation_errors = PlanValidator(intent_spec=intent_spec).validate(proposal)
        if self._plan_result_should_replace_node(result.node_id, node):
            return self._apply_replan_result(result, node, proposal, validation_errors, intent_spec, at=at)
        if validation_errors:
            self._fail_plan_attempt_with_human_wait(
                result,
                at=at,
                reason=_plan_validation_human_reason(validation_errors),
                error=_plan_validation_error_summary(validation_errors),
            )
            return "terminal"
        try:
            self.commit_plan(proposal, intent_spec=intent_spec)
        except ValueError as exc:
            self._fail_plan_attempt_with_human_wait(
                result,
                at=at,
                reason=HumanEscalationReason.PLAN_INVALID,
                error=_sanitize_error(exc),
            )
            return "terminal"
        return True

    def _apply_replan_result(
        self,
        result: PlanAttemptResult,
        node: GraphNode,
        proposal: PlanProposal,
        validation_errors: set[PlanValidatorError],
        intent_spec: IntentSpec,
        *,
        at: datetime,
    ) -> bool | str:
        max_replan_depth = self.active_runtime_config().scheduler_policy.max_rework_attempts
        if node.replan_depth >= max_replan_depth:
            self._fail_plan_attempt_with_human_wait(
                result,
                at=at,
                reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                error=f"replan_depth_limit_exceeded depth={node.replan_depth} limit={max_replan_depth}",
            )
            return "terminal"
        if validation_errors:
            self._fail_plan_attempt_with_human_wait(
                result,
                at=at,
                reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                error=_plan_validation_error_summary(validation_errors),
            )
            return "terminal"
        try:
            self.replace_node_with_subgraph(result.node_id, proposal, intent_spec=intent_spec)
        except ValueError as exc:
            self._fail_plan_attempt_with_human_wait(
                result,
                at=at,
                reason=HumanEscalationReason.REPLAN_LIMIT_EXCEEDED,
                error=_sanitize_error(exc),
            )
            return "terminal"
        return True

    def _apply_execute_attempt_result(self, result: ExecuteAttemptResult) -> bool:
        snapshot = VerificationInputSnapshot.from_dict(result.verification_input or {})
        if not self._verification_input_matches_execute_result(snapshot, result):
            return False
        self.publish_verification_input(snapshot)
        self.update_node_state(result.node_id, GraphNodeState.VERIFYING)
        return True

    def _apply_verify_attempt_result(self, result: VerifyAttemptResult) -> bool:
        if not result.passed or result.score < PASS_THRESHOLD:
            self.update_node_state(result.node_id, GraphNodeState.REPLANNING, verify_score=result.score)
            return True
        snapshot = self.verification_input_for_node(result.node_id)
        if not self._verify_result_matches_snapshot(result, snapshot):
            return False
        self.update_node_state(result.node_id, GraphNodeState.VERIFY_PASSED, verify_score=result.score)
        code = snapshot.to_dict()
        code["gate_snapshot_hash"] = result.gate_snapshot_hash
        manifest = TaskOutputManifest(
            node_id=result.node_id,
            verify_attempt_id=result.attempt_id,
            gate_snapshot_hash=result.gate_snapshot_hash,
            score=result.score,
            code=code,
        )
        self.publish_task_output_manifest(manifest)
        self.enqueue_integration(manifest)
        return True

    def _verify_result_matches_snapshot(
        self,
        result: VerifyAttemptResult,
        snapshot: VerificationInputSnapshot | None,
    ) -> bool:
        if snapshot is None:
            return False
        if snapshot.task_id != result.node_id:
            return False
        if snapshot.execute_attempt_id != result.execute_attempt_id:
            return False
        return snapshot.gate_snapshot_hash == result.gate_snapshot_hash

    def _plan_result_should_replace_node(self, node_id: str, node: GraphNode) -> bool:
        if node.state is not GraphNodeState.REPLANNING:
            return False
        revision = self.current_graph_revision_record()
        if revision is None:
            return False
        if revision.root_node_id == node_id and len(self.list_nodes()) == 1:
            return False
        return True

    def _intent_spec_for_plan_node(self, node_id: str) -> IntentSpec:
        context = self.resolved_dispatch_context_for_node(node_id)
        if not context:
            node = self.get_node(node_id)
            context = {
                "issue_id": node.issue_id or node.node_id,
                "issue_identifier": node.issue_identifier or "",
                "description": "",
            }
        return IntentSpec.from_dispatch_context(context)

    def _fail_plan_attempt_with_human_wait(
        self,
        result: PlanAttemptResult,
        *,
        at: datetime,
        reason: HumanEscalationReason,
        error: str,
    ) -> bool:
        self._finish_attempt(result, state=AttemptState.FAILED, at=at, error=error)
        self._deactivate_lease(result.lease_id)
        self.create_human_wait(
            result.node_id,
            reason=reason.value,
            details={
                "mode": result.mode.value,
                "attempt_id": result.attempt_id,
                "lease_id": result.lease_id,
                "error": error,
            },
        )
        return True

    def _verification_input_matches_execute_result(
        self,
        snapshot: VerificationInputSnapshot,
        result: ExecuteAttemptResult,
    ) -> bool:
        if snapshot.task_id != result.node_id:
            return False
        if snapshot.execute_attempt_id != result.attempt_id:
            return False
        if snapshot.gate_snapshot_hash != result.gate_snapshot_hash:
            return False
        branch_required = [
            snapshot.base_revision,
            snapshot.branch_name,
            snapshot.commit_sha,
            snapshot.evidence_uri,
            snapshot.repository_path,
            snapshot.workspace_path,
        ]
        if all(str(value).strip() for value in branch_required):
            return True
        required = [
            snapshot.base_revision,
            snapshot.patch_uri,
            snapshot.patch_hash,
            snapshot.expected_result_tree,
            snapshot.evidence_uri,
            snapshot.repository_path,
            snapshot.workspace_path,
        ]
        if any(not str(value).strip() for value in required):
            return False
        if not snapshot.patch_hash.startswith("sha256:"):
            return False
        return True

    def _result_fence_is_valid(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        at: datetime,
    ) -> bool:
        try:
            attempt = self.get_attempt(result.attempt_id)
        except KeyError:
            return False
        if attempt.state is not AttemptState.RUNNING:
            return False
        if attempt.node_id != result.node_id or attempt.mode is not result.mode:
            return False
        if result.graph_revision != attempt.graph_revision:
            return False
        if result.policy_revision != attempt.policy_revision:
            return False
        node = self.get_node(result.node_id)
        if node.state is GraphNodeState.SUPERSEDED:
            return False
        if result.mode is not RuntimeMode.PLAN and (node.gate_snapshot_hash or "") != result.gate_snapshot_hash:
            return False
        lease = self.active_lease(result.node_id, result.mode)
        if lease is None or lease.lease_id != result.lease_id or lease.attempt_id != result.attempt_id:
            return False
        return lease.is_active(at, fencing_token=result.fencing_token)

    def _finish_attempt(
        self,
        result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult,
        *,
        state: AttemptState,
        at: datetime,
        score: int | None = None,
        error: str | None = None,
    ) -> None:
        attempt = self.get_attempt(result.attempt_id)
        updated = AttemptRecord(
            attempt_id=attempt.attempt_id,
            node_id=attempt.node_id,
            mode=attempt.mode,
            state=state,
            graph_revision=attempt.graph_revision,
            policy_revision=attempt.policy_revision,
            lease_id=attempt.lease_id,
            fencing_token=attempt.fencing_token,
            gate_snapshot_hash=result.gate_snapshot_hash or attempt.gate_snapshot_hash,
            score=score,
            started_at=attempt.started_at,
            completed_at=_format_time(_utc(at)),
            result_uri=attempt.result_uri,
            error=error,
            process_pid=attempt.process_pid,
            thread_id=result.thread_id or attempt.thread_id,
            kind=result.kind or attempt.kind,
        )
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE attempts
                SET state = ?, payload_json = ?
                WHERE attempt_id = ?
                """,
                (state.value, _json_dumps(updated.to_dict()), updated.attempt_id),
            )
        self.resolve_runtime_waits_for_attempt(updated.attempt_id, resolution=f"attempt {state.value}")
