from __future__ import annotations

import asyncio
import json
import hashlib
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conductor.conductor_pipeline import (
    ConductorPipelineStore,
    PipelineCoordinator,
    PipelineLinearProjector,
    PipelineScheduler,
    deliver_completed_graph_with_gh,
    _linear_workflow_state_target_for_node,
    prepare_mode_environment,
)
from conductor.conductor_runtime import ConductorRuntimeManager
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from conductor.conductor_models import InstanceRecord
from conductor.conductor_models import InstanceCreateRequest
from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    IntentSpec,
    PlanAttemptResult,
    PlanProposal,
    RuntimeConfigEnvelope,
    RuntimeMode,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptResult,
    WorkerLease,
)


def _policy(
    version: int,
    *,
    max_rework_attempts: int = 3,
) -> SchedulerPolicy:
    return SchedulerPolicy(
        policy_id=f"policy-{version}",
        version=version,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.PLAN: 1, RuntimeMode.EXECUTE: None, RuntimeMode.VERIFY: 1}),
        max_rework_attempts=max_rework_attempts,
    )


def _gate(task_id: str) -> GateSpecSnapshot:
    return GateSpecSnapshot.create(
        gate_id=f"gate-{task_id}",
        task_id=task_id,
        created_by="plan-1",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=[f"{task_id} works"],
            verification_procedure=[GateStep("pytest -q", GateStepSource.ISSUE_REQUIREMENT)],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )


def _proposal() -> PlanProposal:
    gate_a = _gate("a")
    gate_b = _gate("b")
    return PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-1",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[("a", "b")],
        gates=[gate_a, gate_b],
        entry_node_ids=["a"],
        exit_node_ids=["b"],
    )


def _parent_proposal() -> PlanProposal:
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_b = _gate("b")
    return PlanProposal(
        graph_id="graph-parent",
        plan_attempt_id="plan-parent",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[],
        gates=[gate_root, gate_a, gate_b],
        entry_node_ids=["root", "a", "b"],
        exit_node_ids=["root", "a", "b"],
    )


def _parent_blocks_downstream_proposal() -> PlanProposal:
    gate_a = _gate("a")
    gate_b = _gate("b")
    gate_c = _gate("c")
    return PlanProposal(
        graph_id="graph-parent-downstream",
        plan_attempt_id="plan-parent-downstream",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED),
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_b.hash),
            GraphNode(node_id="c", title="C", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_c.hash),
        ],
        blocks=[("root", "c")],
        gates=[gate_a, gate_b, gate_c],
        entry_node_ids=["a", "b", "c"],
        exit_node_ids=["a", "b", "c"],
    )


def _parent_intent() -> IntentSpec:
    return IntentSpec(
        issue_id="issue-root",
        issue_identifier="ENG-ROOT",
        issue_description="Parent aggregate issue",
    )


def _publish_verification_input(
    store: ConductorPipelineStore,
    node_id: str = "a",
    *,
    execute_attempt_id: str = "exec-1",
) -> VerificationInputSnapshot:
    gate_hash = store.get_node(node_id).gate_snapshot_hash or ""
    snapshot = VerificationInputSnapshot(
        task_id=node_id,
        execute_attempt_id=execute_attempt_id,
        base_revision="base",
        patch_uri="artifact://patch",
        patch_hash="sha256:patch",
        expected_result_tree="tree",
        artifact_uris=[],
        declared_commands=["pytest -q"],
        evidence_uri="artifact://evidence",
        gate_snapshot_hash=gate_hash,
        repository_path="/repo",
        workspace_path="/workspace",
    )
    store.publish_verification_input(snapshot)
    return snapshot


def _publish_manifest(
    store: ConductorPipelineStore,
    node_id: str,
    *,
    verify_attempt_id: str,
    score: int = 3,
) -> TaskOutputManifest:
    manifest = TaskOutputManifest(
        node_id=node_id,
        verify_attempt_id=verify_attempt_id,
        gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
        score=score,
        code={
            "base_revision": "base",
            "patch_uri": "artifact://patch",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
        },
    )
    store.publish_task_output_manifest(manifest)
    return manifest


def _publish_branch_manifest(
    store: ConductorPipelineStore,
    node_id: str,
    *,
    verify_attempt_id: str,
    branch_name: str | None = None,
    commit_sha: str | None = None,
    score: int = 3,
) -> TaskOutputManifest:
    manifest = TaskOutputManifest(
        node_id=node_id,
        verify_attempt_id=verify_attempt_id,
        gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
        score=score,
        code={
            "base_revision": "base",
            "branch_name": branch_name or f"symphony/{node_id}",
            "commit_sha": commit_sha or f"commit-{node_id}",
        },
    )
    store.publish_task_output_manifest(manifest)
    return manifest


def _record_attempt(
    store: ConductorPipelineStore,
    attempt_id: str,
    node_id: str,
    mode: RuntimeMode,
    state: AttemptState,
    *,
    gate_snapshot_hash: str = "",
    score: int | None = None,
) -> None:
    attempt = AttemptRecord(
        attempt_id=attempt_id,
        node_id=node_id,
        mode=mode,
        state=state,
        graph_revision=store.current_graph_revision(),
        policy_revision=store.active_runtime_config().scheduler_policy.version,
        gate_snapshot_hash=gate_snapshot_hash,
        score=score,
    )
    with store.connect() as connection:
        connection.execute(
            """
            INSERT INTO attempts (attempt_id, node_id, mode, state, payload_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (attempt.attempt_id, attempt.node_id, attempt.mode.value, attempt.state.value, json.dumps(attempt.to_dict())),
        )


def _corrupt_current_node_gate(store: ConductorPipelineStore, node_id: str) -> None:
    revision = store.current_graph_revision()
    node = store.get_node(node_id)
    corrupted = GraphNode(
        node_id=node.node_id,
        title=node.title,
        state=node.state,
        issue_id=node.issue_id,
        issue_identifier=node.issue_identifier,
        parent_node_id=node.parent_node_id,
        gate_snapshot_hash=None,
        verify_score=node.verify_score,
        rework_count=node.rework_count,
        superseded_by=node.superseded_by,
        human_reason=node.human_reason,
    )
    with store.connect() as connection:
        connection.execute(
            "UPDATE graph_nodes SET payload_json = ? WHERE revision = ? AND node_id = ?",
            (json.dumps(corrupted.to_dict(), sort_keys=True), revision, node_id),
        )


class _RecordingRuntime:
    def __init__(self) -> None:
        self.starts: list[dict[str, object]] = []
        self.stops: list[object] = []

    async def start(self, instance, **kwargs):
        self.starts.append(kwargs)
        return instance.with_updates(process_status="running", pid=1234)

    async def stop(self, instance):
        self.stops.append(instance)
        return instance.with_updates(process_status="stopped", pid=None)

    def refresh(self, instance):
        return instance

    def query_logs(self, _instance, _query):
        return type(
            "LogResult",
            (),
            {
                "instance_id": "inst-1",
                "generation": 0,
                "path": None,
                "order": "desc",
                "offset_start": 0,
                "offset_end": 0,
                "warnings": [],
                "lines": [],
                "text": lambda self: "",
            },
        )()


def _create_request(repo: Path) -> InstanceCreateRequest:
    return InstanceCreateRequest(
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
    )

__all__ = [name for name in globals() if not name.startswith("__")]
