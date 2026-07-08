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
    DependencySatisfactionPolicy,
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
    dependency_policy: DependencySatisfactionPolicy = DependencySatisfactionPolicy.VERIFY_PASSED,
    max_rework_attempts: int = 3,
) -> SchedulerPolicy:
    return SchedulerPolicy(
        policy_id=f"policy-{version}",
        version=version,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.PLAN: 1, RuntimeMode.EXECUTE: None, RuntimeMode.VERIFY: 1}),
        dependency_policy=dependency_policy,
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
    gate_a = _gate("a")
    gate_b = _gate("b")
    return PlanProposal(
        graph_id="graph-parent",
        plan_attempt_id="plan-parent",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED),
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.READY, parent_node_id="root", gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[],
        gates=[gate_a, gate_b],
        entry_node_ids=["a", "b"],
        exit_node_ids=["a", "b"],
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
        requires_parent_aggregate=True,
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


def test_runtime_config_accepts_only_higher_versions_and_sanitizes_profiles(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    envelope = RuntimeConfigEnvelope(
        runtime_group_id="group-1",
        version=2,
        scheduler_policy=_policy(2),
        profiles={
            RuntimeMode.PLAN: RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"model": "gpt-5.3-codex", "token": "secret", "codex_home_source": "$CODEX_HOME_SOURCE"},
            )
        },
    )

    assert store.apply_runtime_config(envelope) is True
    assert store.apply_runtime_config(envelope) is False
    assert store.active_runtime_config() == envelope

    sanitized = store.pipeline_view().to_dict()
    assert sanitized["policy_revision"] == 2
    assert "secret" not in str(sanitized)
    assert "codex_home_source" not in str(sanitized)


def test_parent_aggregate_waits_for_child_integration_terminal(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_parent_proposal(), intent_spec=_parent_intent())
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=4)
    queued_manifest = _publish_manifest(store, "a", verify_attempt_id="verify-a")
    store.enqueue_integration(queued_manifest)
    integrated_manifest = _publish_manifest(store, "b", verify_attempt_id="verify-b")
    store.enqueue_integration(integrated_manifest)
    store.complete_integration(
        f"integration-{integrated_manifest.node_id}-{integrated_manifest.verify_attempt_id}",
        status="integrated",
        integrated_revision="commit-b",
    )

    refreshed = store.refresh_aggregate_parent_state("root")

    assert refreshed.state is GraphNodeState.PLANNED
    assert refreshed.verify_score is None


def test_parent_aggregate_all_superseded_children_does_not_require_verify_score(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_parent_proposal(), intent_spec=_parent_intent())
    store.update_node_state("a", GraphNodeState.SUPERSEDED)
    store.update_node_state("b", GraphNodeState.SUPERSEDED)

    refreshed = store.refresh_aggregate_parent_state("root")

    assert refreshed.state is GraphNodeState.SUPERSEDED
    assert refreshed.verify_score is None


def test_drive_convergence_refreshes_parent_and_promotes_downstream(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_parent_blocks_downstream_proposal(), intent_spec=_parent_intent())
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    for node_id, verify_attempt_id, revision in [
        ("a", "verify-a", "commit-a"),
        ("b", "verify-b", "commit-b"),
    ]:
        store.update_node_state(node_id, GraphNodeState.VERIFY_PASSED, verify_score=3)
        manifest = _publish_manifest(store, node_id, verify_attempt_id=verify_attempt_id)
        store.enqueue_integration(manifest)
        store.complete_integration(
            f"integration-{manifest.node_id}-{manifest.verify_attempt_id}",
            status="integrated",
            integrated_revision=revision,
        )
    store.update_node_state("root", GraphNodeState.PLANNED, verify_score=None)

    changed = coordinator.drive_convergence_once()

    assert changed >= 2
    assert store.get_node("root").state is GraphNodeState.VERIFY_PASSED
    assert store.get_node("c").state is GraphNodeState.READY


def test_conductor_instance_creation_does_not_generate_or_persist_workflow(
    tmp_path: Path, monkeypatch
) -> None:
    import conductor.conductor_service_views as views

    def fail_legacy_workflow(*_args, **_kwargs):
        raise AssertionError("legacy workflow path was called")

    monkeypatch.setattr(views, "generate_workflow_content", fail_legacy_workflow, raising=False)
    monkeypatch.setattr(views, "validate_instance_workflow", fail_legacy_workflow, raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("fixture\n", encoding="utf-8")
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )

    instance = service.create_instance(_create_request(repo))

    assert not (Path(instance.instance_dir) / "WORKFLOW.md").exists()
    assert Path(instance.log_path).exists()
    assert (Path(instance.workspace_root) / "README.md").read_text(encoding="utf-8") == "fixture\n"


async def test_conductor_start_and_restart_do_not_validate_workflow(
    tmp_path: Path, monkeypatch
) -> None:
    import conductor.conductor_service_views as views

    def fail_legacy_workflow(*_args, **_kwargs):
        raise AssertionError("legacy workflow validation was called")

    monkeypatch.setattr(views, "validate_instance_workflow", fail_legacy_workflow, raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    runtime = _RecordingRuntime()
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=runtime,
    )
    instance = service.create_instance(_create_request(repo))

    started = await service.start_instance(instance.id)
    restarted = await service.restart_instance(instance.id)

    assert started.process_status == "running"
    assert restarted.process_status == "running"
    assert [call["mode"] for call in runtime.starts] == ["plan", "plan"]
    assert all(call["attempt_request_path"] for call in runtime.starts)
    assert all(call["attempt_result_path"] for call in runtime.starts)
    assert not (Path(instance.instance_dir) / "WORKFLOW.md").exists()


def test_conductor_service_no_longer_exposes_legacy_dashboard(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )
    service.create_instance(_create_request(repo))

    assert not hasattr(service, "dashboard")


def test_podium_report_uses_pipeline_state_not_legacy_dashboard_or_persistence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=_RecordingRuntime(),
    )
    service.create_instance(_create_request(repo))
    service.pipeline_store.commit_plan(_proposal())

    monkeypatch.setattr(
        service,
        "dashboard",
        lambda: (_ for _ in ()).throw(AssertionError("legacy dashboard used")),
        raising=False,
    )
    monkeypatch.setattr(
        service,
        "_performer_runtime_from_persistence",
        lambda _instance: (_ for _ in ()).throw(AssertionError("legacy persistence used")),
        raising=False,
    )

    report = service.build_podium_report(log_tail_lines=5)

    assert report["pipeline"]["graph_revision"] == 1
    assert report["metrics"]["inst-1"]["blocked"] >= 0
    serialized = json.dumps(report, sort_keys=True)
    assert "persistence_path" not in serialized
    assert '"source": "persistence"' not in serialized


def test_graph_commit_persists_revision_nodes_edges_and_gates(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)

    revision = store.commit_plan(_proposal())

    assert revision.revision == 1
    assert store.current_graph_revision() == 1
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.blockers_for("b") == ["a"]
    assert store.gate_for_node("a") is not None


def test_graph_nodes_store_topology_and_node_runtime_state_is_node_keyed(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    with store.connect() as connection:
        topology_payload = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 1 AND node_id = 'a'",
            ).fetchone()["payload_json"]
        )
        runtime_payload = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 'a'",
            ).fetchone()["payload_json"]
        )

    assert "state" not in topology_payload
    assert "verify_score" not in topology_payload
    assert "rework_count" not in topology_payload
    assert "replan_depth" not in topology_payload
    assert "human_reason" not in topology_payload
    assert runtime_payload["state"] == GraphNodeState.READY.value

    before_topology = topology_payload
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3, replan_depth=2)

    with store.connect() as connection:
        after_topology = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 1 AND node_id = 'a'",
            ).fetchone()["payload_json"]
        )
        after_runtime = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 'a'",
            ).fetchone()["payload_json"]
        )

    assert after_topology == before_topology
    assert after_runtime["state"] == GraphNodeState.VERIFY_PASSED.value
    assert after_runtime["verify_score"] == 3
    assert after_runtime["replan_depth"] == 2


def test_graph_revisions_keep_nodes_immutable_when_node_id_is_reused(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    first = _proposal()
    first_revision = store.commit_plan(first)
    second_gate = _gate("a")
    second = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="a",
                title="A revised",
                state=GraphNodeState.REWORKING,
                gate_snapshot_hash=second_gate.hash,
                rework_count=1,
            )
        ],
        blocks=[],
        gates=[second_gate],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )

    second_revision = store.commit_plan(second)

    assert first_revision.revision == 1
    assert second_revision.revision == 2
    assert store.get_node("a", revision=1).title == "A"
    assert store.get_node("a", revision=1).state is GraphNodeState.REWORKING
    assert store.get_node("a", revision=2).title == "A revised"
    assert store.get_node("a", revision=2).state is GraphNodeState.REWORKING
    assert store.get_node("a").title == "A revised"


def test_commit_plan_resets_runtime_state_when_reusing_node_id_in_new_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash)],
            blocks=[],
            gates=[gate_a],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-a",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    store.commit_plan(
        PlanProposal(
            graph_id="graph-2",
            plan_attempt_id="plan-2",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A replacement", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a.hash)],
            blocks=[],
            gates=[gate_a],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )

    assert store.get_node("a").title == "A replacement"
    assert store.get_node("a").state is GraphNodeState.PLANNED


def test_start_attempt_updates_only_current_graph_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    first = _proposal()
    store.commit_plan(first)
    second_gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="a",
                    title="A revised",
                    state=GraphNodeState.READY,
                    gate_snapshot_hash=second_gate.hash,
                )
            ],
            blocks=[],
            gates=[second_gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )

    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=datetime(2026, 7, 6, tzinfo=timezone.utc))

    assert store.get_node("a", revision=1).state is GraphNodeState.EXECUTING
    assert store.get_node("a", revision=2).state is GraphNodeState.EXECUTING


def test_execute_attempt_cannot_start_without_frozen_gate_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    _corrupt_current_node_gate(store, "a")

    try:
        store.start_attempt(
            RuntimeMode.EXECUTE,
            node_id="a",
            attempt_id="exec-no-gate",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "frozen_gate_required"
    else:
        raise AssertionError("execute attempt started without a frozen gate")

    assert store.get_node("a").state is GraphNodeState.READY
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None


def test_start_due_attempts_does_not_materialize_runtime_home_before_store_gate_passes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    _corrupt_current_node_gate(store, "a")

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("runtime must not start when store gate rejects")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    with pytest.raises(ValueError, match="frozen_gate_required"):
        asyncio.run(coordinator.start_due_attempts(Instance()))

    assert not (tmp_path / "inst-1" / "runtime-homes").exists()


def test_start_due_attempts_fail_closed_when_mode_environment_cannot_materialize(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    blocked_home_parent = tmp_path / "inst-1" / "runtime-homes" / "execute"
    blocked_home_parent.parent.mkdir(parents=True)
    blocked_home_parent.write_text("not a directory", encoding="utf-8")

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("runtime must not start when environment setup fails")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 0
    node = store.get_node("a")
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    attempt = store.list_attempts()[0]
    assert attempt.state is AttemptState.FAILED
    assert "isolated CODEX_HOME" in (attempt.error or "")
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_start_failed" in log_text
    assert "isolated CODEX_HOME" in log_text
    assert "attempt_id=" in log_text


def test_start_due_attempts_refuses_ineligible_backend_before_dispatch(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="bad-executor",
                    backend="local-verifier",
                    mode=RuntimeMode.EXECUTE,
                )
            },
        )
    )
    store.commit_plan(_proposal())

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("ineligible backend must be refused before runtime dispatch")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 0
    assert store.list_attempts() == []
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert store.get_node("a").state is GraphNodeState.AWAITING_HUMAN
    assert store.get_node("a").human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE


def test_parallel_same_issue_execute_attempts_use_distinct_codex_homes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-1",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.EXECUTE: 2}),
            ),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                )
            },
        )
    )
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    captured_homes: list[str] = []

    class Runtime:
        async def start(self, _instance, *, env, **_kwargs):
            captured_homes.append(env["CODEX_HOME"])

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 2
    assert len(captured_homes) == 2
    assert len(set(captured_homes)) == 2
    assert all("/runtime-homes/execute/" in home for home in captured_homes)


def test_start_due_attempts_uses_single_graph_revision_snapshot_for_tick(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-1",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.EXECUTE: 2}),
            ),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )

    class Runtime:
        starts = 0

        async def start(self, _instance, **_kwargs):
            self.starts += 1
            if self.starts == 1:
                store.commit_plan(
                    PlanProposal(
                        graph_id="graph-2",
                        plan_attempt_id="plan-2",
                        root_node_id="a",
                        nodes=[
                            GraphNode(node_id="a", title="A", state=GraphNodeState.EXECUTING, gate_snapshot_hash=gate_a.hash),
                            GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                        ],
                        blocks=[],
                        gates=[gate_a, gate_b],
                        entry_node_ids=["a", "b"],
                        exit_node_ids=["a", "b"],
                    )
                )
            return type("Started", (), {"pid": 1234})()

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 2
    request_revisions = [
        json.loads(path.read_text(encoding="utf-8"))["graph_revision"]
        for path in sorted((Path(Instance.instance_dir) / "state" / "pipeline").glob("*/attempt-request.json"))
    ]
    assert request_revisions == [1, 1]


def test_prepare_mode_environment_copies_injected_codex_home_source(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    (source / "history.jsonl").write_text("do not copy\n", encoding="utf-8")
    (source / "sessions").mkdir()
    (source / "sessions" / "session.jsonl").write_text("do not copy\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"model": "gpt-5.3-codex", "codex_home_source": "$CODEX_HOME_SOURCE"},
        ),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert codex_home == tmp_path / "instance" / "runtime-homes" / "plan" / "codex"
    assert env["CODEX_MODEL"] == "gpt-5.3-codex"
    assert (codex_home / "config.toml").read_text(encoding="utf-8") == "model = 'gpt-5.3-codex'\n"
    assert (codex_home / "auth.json").read_text(encoding="utf-8") == '{"token":"secret-token"}\n'
    assert not (codex_home / "history.jsonl").exists()
    assert not (codex_home / "sessions").exists()


def test_prepare_mode_environment_rejects_direct_codex_home_source_path(tmp_path: Path) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="codex_home_source must be injected through an environment variable"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": str(source)},
            ),
        )


def test_prepare_mode_environment_copies_codex_home_source_from_env_only(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
        ),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert (codex_home / "config.toml").is_file()
    assert (codex_home / "auth.json").is_file()


def test_prepare_mode_environment_sanitizes_codex_config_template(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text(
        '\n'.join(
            [
                'model_provider = "custom"',
                'model = "gpt-5.5"',
                '',
                '[model_providers.custom]',
                'name = "custom"',
                'base_url = "http://127.0.0.1:8080"',
                '',
                '[mcp_servers.node_repl.env]',
                'CODEX_HOME = "/Users/murphy/.codex"',
                'NODE_REPL_NODE_PATH = "/Applications/Codex.app/node"',
                '',
                '[desktop]',
                'followUpQueueMode = "queue"',
                '',
                '[plugins."browser@openai-bundled"]',
                'enabled = true',
                '',
                '[projects."/Users/murphy/code/github/symphony"]',
                'trust_level = "trusted"',
                '',
            ]
        ),
        encoding="utf-8",
    )
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="planner",
            backend="codex",
            mode=RuntimeMode.PLAN,
            settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
        ),
    )

    config_text = (Path(env["CODEX_HOME"]) / "config.toml").read_text(encoding="utf-8")
    assert "[model_providers.custom]" in config_text
    assert "CODEX_HOME" not in config_text
    assert "NODE_REPL" not in config_text
    assert "mcp_servers" not in config_text
    assert "plugins." not in config_text
    assert "desktop" not in config_text
    assert "projects." not in config_text


def test_prepare_mode_environment_trusts_exact_attempt_workspace(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    workspace = tmp_path / "instance" / "state" / "pipeline" / "execute-1" / "workspace"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(
            name="executor",
            backend="codex",
            mode=RuntimeMode.EXECUTE,
            settings={
                "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE",
                "model": "gpt-5.3-codex",
                "hard_turn_timeout_ms": 120000,
            },
        ),
        workspace_path=workspace,
    )

    codex_home = Path(env["CODEX_HOME"])
    config_text = (codex_home / "config.toml").read_text(encoding="utf-8")
    assert f'[projects."{workspace.resolve()}"]' in config_text
    assert 'trust_level = "trusted"' in config_text
    assert env["CODEX_HARD_TURN_TIMEOUT_MS"] == "120000"


def test_prepare_mode_environment_rejects_env_pointing_at_default_codex_home(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / ".codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(source))

    with pytest.raises(ValueError, match="fixed copied seed"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
            ),
        )


def test_prepare_mode_environment_rejects_env_symlink_to_default_codex_home(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / ".codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    symlink = tmp_path / "codex-seed"
    symlink.symlink_to(source, target_is_directory=True)
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SOURCE", str(symlink))

    with pytest.raises(ValueError, match="fixed copied seed"):
        prepare_mode_environment(
            tmp_path / "instance",
            RuntimeProfile(
                name="planner",
                backend="codex",
                mode=RuntimeMode.PLAN,
                settings={"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"},
            ),
        )


def test_prepare_mode_environment_does_not_fallback_to_global_codex_home(tmp_path: Path, monkeypatch) -> None:
    global_home = tmp_path / "global-codex"
    global_home.mkdir()
    (global_home / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(global_home))
    monkeypatch.setenv("HOME", str(tmp_path))

    env = prepare_mode_environment(
        tmp_path / "instance",
        RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN, settings={}),
    )

    codex_home = Path(env["CODEX_HOME"])
    assert codex_home == tmp_path / "instance" / "runtime-homes" / "plan" / "codex"
    assert not (codex_home / "auth.json").exists()


def test_verify_attempt_cannot_start_without_frozen_gate_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFYING)
    _publish_verification_input(store, "a")
    _corrupt_current_node_gate(store, "a")

    try:
        store.start_attempt(
            RuntimeMode.VERIFY,
            node_id="a",
            attempt_id="verify-no-gate",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "frozen_gate_required"
    else:
        raise AssertionError("verify attempt started without a frozen gate")

    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.VERIFY) is None


def test_verify_attempt_cannot_start_without_execute_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFYING)

    try:
        store.start_attempt(
            RuntimeMode.VERIFY,
            node_id="a",
            attempt_id="verify-no-snapshot",
            now=datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert str(exc) == "verification_input_required"
    else:
        raise AssertionError("verify attempt started without an execute snapshot")

    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.VERIFY) is None


def test_pipeline_store_migrates_legacy_node_primary_key(tmp_path: Path) -> None:
    db_path = tmp_path / "pipeline.db"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE graph_nodes (
              node_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO graph_nodes (node_id, revision, payload_json) VALUES (?, ?, ?)",
            ("legacy", 1, json.dumps(GraphNode("legacy", "Legacy", GraphNodeState.READY).to_dict())),
        )

    store = ConductorPipelineStore(tmp_path)

    with store.connect() as connection:
        pk_columns = [
            str(row[1])
            for row in connection.execute("PRAGMA table_info(graph_nodes)").fetchall()
            if int(row[5] or 0) > 0
        ]
    assert pk_columns == ["revision", "node_id"]
    assert store.get_node("legacy", revision=1).title == "Legacy"


def test_dependency_policy_requires_verify_passed_score_by_default(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]

    store.update_node_state("a", GraphNodeState.FAILED)
    assert scheduler.is_dependency_satisfied("a") is False

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=2)
    assert scheduler.is_dependency_satisfied("a") is False

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            score=3,
            code={"base_revision": "base", "patch_uri": "artifact://patch"},
        )
    )
    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    queued = store.enqueue_integration(store.list_task_output_manifests()[0])
    store.complete_integration(queued["integration_id"], status="integrated", integrated_revision="commit-a")
    assert scheduler.is_dependency_satisfied("a") is True
    assert scheduler.promote_ready_nodes() == ["b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_dependency_policy_terminal_success_variant_does_not_require_integration_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1, dependency_policy=DependencySatisfactionPolicy.TERMINAL_SUCCESS),
        )
    )
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    store.update_node_state("a", GraphNodeState.FAILED)
    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=0)
    assert scheduler.is_dependency_satisfied("a") is True
    assert scheduler.promote_ready_nodes() == ["b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_planned_nodes_do_not_execute_until_promoted_to_ready(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)

    assert store.get_node("b").state is GraphNodeState.PLANNED
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            score=3,
            code={"base_revision": "base", "patch_uri": "artifact://patch"},
        )
    )
    queued = store.enqueue_integration(store.list_task_output_manifests()[0])
    store.complete_integration(queued["integration_id"], status="integrated", integrated_revision="commit-a")

    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []
    assert scheduler.promote_ready_nodes() == ["b"]
    assert store.get_node("b").state is GraphNodeState.READY
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_verifier_dispatch_requires_execute_snapshot_and_skips_active_verify_lease(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    scheduler = PipelineScheduler(store)
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    store.update_node_state("a", GraphNodeState.VERIFYING)

    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == []

    execute_lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    accepted = ExecuteAttemptResult(
        attempt_id="exec-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=execute_lease.lease_id,
        fencing_token=execute_lease.fencing_token,
        verification_input={
            "task_id": "a",
            "execute_attempt_id": "exec-1",
            "base_revision": "base",
            "patch_uri": "artifact://patch",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
            "artifact_uris": [],
            "declared_commands": ["pytest -q"],
            "evidence_uri": "artifact://evidence",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash or "",
            "repository_path": "/repo",
            "workspace_path": "/workspace",
        },
    )
    assert store.complete_attempt_with_fencing(accepted, at=now)
    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == ["a"]

    store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert scheduler.dispatchable_nodes(RuntimeMode.VERIFY) == []


def test_execute_completion_requires_matching_complete_verification_input_snapshot(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "other-exec",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now,
    )
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.verification_input_for_node("a") is None

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "",
                "patch_uri": "",
                "patch_hash": "",
                "expected_result_tree": "",
                "artifact_uris": [],
                "declared_commands": [],
                "evidence_uri": "",
                "gate_snapshot_hash": gate_hash,
            },
        ),
        at=now,
    )
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.verification_input_for_node("a") is None


def test_leases_expire_and_fence_stale_attempt_results(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    lease = store.acquire_lease(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.active_lease("a", RuntimeMode.EXECUTE) == lease
    assert store.validate_fencing_token("a", RuntimeMode.EXECUTE, lease.fencing_token, at=now + timedelta(seconds=4))
    assert not store.validate_fencing_token("a", RuntimeMode.EXECUTE, lease.fencing_token, at=now + timedelta(seconds=6))

    store.reclaim_expired_leases(now + timedelta(seconds=6))
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None


def test_lowered_policy_limit_stops_new_dispatch_without_preempting_active_lease(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-1",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.EXECUTE: 2}),
            ),
        )
    )
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    active = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now)
    assert store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            2,
            SchedulerPolicy(
                policy_id="policy-2",
                version=2,
                effective_at="2026-07-06T00:00:01Z",
                capacity=SchedulerCapacity(global_limit=3, by_mode={RuntimeMode.EXECUTE: 1}),
            ),
        )
    )

    class Runtime:
        async def start(self, *_args, **_kwargs):
            raise AssertionError("new execute dispatch must be stopped while lowered limit is saturated")

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    assert asyncio.run(coordinator.start_due_attempts(Instance(), now=now + timedelta(seconds=1))) == 0
    assert store.active_lease("a", RuntimeMode.EXECUTE) == active
    assert store.active_lease("b", RuntimeMode.EXECUTE) is None
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.get_node("b").state is GraphNodeState.READY


def test_result_fence_accepts_inflight_attempt_after_policy_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=600)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 2, _policy(2)))

    result_path = tmp_path / "inst-1" / "state" / "pipeline" / "exec-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id="exec-1",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=gate_hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                verification_input={
                    "task_id": "a",
                    "execute_attempt_id": "exec-1",
                    "base_revision": "base",
                    "patch_uri": "artifact://patch",
                    "patch_hash": "sha256:patch",
                    "expected_result_tree": "tree",
                    "artifact_uris": [],
                    "declared_commands": ["pytest -q"],
                    "evidence_uri": "artifact://evidence",
                    "gate_snapshot_hash": gate_hash,
                    "repository_path": "/repo",
                    "workspace_path": "/workspace",
                },
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    assert coordinator.collect_result_files(Instance(), now=now + timedelta(seconds=60)) == 1
    assert store.get_attempt("exec-1").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert result_path.with_suffix(".json.applied").exists()


def test_result_fence_rejects_policy_revision_mismatched_to_attempt(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=600)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 2, _policy(2)))

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=2,
            gate_snapshot_hash=gate_hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is not None


def test_result_fence_accepts_inflight_attempt_after_unrelated_graph_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a", "t"],
            exit_node_ids=["a", "b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now, ttl_seconds=600)
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-rewrite",
            root_node_id="root",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.READY, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("a").state is GraphNodeState.EXECUTING
    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-a",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_a.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-a",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_a.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-a").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING


def test_result_fence_rejects_result_with_graph_revision_mismatching_attempt_record(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash)],
            blocks=[],
            gates=[gate_a],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now, ttl_seconds=600)

    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-a",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=2,
            policy_revision=1,
            gate_snapshot_hash=gate_a.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-a",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_a.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-a").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.EXECUTING


def test_result_fence_rejects_superseded_node_attempt_after_graph_revision_changes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_t = _gate("t")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="t",
            nodes=[GraphNode(node_id="t", title="T", state=GraphNodeState.READY, gate_snapshot_hash=gate_t.hash)],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="t", attempt_id="exec-t", now=now, ttl_seconds=600)
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-rewrite",
            root_node_id="t1",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.READY, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )

    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert not store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            verification_input={
                "task_id": "t",
                "execute_attempt_id": "exec-t",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_t.hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now + timedelta(seconds=60),
    )
    assert store.get_attempt("exec-t").state is AttemptState.RUNNING


def test_reclaiming_expired_execute_lease_times_out_attempt_and_allows_retry(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.reclaim_expired_leases(now + timedelta(seconds=6)) == 1

    attempt = store.get_attempt("exec-1")
    node = store.get_node("a")
    waits = store.list_human_waits()
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert attempt.state is AttemptState.TIMED_OUT
    assert attempt.completed_at == "2026-07-06T00:00:06Z"
    assert attempt.error == "worker lease expired before attempt result was published"
    assert node.state is GraphNodeState.READY
    assert node.human_reason is None
    assert waits == []
    assert PipelineScheduler(store).dispatchable_nodes(RuntimeMode.EXECUTE) == ["a"]


def test_reclaiming_expired_lease_is_idempotent_without_double_count_or_leak(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    first = store.reclaim_expired_leases(now + timedelta(seconds=6))
    second = store.reclaim_expired_leases(now + timedelta(seconds=7))

    assert first == 1
    assert second == 0
    assert store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert store.list_human_waits() == []
    assert store.get_attempt("exec-1").state is AttemptState.TIMED_OUT


def test_lease_heartbeat_extends_active_lease_and_rejects_stale_token(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.acquire_lease(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)

    assert store.heartbeat_lease(lease.lease_id, lease.fencing_token, at=now + timedelta(seconds=4), ttl_seconds=10)
    refreshed = store.active_lease("a", RuntimeMode.EXECUTE)
    assert refreshed is not None
    assert refreshed.heartbeat_at == "2026-07-06T00:00:04Z"
    assert refreshed.expires_at == "2026-07-06T00:00:14Z"
    assert not store.heartbeat_lease(lease.lease_id, "stale", at=now + timedelta(seconds=5), ttl_seconds=10)


def test_pipeline_coordinator_heartbeats_running_attempt_leases(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=5)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    assert coordinator.heartbeat_active_leases(at=now + timedelta(seconds=4), ttl_seconds=10) == 1
    assert store.reclaim_expired_leases(now + timedelta(seconds=6)) == 0

    refreshed = store.active_lease("a", RuntimeMode.EXECUTE)
    assert refreshed is not None
    assert refreshed.heartbeat_at == "2026-07-06T00:00:04Z"
    assert refreshed.expires_at == "2026-07-06T00:00:14Z"
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING


def test_verify_pass_enqueues_integration_and_completion_publishes_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    execute_lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    assert store.complete_attempt_with_fencing(
        ExecuteAttemptResult(
            attempt_id="exec-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=execute_lease.lease_id,
            fencing_token=execute_lease.fencing_token,
            verification_input={
                "task_id": "a",
                "execute_attempt_id": "exec-1",
                "base_revision": "base",
                "patch_uri": "artifact://patch",
                "patch_hash": "sha256:patch",
                "expected_result_tree": "tree",
                "artifact_uris": [],
                "declared_commands": ["pytest -q"],
                "evidence_uri": "artifact://evidence",
                "gate_snapshot_hash": gate_hash,
                "repository_path": "/repo",
                "workspace_path": "/workspace",
            },
        ),
        at=now,
    )
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now,
    )

    queued = store.list_integration_queue()
    assert queued[0]["status"] == "queued"
    assert queued[0]["node_id"] == "a"
    store.complete_integration(queued[0]["integration_id"], status="integrated", integrated_revision="commit-1")
    completed = store.list_integration_queue()[0]
    manifest = store.list_task_output_manifests()[0]
    assert completed["status"] == "integrated"
    assert completed["integrated_revision"] == "commit-1"
    assert manifest.code["integrated_revision"] == "commit-1"
    assert manifest.code["base_revision"] == "base"
    assert manifest.code["patch_uri"] == "artifact://patch"
    assert manifest.code["patch_hash"] == "sha256:patch"
    assert manifest.code["expected_result_tree"] == "tree"


def test_verify_pass_requires_matching_execute_snapshot_before_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    with store.connect() as connection:
        connection.execute("DELETE FROM verification_inputs WHERE node_id = ?", ("a",))

    assert not store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now,
    )
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_verify_pass_requires_matching_execute_attempt_id_before_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-current")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    assert not store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-1",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-stale",
        ),
        at=now,
    )
    assert store.get_attempt("verify-1").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_verification_input_for_node_returns_latest_inserted_snapshot_not_uuid_order(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    _publish_verification_input(store, "a", execute_attempt_id="execute-z-old")
    _publish_verification_input(store, "a", execute_attempt_id="execute-a-new")

    snapshot = store.verification_input_for_node("a")

    assert snapshot is not None
    assert snapshot.execute_attempt_id == "execute-a-new"


def test_expired_verify_lease_refuses_passed_verdict_and_publishes_no_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-expired", now=now, ttl_seconds=1)

    accepted = store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-expired",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-1",
        ),
        at=now + timedelta(seconds=2),
    )

    assert accepted is False
    assert store.get_attempt("verify-expired").state is AttemptState.RUNNING
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_failed_plan_attempt_result_creates_structured_human_wait(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="issue-1", attempt_id="plan-1", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-1",
            node_id="issue-1",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=None,
            error="unexpected status 401 Unauthorized",
        ),
        at=now,
    )

    node = store.get_node("issue-1")
    waits = store.list_human_waits()
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["lease_id"] == lease.lease_id
    assert waits[0]["details"]["error"] == "unexpected status 401 Unauthorized"


def test_invalid_initial_plan_result_escalates_plan_invalid_without_failed_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-invalid", now=now, ttl_seconds=30)
    gate = _gate("a")
    invalid = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-invalid",
        root_node_id=accepted.node_id,
        nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate.hash)],
        blocks=[("missing", "a")],
        gates=[gate],
        entry_node_ids=["a"],
        exit_node_ids=["a"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=invalid,
        ),
        at=now,
    )

    node = store.get_node(accepted.node_id)
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.PLAN_INVALID
    assert waits[-1]["reason"] == HumanEscalationReason.PLAN_INVALID.value
    assert store.get_attempt("plan-invalid").state is AttemptState.FAILED


def test_failed_invalid_initial_plan_result_escalates_plan_invalid_without_backend_collapse(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-invalid", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:missing_gate",
        ),
        at=now,
    )

    node = store.get_node(accepted.node_id)
    waits = store.list_human_waits()
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.PLAN_INVALID
    assert waits[-1]["reason"] == HumanEscalationReason.PLAN_INVALID.value
    assert waits[-1]["details"]["error"] == "invalid_plan_proposal:missing_gate"
    assert store.get_attempt("plan-invalid").state is AttemptState.FAILED


def test_invalid_plan_gate_and_credentials_map_to_specific_human_reasons(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "title": "Plan feature"}, instance_id="inst-1")
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    prose_gate = GateSpecSnapshot.create(
        gate_id="gate-a",
        task_id="a",
        created_by="plan-gate",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["a works"],
            verification_procedure=["verify the feature manually"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
        ),
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-gate", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-gate",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=PlanProposal(
                graph_id=accepted.graph_id,
                plan_attempt_id="plan-gate",
                root_node_id=accepted.node_id,
                nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.PLANNED, gate_snapshot_hash=prose_gate.hash)],
                blocks=[],
                gates=[prose_gate],
                entry_node_ids=["a"],
                exit_node_ids=["a"],
            ),
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.GATE_UNEXECUTABLE

    store.update_node_state(accepted.node_id, GraphNodeState.REPLANNING, human_reason=None)
    credential_gate = GateSpecSnapshot.create(
        gate_id="gate-b",
        task_id="b",
        created_by="plan-credential",
        created_at="2026-07-06T00:00:00Z",
        content=GateSpecContent(
            acceptance_criteria=["b works"],
            verification_procedure=["pytest -q"],
            rubric={str(score): f"score {score}" for score in range(5)},
            pass_threshold=3,
            verifier_credentials=["LINEAR_TOKEN"],
        ),
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-credential", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-credential",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=PlanProposal(
                graph_id=accepted.graph_id,
                plan_attempt_id="plan-credential",
                root_node_id=accepted.node_id,
                nodes=[GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=credential_gate.hash)],
                blocks=[],
                gates=[credential_gate],
                entry_node_ids=["b"],
                exit_node_ids=["b"],
            ),
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.CREDENTIAL_REQUIRED


def test_failed_invalid_plan_gate_and_credentials_map_to_specific_human_reasons(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "title": "Plan feature"}, instance_id="inst-1")
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-gate", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-gate",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:gate_unexecutable",
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.GATE_UNEXECUTABLE

    store.update_node_state(accepted.node_id, GraphNodeState.REPLANNING, human_reason=None)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-credential", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-credential",
            node_id=accepted.node_id,
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:verifier_credential_unavailable",
        ),
        at=now,
    )
    assert store.get_node(accepted.node_id).human_reason is HumanEscalationReason.CREDENTIAL_REQUIRED


def test_conductor_repairs_plan_from_structured_dispatch_intent_at_commit_time(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
            "intent": {
                "required_gate_steps": [
                    {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["branch-a", "branch-b"],
                    "downstream_node_ids": ["integration"],
                },
            },
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gates = [_gate("branch-a"), _gate("branch-b"), _gate("integration")]
    proposal = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-raw",
        root_node_id=accepted.node_id,
        nodes=[
            GraphNode(node_id="branch-a", title="First branch", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[0].hash),
            GraphNode(node_id="branch-b", title="Second branch", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[1].hash),
            GraphNode(node_id="integration", title="Join work", state=GraphNodeState.PLANNED, gate_snapshot_hash=gates[2].hash),
        ],
        blocks=[("branch-a", "integration")],
        gates=gates,
        entry_node_ids=["branch-a", "branch-b"],
        exit_node_ids=["branch-b", "integration"],
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-raw", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-raw",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=proposal,
        ),
        at=now,
    )

    assert ("branch-a", "integration") in store.current_blocks()
    assert ("branch-b", "integration") in store.current_blocks()
    integration_gate = store.gate_for_node("integration")
    assert integration_gate is not None
    assert GateStep("pytest tests/test_smoke.py -q", GateStepSource.APPENDIX_HARNESS) in integration_gate.content.verification_procedure


def test_verify_failure_moves_node_to_reworking_without_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-verify-fail")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-fail", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-fail",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=2,
            passed=False,
            execute_attempt_id="exec-for-verify-fail",
        ),
        at=now,
    )

    node = store.get_node("a")
    assert node.state is GraphNodeState.REWORKING
    assert node.verify_score == 2
    assert node.rework_count == 1
    assert store.list_task_output_manifests() == []
    assert store.list_integration_queue() == []


def test_verify_failure_at_rework_limit_moves_node_to_replanning(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=2)))
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate.hash, rework_count=1)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-verify-fail-2")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-fail-2", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-fail-2",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate.hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=1,
            passed=False,
            execute_attempt_id="exec-for-verify-fail-2",
        ),
        at=now,
    )

    node = store.get_node("a")
    assert node.state is GraphNodeState.REPLANNING
    assert node.rework_count == 2


def test_replanning_attempt_request_includes_failed_verify_context(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1, max_rework_attempts=1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex"},
                ),
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex"},
                ),
                RuntimeMode.VERIFY: RuntimeProfile(
                    name="local-verifier",
                    backend="local-verifier",
                    mode=RuntimeMode.VERIFY,
                    settings={},
                ),
            },
        )
    )
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate.hash)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "a", execute_attempt_id="exec-for-replan")
    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-fail", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-fail",
            node_id="a",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate.hash,
            lease_id=verify_lease.lease_id,
            fencing_token=verify_lease.fencing_token,
            score=1,
            passed=False,
            execute_attempt_id="exec-for-replan",
            error="assertion failed",
        ),
        at=now,
    )
    captured: dict[str, object] = {}

    class Runtime:
        async def start(self, instance, **kwargs):
            captured.update(kwargs)
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    import asyncio

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    assert asyncio.run(coordinator.start_due_attempts(Instance())) == 1
    request = json.loads(Path(str(captured["attempt_request_path"])).read_text(encoding="utf-8"))

    assert request["failure_context"]["reason"] == "verify_failed"
    assert request["failure_context"]["failed_attempt_id"] == "verify-fail"
    assert request["failure_context"]["score"] == 1
    assert request["failure_context"]["error"] == "assertion failed"


def test_integration_conflict_creates_human_wait_and_pauses_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={"patch_hash": "sha256:patch"},
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(manifest)
    queued = store.enqueue_integration(manifest)

    completed = store.complete_integration(
        queued["integration_id"],
        status="conflict",
        error="patch conflict",
    )

    node = store.get_node("a")
    waits = store.list_human_waits()
    assert completed["status"] == "conflict"
    assert completed["error"] == "patch conflict"
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is not None
    assert node.human_reason.value == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["node_id"] == "a"
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["status"] == "waiting"
    assert waits[0]["details"]["integration_id"] == queued["integration_id"]
    assert waits[0]["details"]["error"] == "patch conflict"


def test_resolving_integration_conflict_wait_marks_integration_resolved_and_unpauses_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={"patch_hash": "sha256:patch"},
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(manifest)
    queued = store.enqueue_integration(manifest)
    store.complete_integration(queued["integration_id"], status="conflict", error="patch conflict")
    wait = store.list_human_waits()[0]
    scheduler = PipelineScheduler(store)

    assert scheduler.is_dependency_satisfied("a") is False
    assert scheduler.promote_ready_nodes() == []

    resumed = store.resume_human_wait(wait["wait_id"], resolution="conflict resolved")

    node = store.get_node("a")
    integration = store.list_integration_queue()[0]
    assert resumed["status"] == "resolved"
    assert node.state is GraphNodeState.VERIFY_PASSED
    assert node.human_reason is None
    assert integration["status"] == "resolved"
    assert integration["completed_at"]
    assert integration["error"] == "patch conflict"
    assert integration["human_resolution"] == "conflict resolved"
    assert scheduler.is_dependency_satisfied("a") is True
    assert scheduler.promote_ready_nodes() == ["b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["b"]


def test_process_queued_integration_applies_patch_and_records_integrated_revision(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    patch_hash = "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={
                "base_revision": base_revision,
                "patch_uri": f"file://{patch_path}",
                "patch_hash": patch_hash,
                "expected_result_tree": expected_tree,
            },
        )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    class Instance:
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    processed = store.process_queued_integrations(repo, instance=Instance())

    completed = store.list_integration_queue()[0]
    updated_manifest = store.list_task_output_manifests()[0]
    assert processed == 1
    assert completed["status"] == "integrated"
    assert completed["integrated_revision"]
    assert updated_manifest.code["integrated_revision"] == completed["integrated_revision"]
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == completed["integrated_revision"]
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_integration_completed" in log_text
    assert "node_id=a" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "mode=verify" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "integration_id=integration-a-verify-1" in log_text
    assert f"integrated_revision={completed['integrated_revision']}" in log_text


def test_process_queued_integrations_preserves_prior_integrated_patches(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "alpha.txt").write_text("alpha before\n", encoding="utf-8")
    (repo / "beta.txt").write_text("beta before\n", encoding="utf-8")
    subprocess.run(["git", "add", "alpha.txt", "beta.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    patches: list[tuple[str, str, str]] = []
    for name, content in (("alpha", "alpha after\n"), ("beta", "beta after\n")):
        target = repo / f"{name}.txt"
        original = target.read_text(encoding="utf-8")
        target.write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", target.name], cwd=repo, check=True)
        patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
        expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
        subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        target.write_text(original, encoding="utf-8")
        patch_path = tmp_path / f"{name}.diff"
        patch_path.write_text(patch, encoding="utf-8")
        patches.append((name, f"file://{patch_path}", expected_tree))

    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    gate_hash = store.get_node("a").gate_snapshot_hash or ""
    for index, (name, patch_uri, expected_tree) in enumerate(patches, start=1):
        patch_text = Path(patch_uri.removeprefix("file://")).read_text(encoding="utf-8")
        manifest = TaskOutputManifest(
            node_id="a",
            verify_attempt_id=f"verify-{name}",
            gate_snapshot_hash=gate_hash,
            score=3,
            code={
                "base_revision": base_revision,
                "patch_uri": patch_uri,
                "patch_hash": "sha256:" + hashlib.sha256(patch_text.encode("utf-8")).hexdigest(),
                "expected_result_tree": expected_tree,
            },
        )
        store.publish_task_output_manifest(manifest)
        store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()
    assert processed == 2
    assert [item["status"] for item in queue] == ["integrated", "integrated"]
    assert queue[0]["integrated_revision"] != queue[1]["integrated_revision"]
    assert (repo / "alpha.txt").read_text(encoding="utf-8") == "alpha after\n"
    assert (repo / "beta.txt").read_text(encoding="utf-8") == "beta after\n"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == queue[1]["integrated_revision"]


def test_process_queued_integrations_detects_overlapping_verified_patch_conflict(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    patches: dict[str, tuple[str, str, str]] = {}
    for node_id, content in (("a", "after from a\n"), ("b", "after from b\n")):
        (repo / "README.md").write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
        patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
        expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
        subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        patch_path = tmp_path / f"{node_id}.diff"
        patch_path.write_text(patch, encoding="utf-8")
        patches[node_id] = (
            f"file://{patch_path}",
            "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            expected_tree,
        )

    gate_a = _gate("a")
    gate_b = _gate("b")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    for node_id in ("a", "b"):
        patch_uri, patch_hash, expected_tree = patches[node_id]
        manifest = TaskOutputManifest(
            node_id=node_id,
            verify_attempt_id=f"verify-{node_id}",
            gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
            score=3,
            code={
                "base_revision": base_revision,
                "patch_uri": patch_uri,
                "patch_hash": patch_hash,
                "expected_result_tree": expected_tree,
            },
        )
        store.publish_task_output_manifest(manifest)
        store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()
    waits = store.list_human_waits()
    assert processed == 2
    assert queue[0]["node_id"] == "a"
    assert queue[0]["status"] == "integrated"
    assert queue[0]["integrated_revision"]
    assert queue[1]["node_id"] == "b"
    assert queue[1]["status"] == "conflict"
    assert queue[1]["error"]
    assert (repo / "README.md").read_text(encoding="utf-8") == "after from a\n"
    assert store.get_node("b").state is GraphNodeState.AWAITING_HUMAN
    assert store.get_node("b").human_reason is HumanEscalationReason.LINEAR_SYNC_CONFLICT
    assert waits[0]["node_id"] == "b"
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"
    assert waits[0]["details"]["integration_id"] == queue[1]["integration_id"]


def test_process_queued_integration_recovers_after_commit_before_queue_update(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "expected_result_tree": expected_tree,
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    committed_revision = store._integrate_manifest_patch(repo, "verify-1")
    assert store.list_integration_queue()[0]["status"] == "queued"

    processed = store.process_queued_integrations(repo)

    queue = store.list_integration_queue()[0]
    updated_manifest = store.list_task_output_manifests()[0]
    assert processed == 1
    assert queue["status"] == "integrated"
    assert queue["integrated_revision"] == committed_revision
    assert updated_manifest.code["integrated_revision"] == committed_revision
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"


def test_process_queued_integration_rejects_patch_hash_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:wrong",
            "expected_result_tree": expected_tree,
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    class Instance:
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    processed = store.process_queued_integrations(repo, instance=Instance())

    completed = store.list_integration_queue()[0]
    assert processed == 1
    assert completed["status"] == "conflict"
    assert completed["error"] == "patch_hash_mismatch"
    assert (repo / "README.md").read_text(encoding="utf-8") == "before\n"
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_integration_conflicted" in log_text
    assert "node_id=a" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "mode=verify" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "integration_id=integration-a-verify-1" in log_text
    assert "error_type=ValueError" in log_text
    assert "sanitized_reason=patch_hash_mismatch" in log_text
    assert "action_required=LINEAR_SYNC_CONFLICT" in log_text


def test_process_queued_integration_rolls_back_repository_on_tree_mismatch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "expected_result_tree": "not-the-result-tree",
        },
    )
    store.publish_task_output_manifest(manifest)
    store.enqueue_integration(manifest)

    processed = store.process_queued_integrations(repo)

    completed = store.list_integration_queue()[0]
    assert processed == 1
    assert completed["status"] == "conflict"
    assert completed["error"] == "integrated tree mismatch"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == base_revision
    assert subprocess.check_output(["git", "status", "--short"], cwd=repo, text=True) == ""
    assert (repo / "README.md").read_text(encoding="utf-8") == "before\n"


async def test_background_coordination_processes_queued_pipeline_integrations(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    (repo / "README.md").write_text("after\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
    expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=repo, check=True, capture_output=True, text=True)
    patch_path = tmp_path / "patch.diff"
    patch_path.write_text(patch, encoding="utf-8")
    patch_hash = "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest()
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-integrations-only",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-1",
        gate_snapshot_hash=service.pipeline_store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": base_revision,
            "patch_uri": f"file://{patch_path}",
            "patch_hash": patch_hash,
            "expected_result_tree": expected_tree,
        },
    )
    service.pipeline_store.publish_task_output_manifest(manifest)
    service.pipeline_store.enqueue_integration(manifest)

    result = await service.coordinate_background_once()

    queue = service.pipeline_store.list_integration_queue()
    assert result["pipeline_integrations_processed"] == 1
    assert queue[0]["status"] == "integrated"
    assert (repo / "README.md").read_text(encoding="utf-8") == "after\n"


async def test_background_coordination_reclaims_expired_pipeline_leases(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-expired", now=now, ttl_seconds=1)

    result = await service.coordinate_background_once()

    assert result["pipeline_leases_reclaimed"] == 1
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE) is None


async def test_background_coordination_projects_pipeline_graph_to_linear(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.relations: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())

    result = await service.coordinate_background_once()

    assert result["linear_pipeline_projections"] == 3
    assert len(tracker.children) == 2
    assert tracker.children[0]["parent_issue_id"] == "root"
    assert tracker.children[0]["delegate_id"] == "agent-1"
    assert tracker.relations == [("child-1", "child-2", "blocks")]
    assert len(service.pipeline_store.list_linear_projections()) == 2


async def test_background_coordination_projects_runtime_wait_signal_to_linear_node(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    )
    store.save_instance(instance)

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.description_blocks: dict[str, str] = {}

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.description_blocks[issue_id] = block
            return {"success": True}

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "title": title,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-wait",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    log_path = instance_dir / "logs" / "performer-000001.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    (instance_dir / "logs" / "current.log").write_text(str(log_path), encoding="utf-8")
    codex_event = {
        "event": "performer_attempt_event",
        "mode": "execute",
        "attempt_id": "exec-wait",
        "node_id": "a",
        "codex_event": "sdk_approval_requested",
        "message": "waiting for command approval token=secret-token",
        "command": "pytest -q token=secret-token",
    }
    log_path.write_text(
        "event=performer_stream stream=stdout mode=execute attempt_request_path=req "
        f"attempt_result_path=res message={json.dumps(codex_event, sort_keys=True)}\n",
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    assert result["pipeline_runtime_waits_observed"] == 1
    assert result["pipeline_human_actions_created"] == 1
    runtime_waits = service.pipeline_store.list_runtime_waits()
    assert runtime_waits[0]["wait_kind"] == "approval_requested"
    assert runtime_waits[0]["attempt_id"] == "exec-wait"
    assert runtime_waits[0]["child_issue_id"]
    assert "secret-token" not in json.dumps(runtime_waits)
    human_actions = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert len(human_actions) == 1
    assert human_actions[0]["title"].startswith("[Human Action] Runtime wait")
    action_description = str(human_actions[0]["description"])
    assert "symphony_runtime_wait:" in action_description
    assert "wait_kind: approval_requested" in action_description
    assert "attempt_id: exec-wait" in action_description
    assert "secret-token" not in action_description
    pipeline_nodes = [child for child in tracker.children if "performer:type/pipeline-node" in child.get("labels", [])]
    node_description = tracker.description_blocks[str(pipeline_nodes[0]["id"])]
    assert "runtime_wait:" in node_description
    assert "operator_status: waiting_for_runtime_input" in node_description
    assert "approval_requested" in node_description
    assert "exec-wait" in node_description
    assert "secret-token" not in node_description
    assert service.pipeline_store.pipeline_view().to_dict()["runtime_waits"][0]["node_id"] == "a"

    human_actions[0]["state_type"] = "completed"
    completion = await service.coordinate_background_once()

    assert completion["pipeline_human_actions_completed"] == 1
    assert service.pipeline_store.list_runtime_waits()[0]["status"] == "resolved"


async def test_background_coordination_projects_tool_input_wait_as_operator_visible_state(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    )
    store.save_instance(instance)

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.description_blocks: dict[str, str] = {}

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.description_blocks[issue_id] = block
            return {"success": True}

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "title": title,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    service.pipeline_store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-tool-input",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    log_path = instance_dir / "logs" / "performer-000001.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    (instance_dir / "logs" / "current.log").write_text(str(log_path), encoding="utf-8")
    codex_event = {
        "event": "performer_attempt_event",
        "mode": "execute",
        "attempt_id": "exec-tool-input",
        "node_id": "a",
        "codex_event": "tool_input_requested",
        "message": "waiting for tool input from sandbox",
    }
    log_path.write_text(
        "event=performer_stream stream=stdout mode=execute attempt_request_path=req "
        f"attempt_result_path=res message={json.dumps(codex_event, sort_keys=True)}\n",
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    assert result["pipeline_runtime_waits_observed"] == 1
    assert result["pipeline_human_actions_created"] == 1
    wait = service.pipeline_store.list_runtime_waits()[0]
    assert wait["wait_kind"] == "tool_input_requested"
    assert wait["attempt_id"] == "exec-tool-input"
    assert wait["child_issue_id"]
    human_actions = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert len(human_actions) == 1
    assert "symphony_runtime_wait:" in str(human_actions[0]["description"])
    assert "wait_kind: tool_input_requested" in str(human_actions[0]["description"])
    pipeline_nodes = [child for child in tracker.children if "performer:type/pipeline-node" in child.get("labels", [])]
    node_description = tracker.description_blocks[str(pipeline_nodes[0]["id"])]
    assert "operator_status: waiting_for_runtime_input" in node_description
    assert "operator_wait_kind:" in node_description
    assert "tool_input_requested" in node_description


async def test_background_coordination_surfaces_linear_projection_failures(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    )
    store.save_instance(instance)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda _instance: (_ for _ in ()).throw(
        RuntimeError("Authorization: Bearer linear-secret failed")
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())

    result = await service.coordinate_background_once()

    projection_findings = [
        finding
        for finding in result["reconcile_findings"]
        if finding["event"] == "linear_pipeline_projection_failed"
    ]
    assert projection_findings
    assert projection_findings[0]["instance_id"] == "inst-1"
    assert projection_findings[0]["error_type"] == "RuntimeError"
    assert "Authorization: [REDACTED]" in projection_findings[0]["sanitized_reason"]
    assert "linear-secret" not in json.dumps(result["reconcile_findings"])
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert "event=linear_pipeline_projection_failed" in log_text
    assert "Authorization: [REDACTED]" in log_text
    assert "linear-secret" not in log_text


async def test_background_coordination_ingests_linear_pipeline_blocks(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )

    gate_a = _gate("a")
    gate_b = _gate("b")
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": parent_issue_id,
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": parent_issue_id,
                    "relations": [],
                },
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    result = await service.coordinate_background_once()

    assert result["linear_pipeline_ingestions"] == 1
    assert service.pipeline_store.current_graph_revision() == 2
    assert service.pipeline_store.blockers_for("b") == ["a"]


async def test_background_coordination_creates_linear_human_action_for_integration_conflict(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"human-child-{len(self.children) + 1}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    gate_hash = service.pipeline_store.get_node("a").gate_snapshot_hash or ""
    missing_patch = tmp_path / "missing.patch"
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-conflict",
        gate_snapshot_hash=gate_hash,
        score=3,
        code={
            "base_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "patch_uri": f"file://{missing_patch}",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
        },
    )
    service.pipeline_store.publish_task_output_manifest(manifest)
    service.pipeline_store.enqueue_integration(manifest)

    result = await service.coordinate_background_once()

    waits = service.pipeline_store.list_human_waits()
    human_children = [child for child in tracker.children if "performer:type/human-action" in child.get("labels", [])]
    assert result["pipeline_integrations_processed"] == 1
    assert result["pipeline_human_actions_created"] == 1
    assert len(human_children) == 1
    assert human_children[0]["title"].startswith("[Human Action]")
    assert "performer:type/human-action" in human_children[0]["labels"]
    assert waits[0]["child_issue_id"] == "human-child-1"
    assert waits[0]["reason"] == "LINEAR_SYNC_CONFLICT"
    assert "verify-conflict" in str(human_children[0]["description"])


async def test_background_coordination_resumes_completed_linear_human_action(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            SchedulerPolicy(
                policy_id="policy-no-dispatch",
                version=1,
                effective_at="2026-07-06T00:00:00Z",
                capacity=SchedulerCapacity(global_limit=0),
            ),
        )
    )
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Done",
                    "state_type": "completed",
                    "description": "conflict resolved",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    result = await service.coordinate_background_once()

    waits = service.pipeline_store.list_human_waits()
    assert result["pipeline_human_actions_completed"] == 1
    assert waits[0]["wait_id"] == wait["wait_id"]
    assert waits[0]["status"] == "resolved"
    assert waits[0]["resolution"] == "Linear human action human-child-1 completed."


async def test_background_coordination_resumes_completed_non_conflict_human_action(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="PLAN_INVALID",
        child_issue_id="human-child-1",
        details={"attempt_id": "plan-invalid"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Done",
                    "state_type": "completed",
                    "description": "plan fixed",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    node = service.pipeline_store.get_node("a")
    waits = service.pipeline_store.list_human_waits()
    assert completed == 1
    assert waits[0]["wait_id"] == wait["wait_id"]
    assert waits[0]["status"] == "resolved"
    assert node.state is GraphNodeState.REPLANNING
    assert node.human_reason is None


async def test_podium_human_answered_command_without_completed_child_does_not_resume_wait(tmp_path: Path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    result = await service.handle_podium_ws_command(
        {
            "type": "human.answered",
            "wait_id": wait["wait_id"],
            "child_issue_id": "human-child-1",
            "human_response": "resume from parent command",
        }
    )

    waits = service.pipeline_store.list_human_waits()
    assert result == {"status": "ignored", "reason": "completed_child_required", "wait_id": wait["wait_id"]}
    assert waits[0]["status"] == "waiting"
    assert service.pipeline_store.get_node("a").state is GraphNodeState.AWAITING_HUMAN


async def test_unresolved_human_action_child_emits_reconcile_finding(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(data_root / "instances" / "inst-1"),
            workspace_root=str(data_root / "instances" / "inst-1" / "workspace" / "repo"),
            persistence_path=str(data_root / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(data_root / "instances" / "inst-1" / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="LINEAR_SYNC_CONFLICT",
        child_issue_id="human-child-1",
        details={"integration_id": "integration-a-verify-1"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "human-child-1",
                    "labels": ["performer:type/human-action"],
                    "state": "Todo",
                    "state_type": "unstarted",
                    "description": "still open",
                }
            ]

    service.repository_handoff_tracker_factory = lambda instance: Tracker()
    service._pipeline_reconcile_findings = []

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    assert completed == 0
    assert service.pipeline_store.list_human_waits()[0]["status"] == "waiting"
    assert service._pipeline_reconcile_findings == [
        {
            "event": "pipeline_human_wait_unresolved",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "human action child is not completed",
            "action_required": "complete_human_action_child",
            "retryable": True,
            "instance_id": "inst-1",
            "issue_project": "ENG",
            "wait_id": wait["wait_id"],
            "node_id": "a",
            "child_issue_id": "human-child-1",
            "reason": "LINEAR_SYNC_CONFLICT",
        }
    ]


async def test_missing_human_action_child_emits_reconcile_finding(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    repo = tmp_path / "repo"
    repo.mkdir()
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(data_root / "instances" / "inst-1"),
            workspace_root=str(data_root / "instances" / "inst-1" / "workspace" / "repo"),
            persistence_path=str(data_root / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(data_root / "instances" / "inst-1" / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    service.pipeline_store.commit_plan(_proposal())
    wait = service.pipeline_store.create_human_wait(
        "a",
        reason="PLAN_INVALID",
        child_issue_id="human-child-missing",
        details={"attempt_id": "plan-invalid"},
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

    service.repository_handoff_tracker_factory = lambda instance: Tracker()
    service._pipeline_reconcile_findings = []

    completed = await service.reconcile_completed_pipeline_human_actions_once()

    assert completed == 0
    assert service.pipeline_store.list_human_waits()[0]["status"] == "waiting"
    assert service._pipeline_reconcile_findings == [
        {
            "event": "pipeline_human_wait_unresolved",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "human action child was not returned by Linear",
            "action_required": "recreate_or_complete_human_action_child",
            "retryable": True,
            "instance_id": "inst-1",
            "issue_project": "ENG",
            "wait_id": wait["wait_id"],
            "node_id": "a",
            "child_issue_id": "human-child-missing",
            "reason": "PLAN_INVALID",
        }
    ]


def test_human_wait_and_linear_projection_records_are_durable(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    wait = store.create_human_wait("a", reason="LINEAR_SYNC_CONFLICT", child_issue_id="child-1")
    projection = store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={"graph_id": "graph-1", "node_id": "a", "conductor_revision": 1},
    )

    assert store.list_human_waits()[0]["status"] == "waiting"
    assert wait["child_issue_id"] == "child-1"
    assert projection["linear_issue_id"] == "issue-a"
    assert store.resume_human_wait(wait["wait_id"], resolution="conflict resolved")["status"] == "resolved"
    assert store.list_human_waits()[0]["resolution"] == "conflict resolved"


def test_pipeline_view_filters_stale_linear_projections_and_refreshes_operator_status(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    stale = store.record_linear_projection(
        node_id="old-root",
        linear_issue_id="old-root",
        metadata={
            "graph_id": "graph-old",
            "node_id": "old-root",
            "conductor_revision": 1,
            "operator_status": "running_plan",
        },
    )
    current = store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={
            "graph_id": "graph-1",
            "node_id": "a",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash,
            "conductor_revision": 1,
            "operator_status": "verifying",
        },
    )
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)

    projections = store.pipeline_view().to_dict()["linear_projections"]

    assert [projection["projection_id"] for projection in projections] == [current["projection_id"]]
    assert stale["projection_id"] not in {projection["projection_id"] for projection in projections}
    assert projections[0]["metadata"]["operator_status"] == "verify_passed"
    assert projections[0]["metadata"]["gate_snapshot_hash"] == store.get_node("a").gate_snapshot_hash
    assert [projection["projection_id"] for projection in store.list_linear_projections()] == [current["projection_id"]]


async def test_pipeline_linear_projector_creates_node_issue_with_gate_and_metadata(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = []
            self.updated: list[tuple[str, str, str]] = []
            self.relations: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "identifier": f"ENG-{len(self.children) + 10}",
                "title": title,
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append((issue_id, marker_name, block))
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear", delegate_id="agent-1")

    projected = await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projected == 3
    assert len(tracker.children) == 2
    assert tracker.children[0]["parent_issue_id"] == "root-linear"
    assert tracker.children[0]["delegate_id"] == "agent-1"
    assert "performer:type/pipeline-node" in tracker.children[0]["labels"]
    assert tracker.updated[0][1] == "SYMPHONY PIPELINE NODE"
    block = tracker.updated[0][2]
    assert "graph_id: graph-1" in block
    assert "node_id: a" in block
    assert "plan_attempt_id: plan-1" in block
    assert f"gate_snapshot_hash: {store.get_node('a').gate_snapshot_hash}" in block
    assert "verification_procedure:" in block
    assert projection["node_id"] == "a"
    assert projection["linear_issue_id"] == "child-1"
    assert projection["metadata"]["conductor_revision"] == 1
    assert tracker.relations == [("child-1", "child-2", "blocks")]


async def test_pipeline_linear_projector_refreshes_operator_status_after_state_change(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())

    class Tracker:
        def __init__(self) -> None:
            self.children: list[dict[str, object]] = [
                {
                    "id": "child-a",
                    "description": "```yaml\nsymphony:\n  node_id: a\n```",
                    "labels": ["performer:type/pipeline-node"],
                    "parent_issue_id": "root-linear",
                }
            ]
            self.description_blocks: dict[str, str] = {}

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                child
                for child in self.children
                if child.get("parent_issue_id") == parent_issue_id
                and (label_name is None or label_name in child.get("labels", []))
            ]

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.description_blocks[issue_id] = block
            return {"success": True}

        async def create_child_issue_for(
            self,
            *,
            parent_issue_id: str,
            title: str,
            description: str,
            label_names: list[str],
            delegate_id: str | None = None,
        ) -> dict[str, object]:
            child = {
                "id": f"child-{len(self.children) + 1}",
                "description": description,
                "labels": list(label_names),
                "parent_issue_id": parent_issue_id,
                "title": title,
                "delegate_id": delegate_id,
            }
            self.children.append(child)
            return child

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")
    store.update_node_state("a", GraphNodeState.VERIFYING)
    await projector.reconcile_once()
    assert store.list_linear_projections()[0]["metadata"]["operator_status"] == "verifying"

    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projection["metadata"]["operator_status"] == "verify_passed"
    assert "operator_status: verify_passed" in tracker.description_blocks["child-a"]


async def test_pipeline_linear_projector_marks_root_issue_for_planning_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    coordinator.accept_dispatch(
        {
            "issue_id": "root-linear",
            "issue_identifier": "ENG-1",
            "title": "Delegated root",
        },
        instance_id="inst-1",
    )

    class Tracker:
        def __init__(self) -> None:
            self.created: list[dict[str, object]] = []
            self.updated: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            self.created.append(dict(kwargs))
            return {"id": "unexpected-child"}

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append((issue_id, marker_name, block))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    projected = await projector.reconcile_once()

    projection = store.list_linear_projections()[0]
    assert projected == 1
    assert tracker.created == []
    assert tracker.updated[0][0] == "root-linear"
    assert tracker.updated[0][1] == "SYMPHONY PIPELINE NODE"
    assert "graph_id: graph-root-linear" in tracker.updated[0][2]
    assert "node_id: root-linear" in tracker.updated[0][2]
    assert "gate_snapshot_hash:" in tracker.updated[0][2]
    assert projection["node_id"] == "root-linear"
    assert projection["linear_issue_id"] == "root-linear"
    assert projection["metadata"]["conductor_revision"] == 1


async def test_pipeline_linear_projector_reuses_local_projection_when_remote_marker_missing(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.record_linear_projection(
        node_id="a",
        linear_issue_id="existing-a",
        metadata={"graph_id": "graph-1", "node_id": "a", "conductor_revision": 1},
    )
    store.record_linear_projection(
        node_id="b",
        linear_issue_id="existing-b",
        metadata={"graph_id": "graph-1", "node_id": "b", "conductor_revision": 1},
    )

    class Tracker:
        def __init__(self) -> None:
            self.created = 0
            self.updated: list[str] = []
            self.relations: list[tuple[str, str, str]] = []

        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return []

        async def create_child_issue_for(self, **kwargs: object) -> dict[str, object]:
            self.created += 1
            return {"id": f"new-{self.created}"}

        async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
            self.updated.append(issue_id)
            return {"success": True}

        async def ensure_issue_relation(self, *, issue_id: str, related_issue_id: str, relation_type: str) -> dict[str, object]:
            self.relations.append((issue_id, related_issue_id, relation_type))
            return {"success": True}

    tracker = Tracker()
    projector = PipelineLinearProjector(store=store, tracker=tracker, root_issue_id="root-linear")

    projected = await projector.reconcile_once()

    assert projected == 3
    assert tracker.created == 0
    assert tracker.updated == ["existing-a", "existing-b"]
    assert tracker.relations == [("existing-a", "existing-b", "blocks")]


async def test_pipeline_linear_projector_ingests_human_added_blocks_as_new_graph_revision(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 1
    assert store.current_graph_revision() == 2
    assert store.blockers_for("b") == ["a"]
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.get_node("b").state is GraphNodeState.READY


def test_merge_human_added_blocks_is_union_only_and_idempotent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    gate_c = _gate("c")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.READY, gate_snapshot_hash=gate_c.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b, gate_c],
            entry_node_ids=["a", "c"],
            exit_node_ids=["b", "c"],
        )
    )

    revision = store.merge_human_added_blocks([("b", "c")], reason="human_linear_blocks_ingested")

    assert revision is not None
    assert revision.revision == 2
    assert store.current_blocks() == [("a", "b"), ("b", "c")]

    assert store.merge_human_added_blocks([("b", "c")], reason="human_linear_blocks_ingested") is None
    assert store.current_graph_revision() == 2
    assert store.current_blocks() == [("a", "b"), ("b", "c")]


async def test_pipeline_linear_projector_does_not_clear_local_blocks_when_remote_relations_are_absent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 1
    assert store.blockers_for("b") == ["a"]


async def test_pipeline_linear_projector_ignores_stale_blocks_from_superseded_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_a2 = _gate("a2")
    store.replace_node_with_subgraph(
        "a",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="a2",
            nodes=[GraphNode(node_id="a2", title="A2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_a2.hash)],
            blocks=[],
            gates=[gate_a2],
            entry_node_ids=["a2"],
            exit_node_ids=["a2"],
        ),
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-a",
                    "description": "node_id: a",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-b"}}],
                },
                {
                    "id": "issue-b",
                    "description": "node_id: b",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 2
    assert store.get_node("a").state is GraphNodeState.SUPERSEDED
    assert store.blockers_for("b") == ["a2"]


async def test_pipeline_linear_projector_preserves_replacement_blocks_not_yet_reflected_by_linear(
    tmp_path: Path,
) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_alpha = _gate("alpha")
    gate_target = _gate("target")
    gate_downstream = _gate("downstream")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="alpha",
            nodes=[
                GraphNode(node_id="alpha", title="Alpha", state=GraphNodeState.EXECUTING, gate_snapshot_hash=gate_alpha.hash),
                GraphNode(node_id="target", title="Target", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_target.hash),
                GraphNode(node_id="downstream", title="Downstream", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_downstream.hash),
            ],
            blocks=[("alpha", "downstream"), ("target", "downstream")],
            gates=[gate_alpha, gate_target, gate_downstream],
            entry_node_ids=["alpha", "target"],
            exit_node_ids=["downstream"],
        )
    )
    gate_replacement = _gate("target-replacement")
    store.replace_node_with_subgraph(
        "target",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="target-replacement",
            nodes=[
                GraphNode(
                    node_id="target-replacement",
                    title="Target replacement",
                    state=GraphNodeState.READY,
                    gate_snapshot_hash=gate_replacement.hash,
                )
            ],
            blocks=[],
            gates=[gate_replacement],
            entry_node_ids=["target-replacement"],
            exit_node_ids=["target-replacement"],
        ),
    )
    assert store.blockers_for("downstream") == ["alpha", "target-replacement"]

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "issue-alpha",
                    "description": "node_id: alpha",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [{"type": "blocks", "relatedIssue": {"id": "issue-downstream"}}],
                },
                {
                    "id": "issue-target",
                    "description": "node_id: target",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-target-replacement",
                    "description": "node_id: target-replacement",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
                {
                    "id": "issue-downstream",
                    "description": "node_id: downstream",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                },
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 2
    assert store.blockers_for("downstream") == ["alpha", "target-replacement"]


async def test_pipeline_linear_projector_does_not_clear_blocks_when_root_issue_endpoint_is_not_a_child(
    tmp_path: Path,
) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root-linear")
    gate_child = _gate("child-node")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root-linear",
            nodes=[
                GraphNode(
                    node_id="root-linear",
                    title="Root",
                    state=GraphNodeState.READY,
                    issue_id="root-linear",
                    gate_snapshot_hash=gate_root.hash,
                ),
                GraphNode(
                    node_id="child-node",
                    title="Child",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_child.hash,
                ),
            ],
            blocks=[("root-linear", "child-node")],
            gates=[gate_root, gate_child],
            entry_node_ids=["root-linear"],
            exit_node_ids=["child-node"],
        )
    )

    class Tracker:
        async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
            return [
                {
                    "id": "child-issue",
                    "description": "node_id: child-node",
                    "labels": ["performer:type/pipeline-node"],
                    "relations": [],
                }
            ]

    projector = PipelineLinearProjector(store=store, tracker=Tracker(), root_issue_id="root-linear")

    ingested = await projector.ingest_human_linear_changes_once()

    assert ingested == 0
    assert store.current_graph_revision() == 1
    assert store.blockers_for("child-node") == ["root-linear"]


def test_replan_replaces_node_with_subgraph_and_rewires_edges_atomically(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
                GraphNode(
                    node_id="a",
                    title="A",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_a.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                    replan_depth=2,
                ),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_root, gate_a, gate_t, gate_b],
            entry_node_ids=["a", "root"],
            exit_node_ids=["b", "root"],
        )
    )
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[("t1", "t2")],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1"],
        exit_node_ids=["t2"],
    )

    revision = store.replace_node_with_subgraph("t", subgraph)

    assert revision.revision == 2
    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t").superseded_by == ["t1", "t2"]
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.get_node("t1").state is GraphNodeState.PLANNED
    assert store.get_node("t2").state is GraphNodeState.PLANNED
    assert store.get_node("t1").replan_depth == 3
    assert store.get_node("t2").replan_depth == 3
    assert store.blockers_for("t1") == ["a"]
    assert store.blockers_for("t2") == ["t1"]
    assert store.blockers_for("b") == ["t2"]
    assert store.get_node("t", revision=1).title == "T"
    assert store.get_node("t", revision=1).state is GraphNodeState.SUPERSEDED
    with store.connect() as connection:
        t1_topology = json.loads(
            connection.execute(
                "SELECT payload_json FROM graph_nodes WHERE revision = 2 AND node_id = 't1'",
            ).fetchone()["payload_json"]
        )
        t1_runtime = json.loads(
            connection.execute(
                "SELECT payload_json FROM node_runtime_state WHERE node_id = 't1'",
            ).fetchone()["payload_json"]
        )

    assert "state" not in t1_topology
    assert "replan_depth" not in t1_topology
    assert t1_runtime["state"] == GraphNodeState.PLANNED.value
    assert t1_runtime["replan_depth"] == 3


def test_replan_does_not_let_replacement_subgraph_turn_downstream_into_parent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_t1 = _gate("t1")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[
            GraphNode(
                node_id="t1",
                title="T1",
                state=GraphNodeState.PLANNED,
                parent_node_id="b",
                gate_snapshot_hash=gate_t1.hash,
            ),
        ],
        blocks=[],
        gates=[gate_t1],
        entry_node_ids=["t1"],
        exit_node_ids=["t1"],
    )

    store.replace_node_with_subgraph("t", subgraph)

    assert store.get_node("t1").parent_node_id is None
    assert store.children_for("b") == []
    assert store.blockers_for("b") == ["t1"]


def test_replan_rejects_replacement_subgraph_that_reuses_existing_node_ids(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    reused_gate = _gate("b")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="root",
        nodes=[GraphNode(node_id="b", title="Reused B", state=GraphNodeState.PLANNED, gate_snapshot_hash=reused_gate.hash)],
        blocks=[],
        gates=[reused_gate],
        entry_node_ids=["b"],
        exit_node_ids=["b"],
    )

    with pytest.raises(ValueError, match="replacement subgraph reuses existing node_id"):
        store.replace_node_with_subgraph("t", subgraph)

    assert store.current_graph_revision() == 1
    assert store.get_node("b").title == "B"
    assert store.blockers_for("b") == ["t"]


def test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="t",
            nodes=[GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash)],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    reused_gate = _gate("t")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-2",
        root_node_id="t",
        nodes=[GraphNode(node_id="t", title="Replacement T", state=GraphNodeState.PLANNED, gate_snapshot_hash=reused_gate.hash)],
        blocks=[],
        gates=[reused_gate],
        entry_node_ids=["t"],
        exit_node_ids=["t"],
    )

    with pytest.raises(ValueError, match="replacement subgraph reuses superseded node_id"):
        store.replace_node_with_subgraph("t", subgraph)

    assert store.current_graph_revision() == 1
    assert store.get_node("t").state is GraphNodeState.REPLANNING


def test_replanning_plan_attempt_completion_replaces_node_with_subgraph(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_root = _gate("root")
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_root.hash),
                GraphNode(
                    node_id="a",
                    title="A",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_a.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.VERIFYING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                    rework_count=2,
                ),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_root, gate_a, gate_t, gate_b],
            entry_node_ids=["a", "root"],
            exit_node_ids=["b", "root"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    assert store.get_node("t").state is GraphNodeState.REPLANNING
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-rewrite", now=now, ttl_seconds=30)
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-rewrite",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[("t1", "t2")],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1"],
        exit_node_ids=["t2"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-rewrite",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=subgraph,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("t").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t").superseded_by == ["t1", "t2"]
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.blockers_for("t1") == ["a"]
    assert store.blockers_for("t2") == ["t1"]
    assert store.blockers_for("b") == ["t2"]
    assert store.get_attempt("plan-rewrite").state is AttemptState.SUCCEEDED


def test_replanning_replacement_node_completion_replaces_current_node_without_failed_history(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    gate_t1 = _gate("t1")
    store.replace_node_with_subgraph(
        "t",
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-2",
            root_node_id="root",
            nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.REPLANNING, gate_snapshot_hash=gate_t1.hash)],
            blocks=[],
            gates=[gate_t1],
            entry_node_ids=["t1"],
            exit_node_ids=["t1"],
        ),
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t1", attempt_id="plan-3", now=now, ttl_seconds=30)
    gate_t1a = _gate("t1a")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-3",
        root_node_id="root",
        nodes=[GraphNode(node_id="t1a", title="T1A", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1a.hash)],
        blocks=[],
        gates=[gate_t1a],
        entry_node_ids=["t1a"],
        exit_node_ids=["t1a"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-3",
            node_id="t1",
            status=AttemptState.SUCCEEDED,
            graph_revision=2,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 3
    assert store.get_node("t1").state is GraphNodeState.SUPERSEDED
    assert store.get_node("t1a").replan_depth == 2
    assert store.blockers_for("t1a") == ["a"]
    assert store.blockers_for("b") == ["t1a"]


def test_replanning_replacement_validation_uses_root_parent_intent(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    root_intent = {
        "requires_parent_aggregate": True,
        "parallel_dependency_shape": {
            "parallel_branch_node_ids": ["t1", "t2"],
            "downstream_node_ids": [],
        },
    }
    store.record_dispatch_context(
        "root",
        {
            "issue_id": "issue-root",
            "issue_identifier": "HELL-99",
            "description": "Root parent issue",
            "pipeline_intent": root_intent,
        },
    )
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="root", title="Root", state=GraphNodeState.PLANNED),
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    parent_node_id="root",
                    gate_snapshot_hash=gate_t.hash,
                ),
            ],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        ),
        intent_spec=IntentSpec.from_dispatch_context(
            {
                "issue_id": "issue-root",
                "issue_identifier": "HELL-99",
                "description": "Root parent issue",
                "pipeline_intent": root_intent,
            }
        ),
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-parent-repair", now=now, ttl_seconds=30)
    gate_t1 = _gate("t1")
    gate_t2 = _gate("t2")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-parent-repair",
        root_node_id="root",
        nodes=[
            GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t1.hash),
            GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_t2.hash),
        ],
        blocks=[],
        gates=[gate_t1, gate_t2],
        entry_node_ids=["t1", "t2"],
        exit_node_ids=["t1", "t2"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-parent-repair",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 2
    assert store.get_node("root").gate_snapshot_hash is None
    assert store.get_node("t1").parent_node_id == "root"
    assert store.get_node("t2").parent_node_id == "root"
    assert store.get_attempt("plan-parent-repair").state is AttemptState.SUCCEEDED


def test_replanning_validation_failure_escalates_to_human_without_failed_node(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    assert store.get_node("t").state is GraphNodeState.REPLANNING
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-invalid-rewrite", now=now, ttl_seconds=30)
    invalid_subgraph = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-invalid-rewrite",
        root_node_id="root",
        nodes=[GraphNode(node_id="t1", title="T1", state=GraphNodeState.PLANNED)],
        blocks=[],
        gates=[],
        entry_node_ids=["t1"],
        exit_node_ids=["t1"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid-rewrite",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=invalid_subgraph,
        ),
        at=now,
    )

    node = store.get_node("t")
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert waits[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value
    assert store.get_attempt("plan-invalid-rewrite").state is AttemptState.FAILED
    assert store.active_lease("t", RuntimeMode.PLAN) is None


def test_replan_depth_limit_escalates_before_rewriting_again(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_t = _gate("t")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="t",
                    title="T",
                    state=GraphNodeState.REPLANNING,
                    gate_snapshot_hash=gate_t.hash,
                    replan_depth=1,
                )
            ],
            blocks=[],
            gates=[gate_t],
            entry_node_ids=["t"],
            exit_node_ids=["t"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _record_attempt(
        store,
        "verify-t",
        "t",
        RuntimeMode.VERIFY,
        AttemptState.SUCCEEDED,
        gate_snapshot_hash=gate_t.hash,
        score=0,
    )
    replacement_gate = _gate("t2")
    replacement = PlanProposal(
        graph_id="graph-1",
        plan_attempt_id="plan-depth",
        root_node_id="root",
        nodes=[GraphNode(node_id="t2", title="T2", state=GraphNodeState.PLANNED, gate_snapshot_hash=replacement_gate.hash)],
        blocks=[],
        gates=[replacement_gate],
        entry_node_ids=["t2"],
        exit_node_ids=["t2"],
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-depth", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-depth",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=replacement,
        ),
        at=now,
    )

    node = store.get_node("t")
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert store.list_human_waits()[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value


def test_failed_invalid_replanning_attempt_escalates_replan_limit_without_backend_collapse(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1, max_rework_attempts=1)))
    gate_a = _gate("a")
    gate_t = _gate("t")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash, verify_score=3),
                GraphNode(node_id="t", title="T", state=GraphNodeState.VERIFYING, gate_snapshot_hash=gate_t.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "t"), ("t", "b")],
            gates=[gate_a, gate_t, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "t", execute_attempt_id="exec-t")
    failed_verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="t", attempt_id="verify-t", now=now, ttl_seconds=30)
    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-t",
            node_id="t",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_t.hash,
            lease_id=failed_verify_lease.lease_id,
            fencing_token=failed_verify_lease.fencing_token,
            passed=False,
            score=2,
            execute_attempt_id="exec-t",
            error="gate failed",
        ),
        at=now,
    )
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="t", attempt_id="plan-invalid-rewrite", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-invalid-rewrite",
            node_id="t",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            error="invalid_plan_proposal:missing_gate",
        ),
        at=now,
    )

    node = store.get_node("t")
    waits = store.list_human_waits()
    assert store.current_graph_revision() == 1
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.REPLAN_LIMIT_EXCEEDED
    assert waits[-1]["reason"] == HumanEscalationReason.REPLAN_LIMIT_EXCEEDED.value
    assert waits[-1]["details"]["error"] == "invalid_plan_proposal:missing_gate"
    assert store.get_attempt("plan-invalid-rewrite").state is AttemptState.FAILED
    assert store.active_lease("t", RuntimeMode.PLAN) is None


def test_initial_dispatch_plan_attempt_completion_commits_planner_graph(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id=accepted.node_id, attempt_id="plan-initial", now=now, ttl_seconds=30)
    gate_a = _gate("a")
    gate_b = _gate("b")
    proposal = PlanProposal(
        graph_id=accepted.graph_id,
        plan_attempt_id="plan-initial",
        root_node_id=accepted.node_id,
        nodes=[
            GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
        ],
        blocks=[("a", "b")],
        gates=[gate_a, gate_b],
        entry_node_ids=["a"],
        exit_node_ids=["b"],
    )

    assert store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-initial",
            node_id=accepted.node_id,
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=proposal,
        ),
        at=now,
    )

    assert store.current_graph_revision() == 2
    assert {node.node_id for node in store.list_nodes()} == {"a", "b"}
    assert store.get_node("a").state is GraphNodeState.READY
    assert store.blockers_for("b") == ["a"]
    assert store.current_graph_revision_record().root_node_id == accepted.node_id
    assert store.get_attempt("plan-initial").state is AttemptState.SUCCEEDED


def test_parent_node_state_is_derived_from_exit_children_before_downstream_dispatch(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_parent = _gate("parent")
    gate_child_1 = _gate("child-1")
    gate_child_2 = _gate("child-2")
    gate_downstream = _gate("downstream")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="parent",
            nodes=[
                GraphNode(
                    node_id="parent",
                    title="Parent",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_parent.hash,
                ),
                GraphNode(
                    node_id="child-1",
                    title="Child 1",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="parent",
                    gate_snapshot_hash=gate_child_1.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="child-2",
                    title="Child 2",
                    state=GraphNodeState.PLANNED,
                    parent_node_id="parent",
                    gate_snapshot_hash=gate_child_2.hash,
                ),
                GraphNode(
                    node_id="downstream",
                    title="Downstream",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_downstream.hash,
                ),
            ],
            blocks=[("child-1", "child-2"), ("parent", "downstream")],
            gates=[gate_parent, gate_child_1, gate_child_2, gate_downstream],
            entry_node_ids=["child-1", "parent"],
            exit_node_ids=["child-2", "downstream"],
        )
    )
    scheduler = PipelineScheduler(store)

    assert store.derive_parent_state("parent") is GraphNodeState.PLANNED
    parent_prediction = next(
        call for call in store.pipeline_view().to_dict()["predicted_call_order"] if call["node"] == "parent"
    )
    assert parent_prediction["aggregate_state"] == "in_progress"
    assert scheduler.is_dependency_satisfied("parent") is False
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="child-1",
            verify_attempt_id="verify-child-1",
            gate_snapshot_hash=gate_child_1.hash,
            score=3,
            code={"integrated_revision": "commit-child-1"},
        )
        )
    assert scheduler.promote_ready_nodes() == ["child-2"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["child-2"]

    store.update_node_state("child-2", GraphNodeState.VERIFY_PASSED, verify_score=3)
    refreshed = store.refresh_aggregate_parent_state("parent")

    assert refreshed.state is GraphNodeState.VERIFY_PASSED
    assert refreshed.verify_score == 3
    assert store.get_node("parent").state is GraphNodeState.PLANNED
    assert store.get_node("parent").verify_score is None
    assert scheduler.is_dependency_satisfied("parent") is False
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == []

    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="child-2",
            verify_attempt_id="verify-child-2",
            gate_snapshot_hash=gate_child_2.hash,
            score=3,
            code={"integrated_revision": "commit-child-2"},
        )
    )
    parent_view = next(node for node in store.pipeline_view().to_dict()["nodes"] if node["node_id"] == "parent")
    assert parent_view["state"] == "planned"
    assert parent_view["aggregate_state"] == "verify_passed"
    assert scheduler.is_dependency_satisfied("parent") is True
    assert scheduler.promote_ready_nodes() == ["downstream"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["downstream"]


def test_successful_child_verify_drives_parent_state_to_persisted_aggregate_terminal(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_parent = _gate("parent")
    gate_child_1 = _gate("child-1")
    gate_child_2 = _gate("child-2")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="parent",
            nodes=[
                GraphNode(node_id="parent", title="Parent", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_parent.hash),
                GraphNode(
                    node_id="child-1",
                    title="Child 1",
                    state=GraphNodeState.VERIFY_PASSED,
                    parent_node_id="parent",
                    gate_snapshot_hash=gate_child_1.hash,
                    verify_score=3,
                ),
                GraphNode(
                    node_id="child-2",
                    title="Child 2",
                    state=GraphNodeState.VERIFYING,
                    parent_node_id="parent",
                    gate_snapshot_hash=gate_child_2.hash,
                ),
            ],
            blocks=[("child-1", "child-2")],
            gates=[gate_parent, gate_child_1, gate_child_2],
            entry_node_ids=["parent", "child-1"],
            exit_node_ids=["parent", "child-2"],
        )
    )
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    _publish_verification_input(store, "child-2", execute_attempt_id="exec-child-2")
    lease = store.start_attempt(RuntimeMode.VERIFY, node_id="child-2", attempt_id="verify-child-2", now=now, ttl_seconds=30)

    assert store.complete_attempt_with_fencing(
        VerifyAttemptResult(
            attempt_id="verify-child-2",
            node_id="child-2",
            status=AttemptState.SUCCEEDED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash=gate_child_2.hash,
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            score=3,
            passed=True,
            execute_attempt_id="exec-child-2",
        ),
        at=now,
    )

    parent = store.get_node("parent")
    assert parent.state is GraphNodeState.VERIFY_PASSED
    assert parent.verify_score == 3


def test_scheduler_finds_stuck_nonterminal_nodes_without_live_driver(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_b = _gate("b")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.FAILED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )
    scheduler = PipelineScheduler(store)

    assert scheduler.find_stuck_nodes() == ["b"]
    store.create_human_wait("b", reason="CAPACITY_STARVED", details={"source": "test"})
    assert scheduler.find_stuck_nodes() == []


def test_scheduler_does_not_mark_promotable_or_live_blocked_planned_nodes_stuck(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("parallel-a")
    gate_b = _gate("parallel-b")
    gate_downstream = _gate("downstream")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(
                    node_id="parallel-a",
                    title="Parallel A",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_a.hash,
                ),
                GraphNode(
                    node_id="parallel-b",
                    title="Parallel B",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_b.hash,
                ),
                GraphNode(
                    node_id="downstream",
                    title="Downstream",
                    state=GraphNodeState.PLANNED,
                    gate_snapshot_hash=gate_downstream.hash,
                ),
            ],
            blocks=[("parallel-a", "downstream"), ("parallel-b", "downstream")],
            gates=[gate_a, gate_b, gate_downstream],
            entry_node_ids=["parallel-a", "parallel-b"],
            exit_node_ids=["downstream"],
        )
    )
    scheduler = PipelineScheduler(store)

    assert scheduler.find_stuck_nodes() == []
    assert scheduler.promote_ready_nodes() == ["parallel-a", "parallel-b"]
    assert scheduler.dispatchable_nodes(RuntimeMode.EXECUTE) == ["parallel-a", "parallel-b"]


async def test_coordinate_surfaces_stuck_pipeline_nodes_as_reconcile_findings_and_human_wait(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    store = ConductorStore(data_root)
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="root",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.FAILED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[("a", "b")],
            gates=[gate_a, gate_b],
            entry_node_ids=["a"],
            exit_node_ids=["b"],
        )
    )

    first = await service.coordinate_background_once()

    assert not any(finding.get("event") == "pipeline_node_stuck" for finding in first.reconcile_findings)
    assert service.pipeline_store.list_human_waits() == []
    observations = service.pipeline_store.pipeline_view().to_dict()["stuck_observations"]
    assert observations == [
        {
            "count": 1,
            "first_seen_at": observations[0]["first_seen_at"],
            "graph_revision": 1,
            "last_seen_at": observations[0]["last_seen_at"],
            "node_id": "b",
            "reason": "pipeline node has no live driver",
        }
    ]

    second = await service.coordinate_background_once()

    assert any(finding.get("event") == "pipeline_node_stuck" and finding.get("node_id") == "b" for finding in second.reconcile_findings)
    waits = service.pipeline_store.list_human_waits()
    assert waits[-1]["node_id"] == "b"
    assert waits[-1]["reason"] == HumanEscalationReason.CAPACITY_STARVED.value


def test_predicted_call_order_uses_topological_dependency_order_not_node_id_sort(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    gate_a = _gate("z-a")
    gate_b = _gate("m-b")
    gate_c = _gate("a-c")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="z-a",
            nodes=[
                GraphNode(node_id="a-c", title="C", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="m-b", title="B", state=GraphNodeState.PLANNED, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="z-a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            ],
            blocks=[("z-a", "m-b"), ("m-b", "a-c")],
            gates=[gate_a, gate_b, gate_c],
            entry_node_ids=["z-a"],
            exit_node_ids=["a-c"],
        )
    )

    payload = store.pipeline_view().to_dict()

    assert payload["blocks"] == [["z-a", "m-b"], ["m-b", "a-c"]]
    assert [call["node"] for call in payload["predicted_call_order"]] == ["z-a", "m-b", "a-c"]


def test_pipeline_view_exposes_gate_step_provenance_for_shape_checkpoint(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.commit_plan(_proposal())

    payload = store.pipeline_view().to_dict()

    assert payload["blocks"] == [["a", "b"]]
    assert payload["gates"]
    steps = payload["gates"][0]["content"]["verification_procedure"]
    assert steps == [{"step": "pytest -q", "source": "issue_requirement"}]


def test_predicted_call_positions_share_capacity_wave_for_same_mode_ready_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = SchedulerPolicy(
        policy_id="policy-capacity",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=2, by_mode={RuntimeMode.EXECUTE: 2}),
    )
    gate_a = _gate("ready-a")
    gate_b = _gate("ready-b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, policy))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="ready-b",
            nodes=[
                GraphNode(node_id="ready-b", title="Ready B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
                GraphNode(node_id="ready-a", title="Ready A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["ready-a", "ready-b"],
            exit_node_ids=["ready-a", "ready-b"],
        )
    )

    payload = store.pipeline_view().to_dict()
    positions = {call["node"]: call["predicted_position"] for call in payload["predicted_call_order"]}

    assert positions == {"ready-a": 1, "ready-b": 1}


def test_predicted_call_positions_account_for_active_leases(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = SchedulerPolicy(
        policy_id="policy-capacity",
        version=1,
        effective_at="2026-07-06T00:00:00Z",
        capacity=SchedulerCapacity(global_limit=1, by_mode={RuntimeMode.EXECUTE: 1}),
    )
    gate_a = _gate("ready-a")
    gate_b = _gate("ready-b")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, policy))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="ready-a",
            nodes=[
                GraphNode(node_id="ready-a", title="Ready A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="ready-b", title="Ready B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["ready-a", "ready-b"],
            exit_node_ids=["ready-a", "ready-b"],
        )
    )
    store.start_attempt(RuntimeMode.EXECUTE, node_id="ready-a", attempt_id="exec-a", now=datetime(2026, 7, 6, tzinfo=timezone.utc))

    payload = store.pipeline_view().to_dict()
    positions = {call["node"]: call["predicted_position"] for call in payload["predicted_call_order"]}

    assert positions["ready-b"] == 2


def test_pipeline_view_includes_mode_counts_and_conditional_prediction(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex", "token": "secret"},
                )
            },
        )
    )
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    wait = store.create_human_wait("b", reason="LINEAR_SYNC_CONFLICT", child_issue_id="child-1")
    store.record_linear_projection(
        node_id="a",
        linear_issue_id="issue-a",
        metadata={
            "graph_id": "graph-1",
            "node_id": "a",
            "plan_attempt_id": "plan-1",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash,
            "conductor_revision": 1,
        },
    )

    view = store.pipeline_view()
    payload = view.to_dict()

    execute = next(mode for mode in payload["modes"] if mode["mode"] == "execute")
    assert execute["active"] == 1
    assert execute["limit"] is None
    assert payload["predicted_call_order"][0]["node"] == "a"
    assert payload["predicted_call_order"][1]["blocked_by"] == ["b: awaiting human (LINEAR_SYNC_CONFLICT)"]
    assert payload["predicted_call_order"][1]["predicted_position"] is None
    assert payload["capacity"]["global"] == 2
    assert payload["policy_id"] == "policy-1"
    assert payload["policy_source"] == "podium_pushed"
    assert payload["leases"][0]["lease_id"] == lease.lease_id
    assert payload["attempts"][0]["attempt_id"] == "exec-1"
    assert payload["integration_queue"] == []
    assert payload["manifests"] == []
    assert payload["human_waits"][0]["wait_id"] == wait["wait_id"]
    assert payload["linear_projections"][0]["metadata"]["conductor_revision"] == 1
    assert payload["prediction_basis"]["dependency_policy"] == "verify_passed"
    assert payload["prediction_basis"]["graph_revision"] == 1
    assert payload["prediction_basis"]["policy_revision"] == 1
    assert payload["prediction_basis"]["assumption"] == "unknown verifies pass"
    assert payload["prediction_basis"]["generated_at"]
    node_a = next(node for node in payload["nodes"] if node["node_id"] == "a")
    assert node_a["progress_measure"] == {
        "replan_depth": 0,
        "rework_count": 0,
        "max_rework_attempts": 3,
        "terminal": False,
        "next_action": "wait_for_execute_result",
    }
    assert payload["runtime_config"]["profiles"]["execute"]["settings"] == {"model": "gpt-5.3-codex"}
    assert "secret" not in str(payload)


def test_pipeline_view_marks_local_default_policy_source(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)

    payload = store.pipeline_view().to_dict()

    assert payload["policy_id"] == "local-default"
    assert payload["policy_source"] == "local_default"
    assert payload["last_scheduler_policy_id"] == ""
    assert payload["last_scheduler_policy_version"] == 0
    assert payload["last_scheduler_policy_source"] == "no_scheduler_tick"
    assert payload["last_scheduler_tick_at"] == ""
    assert payload["prediction_basis"]["policy_id"] == "local-default"
    assert payload["prediction_basis"]["policy_source"] == "no_scheduler_tick"


def test_start_due_attempts_records_scheduler_tick_policy_used_by_view(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    policy = _policy(4)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 4, policy))
    store.commit_plan(_proposal())

    class Runtime:
        async def start(self, instance, **_kwargs):
            return instance

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **_changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())

    asyncio.run(coordinator.start_due_attempts(Instance()))
    payload = store.pipeline_view().to_dict()

    assert payload["last_scheduler_policy_id"] == policy.policy_id
    assert payload["last_scheduler_policy_version"] == policy.version
    assert payload["last_scheduler_policy_source"] == "podium_pushed"
    assert payload["last_scheduler_tick_at"]
    assert payload["prediction_basis"]["policy_id"] == policy.policy_id
    assert payload["prediction_basis"]["policy_version"] == policy.version
    assert payload["prediction_basis"]["policy_source"] == "podium_pushed"


def test_pipeline_view_excludes_terminal_and_human_wait_nodes_from_mode_queues(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.AWAITING_HUMAN, human_reason=HumanEscalationReason.BACKEND_UNAVAILABLE)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)

    payload = store.pipeline_view().to_dict()

    assert all("a" not in mode["node_ids"] for mode in payload["modes"])
    assert all("b" not in mode["node_ids"] for mode in payload["modes"])
    assert all(mode["queued"] == 0 for mode in payload["modes"])
    predictions = {call["node"]: call for call in payload["predicted_call_order"]}
    assert predictions["a"]["earliest_mode"] is None
    assert predictions["b"]["earliest_mode"] is None


def test_pipeline_prediction_blocks_on_unintegrated_verified_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.VERIFY_PASSED, verify_score=3)
    store.publish_task_output_manifest(
        TaskOutputManifest(
            node_id="a",
            verify_attempt_id="verify-a",
            gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
            score=3,
            code={"base_revision": "base-a", "patch_uri": "artifact://patch-a"},
        )
    )

    payload = store.pipeline_view().to_dict()
    prediction_b = next(call for call in payload["predicted_call_order"] if call["node"] == "b")

    assert prediction_b["predicted_position"] is None
    assert prediction_b["blocked_by"] == ["a: integration not completed"]


def test_pipeline_prediction_does_not_rank_non_dispatchable_terminal_or_human_wait_nodes(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    store.update_node_state("a", GraphNodeState.AWAITING_HUMAN, human_reason=HumanEscalationReason.BACKEND_UNAVAILABLE)
    store.update_node_state("b", GraphNodeState.VERIFY_PASSED, verify_score=3)

    payload = store.pipeline_view().to_dict()
    predictions = {call["node"]: call for call in payload["predicted_call_order"]}

    assert predictions["a"]["predicted_position"] is None
    assert predictions["a"]["earliest_mode"] is None
    assert predictions["a"]["blocked_by"] == ["a: awaiting human (BACKEND_UNAVAILABLE)"]
    assert predictions["b"]["predicted_position"] is None
    assert predictions["b"]["earliest_mode"] is None
    assert predictions["b"]["blocked_by"] == ["b: verify_passed is not dispatchable"]


def test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)
    attempt = store.get_attempt("exec-1")
    assert attempt.graph_revision == 1
    assert attempt.policy_revision == 1
    assert attempt.lease_id == lease.lease_id
    assert attempt.fencing_token == lease.fencing_token
    view_attempt = store.pipeline_view().to_dict()["attempts"][0]
    assert view_attempt["graph_revision"] == 1
    assert view_attempt["policy_revision"] == 1
    assert view_attempt["lease_id"] == lease.lease_id
    assert view_attempt["fencing_token"] == lease.fencing_token

    stale = ExecuteAttemptResult(
        attempt_id="exec-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=lease.lease_id,
        fencing_token="stale",
        verification_input={
            "task_id": "a",
            "execute_attempt_id": "exec-1",
            "base_revision": "base",
            "patch_uri": "artifact://patch",
            "patch_hash": "sha256:patch",
            "expected_result_tree": "tree",
            "artifact_uris": [],
            "declared_commands": ["pytest -q"],
            "evidence_uri": "artifact://evidence",
            "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash or "",
            "repository_path": "/repo",
            "workspace_path": "/workspace",
        },
    )

    assert store.complete_attempt_with_fencing(stale, at=now) is False
    assert store.get_attempt("exec-1").state is AttemptState.RUNNING

    accepted = ExecuteAttemptResult.from_dict({**stale.to_dict(), "fencing_token": lease.fencing_token})
    assert store.complete_attempt_with_fencing(accepted, at=now) is True
    assert store.get_attempt("exec-1").state is AttemptState.SUCCEEDED
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    with pytest.raises(ValueError, match="terminal_attempt_immutable"):
        store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-1", now=now, ttl_seconds=30)

    verify_lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)
    verdict = VerifyAttemptResult(
        attempt_id="verify-1",
        node_id="a",
        status=AttemptState.SUCCEEDED,
        graph_revision=1,
        policy_revision=1,
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        lease_id=verify_lease.lease_id,
        fencing_token=verify_lease.fencing_token,
        score=3,
        passed=True,
        execute_attempt_id="exec-1",
    )

    assert store.complete_attempt_with_fencing(verdict, at=now) is True
    assert store.get_node("a").state is GraphNodeState.VERIFY_PASSED
    assert store.list_task_output_manifests()[0].verify_attempt_id == "verify-1"


def test_failed_attempt_result_without_error_is_made_visible(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime.now(timezone.utc)
    lease = store.start_attempt(RuntimeMode.PLAN, node_id="a", attempt_id="plan-1", now=now, ttl_seconds=30)

    accepted = store.complete_attempt_with_fencing(
        PlanAttemptResult(
            attempt_id="plan-1",
            node_id="a",
            status=AttemptState.FAILED,
            graph_revision=1,
            policy_revision=1,
            gate_snapshot_hash="",
            lease_id=lease.lease_id,
            fencing_token=lease.fencing_token,
            proposal=None,
            error=None,
        ),
        at=now,
    )

    attempt = store.get_attempt("plan-1")
    wait = store.list_human_waits()[0]
    assert accepted is True
    assert attempt.state is AttemptState.FAILED
    assert attempt.error == "attempt_failed_without_reason"
    assert wait["details"]["error"] == "attempt_failed_without_reason"


def test_pipeline_coordinator_launches_planner_for_new_dispatch_with_mode_isolation(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1, dependency_policy=DependencySatisfactionPolicy.VERIFY_PASSED),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex", "token": "secret"},
                ),
                RuntimeMode.EXECUTE: RuntimeProfile(
                    name="executor",
                    backend="codex",
                    mode=RuntimeMode.EXECUTE,
                    settings={"model": "gpt-5.3-codex"},
                ),
                RuntimeMode.VERIFY: RuntimeProfile(
                    name="local-verifier",
                    backend="local-verifier",
                    mode=RuntimeMode.VERIFY,
                    settings={},
                ),
            },
        )
    )
    captured: dict[str, object] = {}

    class Runtime:
        async def start(self, instance, **kwargs):
            captured.update(kwargs)
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    started = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )

    assert started.node_id == "issue-1"
    assert store.get_node("issue-1").state is GraphNodeState.REPLANNING

    import asyncio

    asyncio.run(coordinator.start_due_attempts(Instance()))

    assert captured["mode"] == "plan"
    assert "advance_request_path" not in captured
    assert "phase_result_path" not in captured
    assert captured["attempt_request_path"] is not None
    assert captured["attempt_result_path"] is not None
    assert "CODEX_HOME" in captured["env"]
    assert "secret" not in str(captured["env"])
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_started" in log_text
    assert "mode=plan" in log_text
    assert "node_id=issue-1" in log_text
    assert "attempt_id=plan-" in log_text
    assert "lease_id=issue-1-plan-plan-" in log_text
    assert "graph_revision=1" in log_text
    assert "policy_revision=1" in log_text
    assert "request_path=" in log_text
    assert "result_path=" in log_text


def test_pipeline_planner_request_preserves_dispatch_graph_metadata(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("source repo\n", encoding="utf-8")
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(
                    name="planner",
                    backend="codex",
                    mode=RuntimeMode.PLAN,
                    settings={"model": "gpt-5.3-codex"},
                )
            },
        )
    )
    captured: dict[str, object] = {}

    class Runtime:
        async def start(self, instance, **kwargs):
            captured.update(kwargs)
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    accepted = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Root",
            "graph_id": "graph-from-dispatch",
            "plan_attempt_id": "plan-from-dispatch",
        },
        instance_id="inst-1",
    )

    asyncio.run(coordinator.start_due_attempts(Instance()))

    request = json.loads(Path(str(captured["attempt_request_path"])).read_text(encoding="utf-8"))
    workspace_path = Path(request["workspace_path"])
    attempt_dir = Path(str(captured["attempt_request_path"])).parent
    assert accepted.graph_id == "graph-from-dispatch"
    assert accepted.plan_attempt_id == "plan-from-dispatch"
    assert request["graph_id"] == "graph-from-dispatch"
    assert request["root_node_id"] == "issue-1"
    assert request["node_id"] == "issue-1"
    assert workspace_path == attempt_dir / "planner-workspace"
    assert workspace_path.is_dir()
    assert (workspace_path / "README.md").read_text(encoding="utf-8") == "source repo\n"
    assert request["issue_description"] == ""


def test_planner_workspace_materialization_isolates_source_repo_writes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    source_file = repo / "README.md"
    source_file.write_text("source repo\n", encoding="utf-8")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan",
    )
    workspace_path = Path(request["workspace_path"])

    (workspace_path / "README.md").write_text("planner draft\n", encoding="utf-8")

    assert workspace_path == tmp_path / "attempt-plan" / "planner-workspace"
    assert source_file.read_text(encoding="utf-8") == "source repo\n"


def test_pipeline_attempt_requests_include_dispatch_issue_description(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("baseline\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    issue_description = (
        "Real Symphony e2e task. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, "
        "include this Linear issue identifier, and run pytest tests/test_smoke.py -q."
    )
    coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "title": "Real E2E",
            "description": issue_description,
            "pipeline_intent": {
                "required_gate_steps": [
                    {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
                ],
                "parallel_dependency_shape": {
                    "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
                    "downstream_node_ids": ["hell-downstream-integration"],
                },
            },
        },
        instance_id="inst-1",
    )
    plan_lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    plan_request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        lease=plan_lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan",
    )
    gate = _gate("issue-1")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-issue-1",
            plan_attempt_id="plan-1",
            root_node_id="issue-1",
            nodes=[
                GraphNode(
                    node_id="issue-1",
                    title="Real E2E",
                    state=GraphNodeState.READY,
                    issue_id="issue-1",
                    issue_identifier="HELL-1",
                    gate_snapshot_hash=gate.hash,
                )
            ],
            blocks=[],
            gates=[gate],
            entry_node_ids=["issue-1"],
            exit_node_ids=["issue-1"],
        )
    )
    execute_lease = store.start_attempt(
        RuntimeMode.EXECUTE,
        node_id="issue-1",
        attempt_id="exec-1",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )
    execute_request = coordinator._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="issue-1",
        attempt_id="exec-1",
        lease=execute_lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-exec",
    )

    assert plan_request["issue_description"] == issue_description
    assert plan_request["pipeline_intent"]["parallel_dependency_shape"] == {
        "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
        "downstream_node_ids": ["hell-downstream-integration"],
    }
    assert plan_request["pipeline_intent"]["required_gate_steps"] == [
        {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
    ]
    assert execute_request["task_title"] == "Real E2E"
    assert execute_request["issue_identifier"] == "HELL-1"
    assert execute_request["issue_description"] == issue_description


def test_child_replan_attempt_request_falls_back_to_root_dispatch_context(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    root_context = {
        "issue_id": "issue-root",
        "issue_identifier": "HELL-42",
        "title": "Root issue",
        "description": "Root issue description with acceptance context.",
        "pipeline_intent": {
            "requires_parent_aggregate": True,
            "required_gate_steps": [{"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}],
        },
    }
    store.record_dispatch_context("root", root_context)
    store.commit_plan(_parent_proposal(), intent_spec=_parent_intent())
    lease = store.start_attempt(
        RuntimeMode.PLAN,
        node_id="a",
        attempt_id="plan-child",
        now=datetime(2026, 7, 6, tzinfo=timezone.utc),
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = coordinator._attempt_request(
        RuntimeMode.PLAN,
        node_id="a",
        attempt_id="plan-child",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt-plan-child",
    )

    assert request["issue_id"] == "issue-root"
    assert request["issue_identifier"] == "HELL-42"
    assert request["issue_description"] == "Root issue description with acceptance context."
    assert request["pipeline_intent"]["requires_parent_aggregate"] is True
    assert request["pipeline_intent"]["required_gate_steps"] == [
        {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
    ]


def test_execute_attempt_request_uses_integrated_blocker_manifests_as_baseline(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    manifest = TaskOutputManifest(
        node_id="a",
        verify_attempt_id="verify-a",
        gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
        score=3,
        code={
            "base_revision": "base-a",
            "patch_uri": "artifact://patch-a",
            "expected_result_tree": "tree-a",
            "integrated_revision": "commit-a",
        },
    )
    store.publish_task_output_manifest(manifest)
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="b", attempt_id="exec-b", now=now, ttl_seconds=30)

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path / "repo")

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    request = coordinator._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="b",
        attempt_id="exec-b",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    assert request["base_revision"] == "commit-a"
    assert request["upstream_manifests"][0]["node_id"] == "a"
    assert request["upstream_manifests"][0]["code"]["integrated_revision"] == "commit-a"


def test_execute_attempt_request_with_two_blockers_uses_current_integrated_revision(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "a.txt").write_text("a before\n", encoding="utf-8")
    (repo / "c.txt").write_text("c before\n", encoding="utf-8")
    subprocess.run(["git", "add", "a.txt", "c.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    base_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    patches: dict[str, tuple[str, str, str]] = {}
    for node_id, filename, content in (("c", "c.txt", "c after\n"), ("a", "a.txt", "a after\n")):
        target = repo / filename
        target.write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", filename], cwd=repo, check=True)
        patch = subprocess.check_output(["git", "diff", "--binary", "--cached"], cwd=repo, text=True)
        expected_tree = subprocess.check_output(["git", "write-tree"], cwd=repo, text=True).strip()
        subprocess.run(["git", "reset", "--hard", base_revision], cwd=repo, check=True, capture_output=True, text=True)
        patch_path = tmp_path / f"{node_id}.diff"
        patch_path.write_text(patch, encoding="utf-8")
        patches[node_id] = (
            f"file://{patch_path}",
            "sha256:" + hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            expected_tree,
        )

    gate_a = _gate("a")
    gate_c = _gate("c")
    gate_d = _gate("d")
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="d",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="c", title="C", state=GraphNodeState.VERIFY_PASSED, gate_snapshot_hash=gate_c.hash),
                GraphNode(node_id="d", title="D", state=GraphNodeState.READY, gate_snapshot_hash=gate_d.hash),
            ],
            blocks=[("a", "d"), ("c", "d")],
            gates=[gate_a, gate_c, gate_d],
            entry_node_ids=["a", "c"],
            exit_node_ids=["d"],
        )
    )
    for node_id in ("c", "a"):
        patch_uri, patch_hash, expected_tree = patches[node_id]
        manifest = TaskOutputManifest(
            node_id=node_id,
            verify_attempt_id=f"verify-{node_id}",
            gate_snapshot_hash=store.get_node(node_id).gate_snapshot_hash or "",
            score=3,
            code={
                "base_revision": base_revision,
                "patch_uri": patch_uri,
                "patch_hash": patch_hash,
                "expected_result_tree": expected_tree,
            },
        )
        store.publish_task_output_manifest(manifest)
        store.enqueue_integration(manifest)
    store.process_queued_integrations(repo)
    queue = store.list_integration_queue()
    current_integrated_revision = queue[1]["integrated_revision"]
    assert queue[0]["node_id"] == "c"
    assert queue[1]["node_id"] == "a"

    lease = WorkerLease.create(
        lease_id="lease-exec",
        mode=RuntimeMode.EXECUTE,
        node_id="d",
        attempt_id="exec-d",
        acquired_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        ttl_seconds=30,
    )

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = PipelineCoordinator(store=store, runtime_manager=object())._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="d",
        attempt_id="exec-d",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    assert request["base_revision"] == current_integrated_revision
    assert [manifest["node_id"] for manifest in request["upstream_manifests"]] == ["a", "c"]
    assert all(manifest["code"]["integrated_revision"] for manifest in request["upstream_manifests"])


def test_execute_attempt_request_freezes_entry_baseline_revision(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    (repo / "README.md").write_text("baseline\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True, text=True)
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    lease = WorkerLease.create(
        lease_id="lease-exec",
        mode=RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-1",
        acquired_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        ttl_seconds=30,
    )

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(repo)

    request = PipelineCoordinator(store=store, runtime_manager=object())._attempt_request(
        RuntimeMode.EXECUTE,
        node_id="a",
        attempt_id="exec-1",
        lease=lease,
        instance=Instance(),
        attempt_dir=tmp_path / "attempt",
    )

    assert request["base_revision"] == baseline
    assert request["repository"]["resolved_repo_path"] == str(repo)


def test_pipeline_coordinator_resumes_existing_root_planning_node_for_duplicate_dispatch(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    first = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    store.update_node_state("issue-1", GraphNodeState.AWAITING_HUMAN)

    second = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Updated webhook title should not replace durable graph",
        },
        instance_id="inst-1",
    )

    node = store.get_node("issue-1")
    assert second == first
    assert store.current_graph_revision() == 1
    assert node.title == "Plan feature"
    assert node.state is GraphNodeState.AWAITING_HUMAN


def test_pipeline_coordinator_resumes_existing_root_by_issue_identifier(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())

    first = coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )

    second = coordinator.accept_dispatch(
        {
            "issue_identifier": "ENG-1",
            "title": "Plan feature duplicate",
        },
        instance_id="inst-1",
    )

    node = store.get_node("issue-1")
    assert second == first
    assert store.current_graph_revision() == 1
    assert node.issue_identifier == "ENG-1"


async def test_dispatch_podium_event_syncs_runtime_config_before_starting_attempt(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )
    service = ConductorService(
        store=store,
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )
    service.pipeline_store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 0, _policy(0), profiles={}))
    calls: list[str] = []

    async def fake_report():
        calls.append("report")
        service.pipeline_store.apply_runtime_config(
            RuntimeConfigEnvelope(
                "group-1",
                1,
                _policy(1),
                profiles={
                    RuntimeMode.PLAN: RuntimeProfile(
                        name="planner",
                        backend="codex",
                        mode=RuntimeMode.PLAN,
                        settings={"model": "gpt-5.3-codex"},
                    )
                },
            )
        )
        return {"status": "ok", "config": service.pipeline_store.active_runtime_config().to_dict()}

    async def fake_start(instance, **kwargs):
        calls.append("start")
        return instance.with_updates(process_status="running", pid=1234)

    service.post_podium_report = fake_report  # type: ignore[method-assign]
    service.runtime_manager.start = fake_start  # type: ignore[method-assign]

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
            "project_slug": "ENG",
            "agent_app_user_id": "agent-1",
        }
    )

    assert result["status"] == "accepted"
    assert calls[:2] == ["report", "start"]
    attempt = service.pipeline_store.list_attempts()[0]
    lease = service.pipeline_store.active_lease("issue-1", RuntimeMode.PLAN)
    assert attempt.state is AttemptState.RUNNING
    assert lease is not None
    assert result["node_id"] == "issue-1"
    assert result["mode"] == "plan"
    assert result["attempt_id"] == attempt.attempt_id
    assert result["attempt_status"] == "running"
    assert result["graph_revision"] == 1
    assert result["policy_revision"] == 1
    assert result["lease_id"] == lease.lease_id


def test_conductor_runtime_config_ingest_surfaces_invalid_config(tmp_path: Path) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )

    applied = service._apply_runtime_config_payload(
        {
            "runtime_group_id": "group-1",
            "version": 2,
            "scheduler_policy": {
                "policy_id": "policy-2",
                "version": 2,
                "effective_at": "2026-07-06T00:00:00Z",
                "capacity": {"global": 3, "by_mode": {"plan": 1, "execute": 1, "verify": 1}},
                "dependency_policy": "verify_passed",
            },
            "profiles": {
                "plan": {"name": "planner", "backend": "codex", "mode": "plan", "settings": {"model": "gpt-5.3-codex"}}
            },
        }
    )

    assert applied is False
    assert service._pipeline_reconcile_findings == [
        {
            "event": "runtime_config_apply_failed",
            "severity": "warning",
            "error_type": "ValueError",
            "sanitized_reason": "invalid runtime config: runtime_profiles_missing:execute,verify",
            "action_required": "fix_runtime_config",
            "retryable": True,
            "runtime_group_id": "group-1",
            "version": 2,
        }
    ]
    assert service.pipeline_store.active_runtime_config().version == 1


async def test_dispatch_available_wakeup_leases_dispatch_before_pipeline_accept(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    store.save_instance(
        InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(instance_dir),
            workspace_root=str(instance_dir / "workspace" / "repo"),
            persistence_path=str(instance_dir / "state" / "performer.json"),
            log_path=str(instance_dir / "logs" / "performer.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "agent-1"},
        )
    )
    class Runtime:
        async def start(self, instance, **kwargs):
            return instance.with_updates(process_status="running", pid=1234)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=Runtime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)},
        )
    )
    calls: list[str] = []

    async def fake_poll():
        calls.append("lease")
        await service.dispatch_podium_event(
            {
                "issue_id": "issue-1",
                "issue_identifier": "ENG-1",
                "title": "Plan feature",
                "project_slug": "ENG",
                "agent_app_user_id": "agent-1",
            }
        )
        return {"status": "leased"}

    service.poll_podium_dispatch_once = fake_poll  # type: ignore[method-assign]

    queued = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "project_binding_id": "binding-1",
            "instance_id": "inst-1",
        }
    )
    result = await service.coordinate_background_once()

    assert queued == {"status": "queued", "issue_id": None, "issue_identifier": None, "agent_session_id": None}
    assert calls == ["lease"]
    assert service.pipeline_store.get_node("issue-1").state is GraphNodeState.REPLANNING
    assert result.dispatch_acks["acked"] == 1


async def test_dispatch_queue_drain_surfaces_failed_dispatch_acceptance(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    service = ConductorService(
        store=ConductorStore(data_root),
        data_root=data_root,
        runtime_manager=ConductorRuntimeManager(command="performer"),
    )

    async def fail_dispatch(_event):
        raise RuntimeError("token=dispatch-secret malformed payload")

    service.dispatch_podium_event = fail_dispatch  # type: ignore[method-assign]

    queued = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "agent_app_user_id": "agent-1",
        }
    )
    result = await service.coordinate_background_once()

    assert queued == {"status": "queued", "issue_id": "issue-1", "issue_identifier": "ENG-1", "agent_session_id": None}
    assert result.dispatch_acks == {"acked": 0, "failed": 1, "skipped": 0}
    assert result.reconcile_findings == [
        {
            "event": "podium_dispatch_drain_failed",
            "severity": "warning",
            "error_type": "RuntimeError",
            "sanitized_reason": "token=[REDACTED] malformed payload",
            "action_required": "retry_dispatch_drain",
            "retryable": True,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
        }
    ]


async def test_background_coordination_fails_running_attempt_when_process_exits_without_result(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    )
    instance = instance.with_updates(process_status="running", pid=1234)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text(
        "performer startup failed: unexpected status 401 Unauthorized: Missing bearer authentication\n",
        encoding="utf-8",
    )
    store.save_instance(instance)

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=1)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
            },
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )

    result = await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    node = service.pipeline_store.get_node("issue-1")
    waits = service.pipeline_store.list_human_waits()
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert result.pipeline_crash_failures == 1
    assert attempt.state is AttemptState.FAILED
    assert "401 Unauthorized" in str(attempt.error)
    assert service.pipeline_store.active_lease("issue-1", RuntimeMode.PLAN) is None
    assert node.state is GraphNodeState.AWAITING_HUMAN
    assert node.human_reason is HumanEscalationReason.BACKEND_UNAVAILABLE
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["lease_id"] == lease.lease_id
    assert "401 Unauthorized" in waits[0]["details"]["error"]
    assert "pipeline_attempt_process_exited" in log_text
    assert "attempt_id=plan-1" in log_text


async def test_background_coordination_starts_due_attempts_while_instance_already_running(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    ).with_updates(process_status="running", pid=1234)
    store.save_instance(instance)

    class RunningRuntime:
        def __init__(self) -> None:
            self.starts: list[dict[str, object]] = []

        def refresh(self, record):
            return record

        async def start(self, record, **kwargs):
            self.starts.append(kwargs)
            return record.with_updates(process_status="running", pid=1234)

    runtime = RunningRuntime()
    service = ConductorService(store=store, data_root=data_root, runtime_manager=runtime)  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )

    result = await service.coordinate_background_once()

    assert result.pipeline_attempts_started == 2
    assert [start["mode"] for start in runtime.starts] == ["execute", "execute"]
    assert sorted(lease.node_id for lease in service.pipeline_store.list_active_leases()) == ["a", "b"]
    assert sorted(
        attempt.process_pid for attempt in service.pipeline_store.list_attempts() if attempt.mode is RuntimeMode.EXECUTE
    ) == [1234, 1234]
    assert all(
        attempt["process_pid"] == 1234
        for attempt in service.pipeline_store.pipeline_view().to_dict()["attempts"]
        if attempt["mode"] == "execute"
    )


async def test_background_coordination_fails_only_drained_exited_attempt(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    ).with_updates(process_status="running", pid=2222)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text("attempt exec-a exited while exec-b kept running\n", encoding="utf-8")
    store.save_instance(instance)

    class AttemptExitRuntime:
        def __init__(self) -> None:
            self._drained = False

        def refresh(self, record):
            return record

        def drain_exited_attempts(self, record):
            if self._drained:
                return []
            self._drained = True
            return [
                {
                    "instance_id": record.id,
                    "attempt_id": "exec-a",
                    "mode": "execute",
                    "lease_id": lease_a.lease_id,
                    "pid": 1111,
                    "exit_code": 7,
                }
            ]

        async def start(self, record, **_kwargs):
            return record.with_updates(process_status="running", pid=2222)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=AttemptExitRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate_a = _gate("a")
    gate_b = _gate("b")
    service.pipeline_store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[
                GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate_a.hash),
                GraphNode(node_id="b", title="B", state=GraphNodeState.READY, gate_snapshot_hash=gate_b.hash),
            ],
            blocks=[],
            gates=[gate_a, gate_b],
            entry_node_ids=["a", "b"],
            exit_node_ids=["a", "b"],
        )
    )
    now = datetime.now(timezone.utc)
    lease_a = service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=now)
    lease_b = service.pipeline_store.start_attempt(RuntimeMode.EXECUTE, node_id="b", attempt_id="exec-b", now=now)

    result = await service.coordinate_background_once()

    assert result.pipeline_crash_failures == 1
    assert service.pipeline_store.get_attempt("exec-a").state is AttemptState.FAILED
    assert service.pipeline_store.get_attempt("exec-b").state is AttemptState.RUNNING
    assert service.pipeline_store.active_lease("a", RuntimeMode.EXECUTE) is None
    assert service.pipeline_store.active_lease("b", RuntimeMode.EXECUTE).lease_id == lease_b.lease_id  # type: ignore[union-attr]
    assert "process exited with code 7" in str(service.pipeline_store.get_attempt("exec-a").error)
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert "pipeline_attempt_process_exited" in log_text
    assert "attempt_id=exec-a" in log_text
    assert "attempt_id=exec-b" not in log_text


def test_fail_exited_attempt_snapshot_defers_when_result_file_exists(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE)},
        )
    )
    gate = _gate("a")
    store.commit_plan(
        PlanProposal(
            graph_id="graph-1",
            plan_attempt_id="plan-1",
            root_node_id="a",
            nodes=[GraphNode(node_id="a", title="A", state=GraphNodeState.READY, gate_snapshot_hash=gate.hash)],
            blocks=[],
            gates=[gate],
            entry_node_ids=["a"],
            exit_node_ids=["a"],
        )
    )
    lease = store.start_attempt(RuntimeMode.EXECUTE, node_id="a", attempt_id="exec-a", now=datetime.now(timezone.utc))
    verification_input = _publish_verification_input(store, "a", execute_attempt_id="exec-a")
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / "exec-a" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    graph_revision = store.current_graph_revision()
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id="exec-a",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=graph_revision,
                policy_revision=1,
                gate_snapshot_hash=gate.hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                verification_input=verification_input.to_dict(),
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class Instance:
        instance_dir = str(tmp_path / "inst-1")
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")
        process_status = "exited"
        last_exit_code = 0

    coordinator = PipelineCoordinator(store=store, runtime_manager=None)

    failed = coordinator.fail_exited_attempt_snapshot(
        Instance,
        {
            "attempt_id": "exec-a",
            "mode": "execute",
            "lease_id": lease.lease_id,
            "result_path": str(result_path),
            "exit_code": 0,
        },
    )

    assert failed == 0
    assert coordinator.fail_running_attempts_for_exited_process(Instance) == 0
    assert store.get_attempt("exec-a").state is AttemptState.RUNNING
    assert store.active_lease("a", RuntimeMode.EXECUTE) is not None
    assert coordinator.collect_result_files(Instance) == 1
    assert store.get_attempt("exec-a").state is AttemptState.SUCCEEDED


async def test_process_exit_error_uses_current_generation_log_tail(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    ).with_updates(process_status="running", pid=1234)
    logs_dir = instance_dir / "logs"
    logs_dir.mkdir(parents=True)
    current_log = logs_dir / "performer-000001.log"
    current_log.write_text("event=performer_stream message=401 Unauthorized from current generation\n", encoding="utf-8")
    (logs_dir / "current.log").write_text(str(current_log), encoding="utf-8")
    Path(instance.log_path).write_text("stale start line only\n", encoding="utf-8")
    store.save_instance(instance)

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=1)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN)},
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "ENG-1", "title": "Plan feature"},
        instance_id="inst-1",
    )
    service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )

    await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    assert "401 Unauthorized from current generation" in str(attempt.error)


async def test_background_coordination_applies_result_file_before_process_exit_fallback(tmp_path: Path) -> None:
    data_root = tmp_path / "conductor-data"
    repo = tmp_path / "repo"
    repo.mkdir()
    store = ConductorStore(data_root)
    instance_dir = data_root / "instances" / "inst-1"
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace" / "repo"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"linear_agent_app_user_id": "agent-1"},
    )
    instance = instance.with_updates(process_status="running", pid=1234)
    Path(instance.log_path).parent.mkdir(parents=True, exist_ok=True)
    Path(instance.log_path).write_text("performer exited after writing fenced failure\n", encoding="utf-8")
    store.save_instance(instance)

    class ExitedRuntime:
        def refresh(self, record):
            return record.with_updates(process_status="exited", pid=None, last_exit_code=0)

    service = ConductorService(store=store, data_root=data_root, runtime_manager=ExitedRuntime())  # type: ignore[arg-type]
    service.pipeline_store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.PLAN: RuntimeProfile(name="planner", backend="codex", mode=RuntimeMode.PLAN),
            },
        )
    )
    service.pipeline_coordinator.accept_dispatch(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "title": "Plan feature",
        },
        instance_id="inst-1",
    )
    lease = service.pipeline_store.start_attempt(
        RuntimeMode.PLAN,
        node_id="issue-1",
        attempt_id="plan-1",
        now=datetime.now(timezone.utc),
    )
    result_path = instance_dir / "state" / "pipeline" / "plan-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
            PlanAttemptResult(
                attempt_id="plan-1",
                node_id="issue-1",
                status=AttemptState.FAILED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash="",
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                proposal=None,
                error="unexpected status 401 Unauthorized: Missing bearer authentication",
            ).to_dict()
        ),
        encoding="utf-8",
    )

    result = await service.coordinate_background_once()

    attempt = service.pipeline_store.get_attempt("plan-1")
    waits = service.pipeline_store.list_human_waits()
    log_text = Path(instance.log_path).read_text(encoding="utf-8")
    assert result.pipeline_results_applied == 1
    assert result.pipeline_crash_failures == 0
    assert attempt.state is AttemptState.FAILED
    assert attempt.error == "unexpected status 401 Unauthorized: Missing bearer authentication"
    assert waits[0]["reason"] == HumanEscalationReason.BACKEND_UNAVAILABLE.value
    assert waits[0]["details"]["attempt_id"] == "plan-1"
    assert waits[0]["details"]["error"] == "unexpected status 401 Unauthorized: Missing bearer authentication"
    assert "pipeline_attempt_process_exited" not in log_text
    assert result_path.with_suffix(".json.applied").exists()


def test_pipeline_coordinator_collects_result_files_with_fencing(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path)
    store.apply_runtime_config(
        RuntimeConfigEnvelope(
            "group-1",
            1,
            _policy(1),
            profiles={
                RuntimeMode.EXECUTE: RuntimeProfile(name="executor", backend="codex", mode=RuntimeMode.EXECUTE),
            },
        )
    )
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)

    class Runtime:
        async def start(self, instance, **kwargs):
            return instance.with_updates(process_status="running", pid=1234)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        resolved_repo_path = str(tmp_path)
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

        def with_updates(self, **changes):
            return self

    coordinator = PipelineCoordinator(store=store, runtime_manager=Runtime())
    import asyncio

    asyncio.run(coordinator.start_due_attempts(Instance(), now=now))
    attempt = store.active_lease("a", RuntimeMode.EXECUTE)
    assert attempt is not None
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / attempt.attempt_id / "attempt-result.json"
    result_path.write_text(
        json.dumps(
            ExecuteAttemptResult(
                attempt_id=attempt.attempt_id,
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=store.get_node("a").gate_snapshot_hash or "",
                lease_id=attempt.lease_id,
                fencing_token=attempt.fencing_token,
                verification_input={
                    "task_id": "a",
                    "execute_attempt_id": attempt.attempt_id,
                    "base_revision": "base",
                    "patch_uri": "artifact://patch",
                    "patch_hash": "sha256:patch",
                    "expected_result_tree": "tree",
                    "artifact_uris": [],
                    "declared_commands": ["pytest -q"],
                    "evidence_uri": "artifact://evidence",
                    "gate_snapshot_hash": store.get_node("a").gate_snapshot_hash or "",
                    "repository_path": "/repo",
                    "workspace_path": "/workspace",
                },
            ).to_dict()
        ),
        encoding="utf-8",
    )

    assert coordinator.collect_result_files(Instance(), now=now) == 1
    assert store.get_node("a").state is GraphNodeState.VERIFYING
    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_result_applied" in log_text
    assert f"attempt_id={attempt.attempt_id}" in log_text
    assert "node_id=a" in log_text
    assert "mode=execute" in log_text
    assert f"lease_id={attempt.lease_id}" in log_text
    assert f"result_path={result_path.with_suffix('.json.applied')}" in log_text


def test_pipeline_coordinator_logs_verify_manifest_and_integration_events(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    store.apply_runtime_config(RuntimeConfigEnvelope("group-1", 1, _policy(1)))
    store.commit_plan(_proposal())
    now = datetime(2026, 7, 6, tzinfo=timezone.utc)
    snapshot = _publish_verification_input(store, "a", execute_attempt_id="exec-1")
    store.update_node_state("a", GraphNodeState.VERIFYING)
    lease = store.start_attempt(RuntimeMode.VERIFY, node_id="a", attempt_id="verify-1", now=now, ttl_seconds=30)

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")
        log_path = str(tmp_path / "inst-1" / "logs" / "performer.log")

    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    result_path = Path(Instance.instance_dir) / "state" / "pipeline" / "verify-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
            VerifyAttemptResult(
                attempt_id="verify-1",
                node_id="a",
                status=AttemptState.SUCCEEDED,
                graph_revision=1,
                policy_revision=1,
                gate_snapshot_hash=snapshot.gate_snapshot_hash,
                lease_id=lease.lease_id,
                fencing_token=lease.fencing_token,
                score=3,
                passed=True,
                execute_attempt_id="exec-1",
            ).to_dict()
        ),
        encoding="utf-8",
    )

    assert coordinator.collect_result_files(Instance(), now=now) == 1

    log_text = Path(Instance.log_path).read_text(encoding="utf-8")
    assert "event=pipeline_result_applied" in log_text
    assert "event=pipeline_manifest_published" in log_text
    assert "event=pipeline_integration_queued" in log_text
    assert "attempt_id=verify-1" in log_text
    assert "node_id=a" in log_text
    assert "mode=verify" in log_text
    assert f"lease_id={lease.lease_id}" in log_text
    assert "integration_id=integration-a-verify-1" in log_text


def test_pipeline_coordinator_logs_invalid_result_file(tmp_path: Path) -> None:
    store = ConductorPipelineStore(tmp_path / "store")
    coordinator = PipelineCoordinator(store=store, runtime_manager=object())
    result_path = tmp_path / "inst-1" / "state" / "pipeline" / "attempt-1" / "attempt-result.json"
    result_path.parent.mkdir(parents=True)
    result_path.write_text("{not-json", encoding="utf-8")
    log_path = tmp_path / "inst-1" / "logs" / "performer.log"

    class Instance:
        id = "inst-1"
        instance_dir = str(tmp_path / "inst-1")

    Instance.log_path = str(log_path)

    assert coordinator.collect_result_files(Instance()) == 0

    log_text = log_path.read_text(encoding="utf-8")
    assert "event=pipeline_result_file_invalid" in log_text
    assert "attempt_id=attempt-1" in log_text
    assert "result_path=" in log_text
