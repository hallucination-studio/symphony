from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    ExecuteAttemptRequest,
    PASS_THRESHOLD,
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanAttemptRequest,
    PlanAttemptResult,
    PipelineModeView,
    PipelineView,
    IntentSpec,
    PlanProposal,
    PlanRepair,
    PlanValidator,
    PlanValidatorError,
    PredictedCall,
    RUNTIME_BACKENDS_BY_MODE,
    RuntimeConfigEnvelope,
    RuntimeMode,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptResult,
    VerifyAttemptRequest,
    WorkerLease,
)

from .runtime_backends import prepare_backend_environment



from .conductor_pipeline_helpers import (
    _json_dumps,
    _json_loads,
    _jsonable,
    _node_runtime_payload,
    _node_topology_payload,
    _now,
    _repository_head_revision,
    _sanitize_error,
)
from .conductor_pipeline_integration import _MergeConflictError, _prepare_execute_worktree
from .conductor_pipeline_logs import (
    _append_instance_log,
    _append_pipeline_log_event,
    _attempt_event_from_performer_stream_line,
    _attempt_result_from_payload,
    _attempt_snapshot_exit_error,
    _optional_event_str,
    _process_exit_error,
    _recently_observed_process_exit,
    _runtime_log_candidates,
    _runtime_wait_from_attempt_event,
    _write_json_atomic,
)
from .conductor_pipeline_projection import PipelineLinearProjector
from .conductor_pipeline_runtime import (
    _attempt_workspace_for_mode,
    _runtime_kind_for_mode,
    _runtime_profile_preflight_error,
    materialize_planner_workspace,
    prepare_mode_environment,
)
from .conductor_pipeline_scheduler import PipelineScheduler
from .conductor_pipeline_store import ConductorPipelineStore, GraphRevision

@dataclass(frozen=True)
class PipelineDispatchAccepted:
    node_id: str
    graph_id: str
    plan_attempt_id: str


class PipelineCoordinator:
    def __init__(self, *, store: ConductorPipelineStore, runtime_manager: Any):
        self.store = store
        self.runtime_manager = runtime_manager
        self.scheduler = PipelineScheduler(store)

    def drive_convergence_once(self) -> int:
        return len(self.scheduler.promote_ready_nodes())

    def heartbeat_active_leases(
        self,
        *,
        at: datetime | None = None,
        ttl_seconds: int = 300,
    ) -> int:
        now = at or datetime.now(timezone.utc)
        heartbeats = 0
        for lease in self.store.list_active_leases():
            if self.store.heartbeat_lease(lease.lease_id, lease.fencing_token, at=now, ttl_seconds=ttl_seconds):
                heartbeats += 1
        return heartbeats

    def accept_dispatch(self, event: dict[str, Any], *, instance_id: str) -> PipelineDispatchAccepted:
        issue_id = str(event.get("issue_id") or "").strip()
        issue_identifier = str(event.get("issue_identifier") or "").strip()
        dispatch_key = issue_id or issue_identifier
        if not dispatch_key:
            raise ValueError("dispatch requires issue_id or issue_identifier")
        existing = self._existing_dispatch_for_issue(issue_id=issue_id, issue_identifier=issue_identifier)
        if existing is not None:
            return existing
        issue_identifier = issue_identifier or issue_id
        title = str(event.get("issue_title") or event.get("title") or issue_identifier or issue_id)
        issue_description = str(event.get("issue_description") or event.get("description") or "")
        node_id = issue_id or issue_identifier
        graph_id = str(event.get("graph_id") or f"graph-{node_id}")
        plan_attempt_id = str(event.get("plan_attempt_id") or f"plan-{uuid4().hex}")
        node = GraphNode(
            node_id=node_id,
            title=title,
            state=GraphNodeState.REPLANNING,
            issue_id=issue_id or None,
            issue_identifier=issue_identifier or None,
        )
        proposal = PlanProposal(
            graph_id=graph_id,
            plan_attempt_id=plan_attempt_id,
            root_node_id=node_id,
            nodes=[node],
            blocks=[],
            gates=[],
            entry_node_ids=[node_id],
            exit_node_ids=[node_id],
        )
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            revision_row = connection.execute("SELECT COALESCE(MAX(revision), 0) AS revision FROM graph_revisions").fetchone()
            revision = int(revision_row["revision"]) + 1
            connection.execute(
                """
                INSERT INTO graph_revisions (revision, graph_id, plan_attempt_id, root_node_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (revision, graph_id, plan_attempt_id, node_id, _json_dumps(proposal.to_dict()), _now()),
            )
            connection.execute(
                """
                INSERT INTO graph_nodes (revision, node_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (revision, node_id, _json_dumps(_node_topology_payload(node))),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO node_runtime_state (node_id, payload_json)
                VALUES (?, ?)
                """,
                (node_id, _json_dumps(_node_runtime_payload(node))),
            )
        self.store.record_dispatch_context(
            node_id,
            {
                "issue_id": issue_id,
                "issue_identifier": issue_identifier,
                "title": title,
                "description": issue_description,
                "agent_session_id": event.get("agent_session_id") or "",
                "intent": event.get("intent") if isinstance(event.get("intent"), dict) else {},
                "pipeline_intent": event.get("pipeline_intent") if isinstance(event.get("pipeline_intent"), dict) else {},
            },
        )
        return PipelineDispatchAccepted(node_id=node_id, graph_id=graph_id, plan_attempt_id=plan_attempt_id)

    def _existing_dispatch_for_issue(self, *, issue_id: str, issue_identifier: str) -> PipelineDispatchAccepted | None:
        revision = self.store.current_graph_revision_record()
        if revision is None:
            return None
        try:
            node = self.store.get_node(revision.root_node_id)
        except KeyError:
            return None
        keys = {value for value in [node.node_id, node.issue_id, node.issue_identifier] if value}
        requested = {value for value in [issue_id, issue_identifier] if value}
        if not keys.intersection(requested):
            return None
        return PipelineDispatchAccepted(
            node_id=node.node_id,
            graph_id=revision.graph_id,
            plan_attempt_id=revision.plan_attempt_id,
        )

    async def start_due_attempts(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        started = 0
        envelope = self.store.active_runtime_config()
        policy_source = self.store.active_runtime_config_source()
        graph_revision_record = self.store.current_graph_revision_record()
        graph_revision = graph_revision_record.revision if graph_revision_record is not None else self.store.current_graph_revision()
        policy_revision = envelope.scheduler_policy.version
        self.store.record_scheduler_tick_policy(envelope, policy_source=policy_source, at=now)
        self.scheduler.promote_ready_nodes()
        active_leases = self.store._active_leases()
        active_by_mode: dict[RuntimeMode, int] = {mode: 0 for mode in RuntimeMode}
        for lease in active_leases:
            active_by_mode[lease.mode] = active_by_mode.get(lease.mode, 0) + 1
        active_global = len(active_leases)
        for mode in (RuntimeMode.PLAN, RuntimeMode.EXECUTE, RuntimeMode.VERIFY):
            remaining = envelope.scheduler_policy.remaining_for_mode(
                mode,
                active_global=active_global,
                active_by_mode=active_by_mode,
            )
            if remaining == 0:
                capacity_configured_zero = (
                    envelope.scheduler_policy.capacity.global_limit == 0
                    or envelope.scheduler_policy.capacity.by_mode.get(mode) == 0
                )
                for node_id in self.scheduler.dispatchable_nodes(mode):
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_capacity_starved "
                            f"mode={mode.value} node_id={node_id} graph_revision={graph_revision} "
                            f"policy_revision={policy_revision} action_required=increase_runtime_capacity"
                        ),
                    )
                    if capacity_configured_zero and not self._has_open_human_wait(node_id):
                        self.store.create_human_wait(
                            node_id,
                            reason=HumanEscalationReason.CAPACITY_STARVED.value,
                            details={
                                "mode": mode.value,
                                "error": f"runtime capacity exhausted for {mode.value}",
                                "graph_revision": graph_revision,
                                "policy_revision": policy_revision,
                                "action_required": "increase_runtime_capacity",
                            },
                        )
                continue
            started_for_mode = 0
            for node_id in self.scheduler.dispatchable_nodes(mode):
                if remaining is not None and started_for_mode >= remaining:
                    break
                if self.store.active_lease(node_id, mode) is not None:
                    continue
                profile = envelope.profiles.get(mode)
                preflight_error = _runtime_profile_preflight_error(mode, profile)
                if preflight_error is not None:
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_backend_ineligible "
                            f"mode={mode.value} node_id={node_id} error={preflight_error} "
                            f"graph_revision={graph_revision} "
                            f"policy_revision={policy_revision}"
                        ),
                    )
                    self.store.create_human_wait(
                        node_id,
                        reason=HumanEscalationReason.BACKEND_UNAVAILABLE.value,
                        details={
                            "mode": mode.value,
                            "error": preflight_error,
                            "action_required": "update_runtime_profile",
                        },
                    )
                    continue
                attempt_id = f"{mode.value}-{uuid4().hex}"
                lease = self.store.start_attempt(
                    mode,
                    node_id=node_id,
                    attempt_id=attempt_id,
                    now=now,
                    graph_revision=graph_revision,
                    policy_revision=policy_revision,
                    kind=profile.backend if profile is not None else None,
                )
                try:
                    paths = self._attempt_paths(Path(instance.instance_dir), attempt_id)
                    request = self._attempt_request(
                        mode,
                        node_id=node_id,
                        attempt_id=attempt_id,
                        lease=lease,
                        instance=instance,
                        attempt_dir=paths["request_path"].parent,
                        graph_revision_record=graph_revision_record,
                        graph_revision=graph_revision,
                        policy_revision=policy_revision,
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
                    self.store.record_attempt_process_pid(attempt_id, getattr(started_instance, "pid", None))
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_attempt_started "
                            f"mode={mode.value} node_id={node_id} attempt_id={attempt_id} "
                            f"lease_id={lease.lease_id} graph_revision={graph_revision} "
                            f"policy_revision={policy_revision} "
                            f"process_pid={getattr(started_instance, 'pid', None)} "
                            f"request_path={paths['request_path']} result_path={result_path}"
                        ),
                    )
                except Exception as exc:
                    error = _sanitize_error(exc)
                    if mode is RuntimeMode.EXECUTE and isinstance(exc, _MergeConflictError):
                        result = ExecuteAttemptResult(
                            attempt_id=attempt_id,
                            node_id=node_id,
                            status=AttemptState.CANCELLED,
                            graph_revision=graph_revision,
                            policy_revision=policy_revision,
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
                            graph_revision=graph_revision,
                            policy_revision=policy_revision,
                            node_id=node_id,
                            attempt_id=attempt_id,
                            mode=mode.value,
                            lease_id=lease.lease_id,
                            error_type=exc.__class__.__name__,
                            sanitized_reason=error,
                            action_required="resolver_execute",
                        )
                        continue
                    _append_instance_log(
                        instance,
                        (
                            "pipeline_attempt_start_failed "
                            f"mode={mode.value} node_id={node_id} attempt_id={attempt_id} error={error}"
                        ),
                    )
                    self._fail_started_attempt_for_backend_error(
                        mode=mode,
                        node_id=node_id,
                        attempt_id=attempt_id,
                        lease_id=lease.lease_id,
                        error=error,
                        at=now,
                    )
                    continue
                started += 1
                started_for_mode += 1
                active_global += 1
                active_by_mode[mode] = active_by_mode.get(mode, 0) + 1
        return started

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

    def observe_runtime_waits_from_logs(self, instance: Any) -> int:
        observed = 0
        seen: set[tuple[str, str]] = set()
        for log_path in _runtime_log_candidates(instance):
            try:
                lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in lines[-500:]:
                event = _attempt_event_from_performer_stream_line(line)
                if event is None:
                    continue
                wait = _runtime_wait_from_attempt_event(event)
                if wait is None:
                    continue
                attempt_id = str(wait.get("attempt_id") or "")
                wait_kind = str(wait.get("wait_kind") or "")
                if not attempt_id or not wait_kind or (attempt_id, wait_kind) in seen:
                    continue
                seen.add((attempt_id, wait_kind))
                try:
                    attempt = self.store.get_attempt(attempt_id)
                except KeyError:
                    continue
                if attempt.state is not AttemptState.RUNNING:
                    continue
                try:
                    mode = RuntimeMode(str(wait.get("mode") or attempt.mode.value))
                except ValueError:
                    continue
                if mode is not attempt.mode:
                    continue
                node_id = str(wait.get("node_id") or attempt.node_id)
                if node_id != attempt.node_id:
                    continue
                lease = self.store.active_lease(attempt.node_id, attempt.mode)
                if lease is None or lease.attempt_id != attempt.attempt_id:
                    continue
                if self.store.record_runtime_wait(
                    attempt_id=attempt.attempt_id,
                    node_id=attempt.node_id,
                    mode=attempt.mode,
                    wait_kind=wait_kind,
                    message=_optional_event_str(wait.get("message")),
                    command=_optional_event_str(wait.get("command")),
                    thread_id=_optional_event_str(wait.get("thread_id")),
                    turn_id=_optional_event_str(wait.get("turn_id")),
                    session_id=_optional_event_str(wait.get("session_id")),
                    lease_id=lease.lease_id,
                    log_path=str(log_path),
                ):
                    observed += 1
        return observed

    def fail_running_attempts_for_exited_process(
        self,
        instance: Any,
        *,
        at: datetime | None = None,
    ) -> int:
        if getattr(instance, "process_status", None) != "exited":
            return 0
        at = at or datetime.now(timezone.utc)
        if _recently_observed_process_exit(instance, at=at):
            return 0
        failed = 0
        error = _process_exit_error(instance)
        for attempt in self.store.list_attempts():
            if attempt.state is not AttemptState.RUNNING:
                continue
            lease = self.store.active_lease(attempt.node_id, attempt.mode)
            if lease is None or lease.attempt_id != attempt.attempt_id:
                continue
            result_path = Path(instance.instance_dir) / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
            if result_path.exists():
                continue
            self._fail_started_attempt_for_backend_error(
                mode=attempt.mode,
                node_id=attempt.node_id,
                attempt_id=attempt.attempt_id,
                lease_id=lease.lease_id,
                error=error,
                at=at,
            )
            _append_instance_log(
                instance,
                (
                    "pipeline_attempt_process_exited "
                    f"mode={attempt.mode.value} node_id={attempt.node_id} "
                    f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                    f"exit_code={getattr(instance, 'last_exit_code', None)} error={error}"
                ),
            )
            failed += 1
        return failed

    def fail_exited_attempt_snapshot(
        self,
        instance: Any,
        snapshot: dict[str, object],
        *,
        at: datetime | None = None,
    ) -> int:
        attempt_id = str(snapshot.get("attempt_id") or "").strip()
        if not attempt_id:
            return 0
        try:
            attempt = self.store.get_attempt(attempt_id)
        except KeyError:
            return 0
        if attempt.state is not AttemptState.RUNNING:
            return 0
        snapshot_mode = str(snapshot.get("mode") or "").strip()
        if snapshot_mode and snapshot_mode != attempt.mode.value:
            return 0
        lease = self.store.active_lease(attempt.node_id, attempt.mode)
        if lease is None or lease.attempt_id != attempt.attempt_id:
            return 0
        snapshot_lease_id = str(snapshot.get("lease_id") or "").strip()
        if snapshot_lease_id and snapshot_lease_id != lease.lease_id:
            return 0
        snapshot_result_path_value = str(snapshot.get("result_path") or "").strip()
        if snapshot_result_path_value and Path(snapshot_result_path_value).exists():
            return 0
        error = _attempt_snapshot_exit_error(snapshot, instance)
        self._fail_started_attempt_for_backend_error(
            mode=attempt.mode,
            node_id=attempt.node_id,
            attempt_id=attempt.attempt_id,
            lease_id=lease.lease_id,
            error=error,
            at=at or datetime.now(timezone.utc),
        )
        _append_instance_log(
            instance,
            (
                "pipeline_attempt_process_exited "
                f"mode={attempt.mode.value} node_id={attempt.node_id} "
                f"attempt_id={attempt.attempt_id} lease_id={lease.lease_id} "
                f"pid={snapshot.get('pid')} exit_code={snapshot.get('exit_code')} error={error}"
            ),
        )
        return 1

    def collect_result_files(self, instance: Any, *, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)
        root = Path(instance.instance_dir) / "state" / "pipeline"
        if not root.exists():
            return 0
        applied = 0
        for result_path in sorted(root.glob("*/attempt-result.json")):
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
                continue
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
                continue
            if self.store.complete_attempt_with_fencing(result, at=now):
                applied += 1
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
                    integration_id = f"integration-{result.node_id}-{result.attempt_id}"
                    _append_pipeline_log_event(
                        instance,
                        "pipeline_manifest_published",
                        graph_revision=result.graph_revision,
                        policy_revision=result.policy_revision,
                        node_id=result.node_id,
                        attempt_id=result.attempt_id,
                        mode=result.mode.value,
                        lease_id=result.lease_id,
                        result_path=str(applied_path),
                    )
                    _append_pipeline_log_event(
                        instance,
                        "pipeline_integration_queued",
                        graph_revision=result.graph_revision,
                        policy_revision=result.policy_revision,
                        node_id=result.node_id,
                        attempt_id=result.attempt_id,
                        mode=result.mode.value,
                        lease_id=result.lease_id,
                        integration_id=integration_id,
                    )
            else:
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
        return applied

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
        node = self.store.get_node(node_id)
        dispatch_context = self.store.resolved_dispatch_context_for_node(node_id)
        envelope = self.store.active_runtime_config()
        graph_revision = self.store.current_graph_revision() if graph_revision is None else graph_revision
        policy_revision = (
            envelope.scheduler_policy.version
            if policy_revision is None
            else policy_revision
        )
        if mode is RuntimeMode.PLAN:
            revision = graph_revision_record or self.store.current_graph_revision_record()
            failure_context: dict[str, Any] = {}
            if node.state is GraphNodeState.REPLANNING:
                failed_verify = self.store.latest_failed_verify_attempt_for_node(node_id)
                if failed_verify is not None:
                    failure_context = {
                        "reason": "verify_failed",
                        "failed_attempt_id": failed_verify.attempt_id,
                        "score": failed_verify.score,
                        "gate_snapshot_hash": failed_verify.gate_snapshot_hash,
                        "error": failed_verify.error,
                    }
            request = PlanAttemptRequest(
                attempt_id=attempt_id,
                graph_id=revision.graph_id if revision is not None else f"graph-{node_id}",
                root_node_id=revision.root_node_id if revision is not None else node_id,
                node_id=node_id,
                issue_id=str(dispatch_context.get("issue_id") or node.issue_id or node_id),
                issue_identifier=str(dispatch_context.get("issue_identifier") or node.issue_identifier or node.title),
                title=str(dispatch_context.get("title") or node.title),
                graph_revision=graph_revision,
                policy_revision=policy_revision,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                workspace_path=str(
                    materialize_planner_workspace(
                        attempt_dir,
                        getattr(instance, "resolved_repo_path", None),
                    )
                ),
                thread_state_workspace_path=str(getattr(instance, "resolved_repo_path", "") or ""),
                issue_description=str(dispatch_context.get("description") or ""),
                pipeline_intent=_jsonable(
                    dispatch_context.get("pipeline_intent")
                    if isinstance(dispatch_context.get("pipeline_intent"), dict)
                    else dispatch_context.get("intent")
                    if isinstance(dispatch_context.get("intent"), dict)
                    else {}
                ),
                failure_context=failure_context,
                expected_thread_id=self.store.latest_thread_id_for_node(node_id),
                kind=_runtime_kind_for_mode(envelope, mode),
            )
            return request.to_dict()
        gate = self.store.gate_for_node(node_id)
        if gate is None:
            raise ValueError(f"node {node_id} has no frozen gate snapshot")
        common = {
            "attempt_id": attempt_id,
            "node_id": node_id,
            "graph_revision": graph_revision,
            "policy_revision": policy_revision,
            "gate_snapshot": gate,
            "lease_id": lease.lease_id,
            "fencing_token": lease.fencing_token,
            "kind": _runtime_kind_for_mode(envelope, mode),
        }
        if mode is RuntimeMode.EXECUTE:
            upstream_manifests = self.store.integrated_manifests_for_blockers(node_id)
            repository_path = str(getattr(instance, "resolved_repo_path", "") or "")
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
            request = ExecuteAttemptRequest(
                **common,
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
            return request.to_dict()
        snapshot = self.store.verification_input_for_node(node_id)
        if snapshot is None:
            raise ValueError(f"node {node_id} has no verification input snapshot")
        request = VerifyAttemptRequest(
            **common,
            execute_attempt_id=snapshot.execute_attempt_id,
            verification_input=snapshot.to_dict(),
            artifact_paths={"attempt_dir": str(attempt_dir)},
            reason="execute_succeeded",
        )
        return request.to_dict()

    def _attempt_paths(self, instance_dir: Path, attempt_id: str) -> dict[str, Path]:
        root = instance_dir / "state" / "pipeline" / attempt_id
        root.mkdir(parents=True, exist_ok=True)
        return {"request_path": root / "attempt-request.json", "result_path": root / "attempt-result.json"}
