from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_driver import ConductorManagedRunDriver
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from conductor.conductor_models import InstanceRecord
from performer_api.managed_runs import (
    ChangedFile,
    ManagedRunPlan,
    ManagedRunState,
    ParallelizationPolicy,
    TaskOutputManifest,
    VerificationRubric,
    WorkItem,
    WorkItemResult,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


class FakeRuntimeManager:
    def __init__(self) -> None:
        self.starts: list[dict[str, Any]] = []
        self.exited_attempts: list[dict[str, object]] = []
        self.stopped_attempt_ids: list[list[str]] = []

    def refresh(self, instance: InstanceRecord) -> InstanceRecord:
        return instance

    def drain_exited_attempts(self, instance: InstanceRecord) -> list[dict[str, object]]:
        drained = [snapshot for snapshot in self.exited_attempts if snapshot.get("instance_id") == instance.id]
        self.exited_attempts = [snapshot for snapshot in self.exited_attempts if snapshot.get("instance_id") != instance.id]
        return drained

    async def start(self, instance: InstanceRecord, **kwargs: Any) -> InstanceRecord:
        self.starts.append(kwargs)
        return instance.with_updates(process_status="running", pid=1234)

    async def stop_attempts(self, instance: InstanceRecord, attempt_ids: list[str]) -> InstanceRecord:
        self.stopped_attempt_ids.append(list(attempt_ids))
        return instance.with_updates(process_status="running", pid=1234)


def _instance(tmp_path: Path) -> InstanceRecord:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_repo(repo)
    _write_commit(repo, ".managed-run-base", "base\n", "base")
    instance_dir = tmp_path / "instances" / "inst-1"
    return InstanceRecord.create(
        id="inst-1",
        name="Instance 1",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="HELL",
        linear_filters={},
    )


def _runtime_config() -> dict[str, Any]:
    return {
        "runtime_group_id": "group-1",
        "version": 1,
        "managed_run_policy": {
            "policy_id": "policy-group-1",
            "version": 1,
            "effective_at": "2026-07-09T00:00:00Z",
            "capacity": {"global": 3, "by_role": {"plan": 1, "work_item": 2, "verify": 1}},
            "max_rework_attempts": 1,
        },
        "profiles": {
            "plan": {"name": "plan", "backend": "codex", "role": "plan", "settings": {}},
            "work_item": {"name": "work", "backend": "codex", "role": "work_item", "settings": {}},
            "verify": {"name": "verify", "backend": "local-verifier", "role": "verify", "settings": {}},
        },
    }


def _plan() -> ManagedRunPlan:
    green_command = "python -c \"print('managed-run verification ok')\""
    return ManagedRunPlan(
        summary="Managed run",
        architecture_decisions=["Use a work item"],
        work_items=[
            WorkItem(
                id="wi-1",
                title="Implement result",
                objective="Create a result file",
                slice_type=WorkItemSliceType.VERTICAL,
                acceptance_criteria=["result exists"],
                verification=WorkItemVerification(red_command=green_command, green_commands=[green_command]),
                dependencies=[],
                estimated_scope="S",
                files_likely_touched=["SYMPHONY_REAL_E2E_RESULT.md"],
                parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="single item"),
            )
        ],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["result exists"],
            quality=["scoped"],
            integration=["tests pass"],
            documentation=["projected"],
            ship_readiness=["risks recorded"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )


def _parallel_plan() -> ManagedRunPlan:
    parallelization = ParallelizationPolicy(
        safe_to_parallelize=True,
        parallel_group="g1",
        reason="independent files with shared contract",
        shared_contracts=["managed-run-result-contract"],
    )
    first = WorkItem.from_dict(
        {
            **_plan().work_items[0].to_dict(),
            "parallelization": parallelization.to_dict(),
        }
    )
    second = WorkItem.from_dict(
        {
            **first.to_dict(),
            "id": "wi-2",
            "title": "Implement second result",
            "files_likely_touched": ["SECOND_RESULT.md"],
        }
    )
    return ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [first.to_dict(), second.to_dict()]})


def _dependent_join_plan() -> ManagedRunPlan:
    base = _parallel_plan()
    downstream = WorkItem.from_dict(
        {
            **_plan().work_items[0].to_dict(),
            "id": "wi-3",
            "title": "Implement joined result",
            "dependencies": ["wi-1", "wi-2"],
            "files_likely_touched": ["JOINED_RESULT.md"],
            "parallelization": {"safe_to_parallelize": False, "reason": "joins verified upstream output"},
        }
    )
    return ManagedRunPlan.from_dict({**base.to_dict(), "work_items": [*base.to_dict()["work_items"], downstream.to_dict()]})


def _work_item_result(work_item_id: str = "wi-1", path: str = "SYMPHONY_REAL_E2E_RESULT.md") -> WorkItemResult:
    green_command = "python -c \"print('managed-run verification ok')\""
    return WorkItemResult(
        work_item_id=work_item_id,
        status_claimed=WorkItemResultStatus.READY_FOR_REVIEW,
        changed_files=[
            ChangedFile(
                path=path,
                action="created",
                planned=True,
                reason="acceptance artifact",
                handling="kept",
                verification=[green_command],
            )
        ],
        undeclared_files=[],
        tests={
            "red_command": green_command,
            "red_observed": True,
            "green_commands_run": [green_command],
            "secret_scan_passed": True,
        },
        acceptance_results=[{"criterion": "result exists", "status": "passed"}],
        blocked_reason=None,
        plan_revision=None,
        notes="ready",
    )


@pytest.mark.asyncio
async def test_managed_run_driver_runs_plan_work_item_and_verify(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    started = await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    plan_request = json.loads(Path(plan_attempt["request_path"]).read_text(encoding="utf-8"))
    plan_workspace = Path(plan_request["workspace_path"])
    assert plan_workspace != Path(instance.resolved_repo_path)
    assert plan_workspace.is_relative_to(Path(instance.instance_dir) / "state")
    assert _git(plan_workspace, "branch", "--show-current").stdout.strip().startswith("managed-run/")
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _plan().to_dict()})
    applied_plan = await driver.drive_once()
    started_work = await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    work_request = json.loads(Path(work_attempt["request_path"]).read_text(encoding="utf-8"))
    work_workspace = Path(work_request["workspace_path"])
    assert work_workspace != Path(instance.resolved_repo_path)
    assert work_workspace.is_relative_to(Path(instance.instance_dir) / "state")
    assert _git(work_workspace, "branch", "--show-current").stdout.strip().startswith("managed-run/")
    result = _work_item_result()
    _materialize_result_files(work_workspace, result)
    _write_result(work_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": result.to_dict()})
    applied_work = await driver.drive_once()
    verified = await driver.drive_once()

    run = store.get_run(accepted.run_id)
    item = store.list_work_items(accepted.run_id)[0]
    assert started == {"started": 1, "applied": 0, "failed": 0}
    assert applied_plan["applied"] == 1
    assert started_work["started"] == 1
    assert applied_work["applied"] == 1
    assert verified["applied"] == 1
    assert run["state"] == ManagedRunState.VERIFIED.value
    assert item["state"] == WorkItemState.DONE.value
    assert [call["mode"] for call in runtime_manager.starts] == ["plan", "execute"]
    view = store.managed_run_view()["runs"][0]
    assert view["verification_inputs"][0]["execute_attempt_id"] == work_attempt["attempt_id"]
    assert view["verification_inputs"][0]["gate_snapshot_hash"] == view["gate_snapshots"][0]["content_hash"]
    assert view["gate_snapshots"][0]["creator_attempt_id"] == plan_attempt["attempt_id"]
    assert view["manifests"][0]["work_item_id"] == "wi-1"
    execute_attempt = next(attempt for attempt in view["attempts"] if attempt["kind"] == "work_item")
    verify_attempt = next(attempt for attempt in view["attempts"] if attempt["kind"] == "verify")
    assert execute_attempt["gate_snapshot_hash"] == view["gate_snapshots"][0]["content_hash"]
    assert verify_attempt["work_item_id"] == "wi-1"
    assert verify_attempt["state"] == "succeeded"
    assert verify_attempt["gate_snapshot_hash"] == view["gate_snapshots"][0]["content_hash"]
    assert verify_attempt["verify_score"] == 3
    assert view["manifests"][0]["verify_attempt_id"] == verify_attempt["attempt_id"]
    assert view["manifests"][0]["score"] == 3
    assert not (Path(instance.resolved_repo_path) / "SYMPHONY_REAL_E2E_RESULT.md").exists()
    handoff = view["execution_handoffs"][0]
    assert handoff["commit_sha"] == _git(work_workspace, "rev-parse", "HEAD").stdout.strip()
    assert view["verification_inputs"][0]["commit_sha"] == handoff["commit_sha"]
    assert view["manifests"][0]["commit_sha"] == handoff["commit_sha"]
    assert view["manifests"][0]["artifacts"] == handoff["artifact_hashes"]


@pytest.mark.asyncio
async def test_managed_run_driver_rejects_result_for_a_different_work_item(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _plan().to_dict()})
    await driver.drive_once()
    await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    mismatched = _work_item_result(work_item_id="wi-not-started")
    _write_result(work_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": mismatched.to_dict()})

    failed = await driver.drive_once()

    run = store.get_run(accepted.run_id) or {}
    completed = run["payload"]["completed_attempts"]
    assert failed["failed"] == 1
    assert run["state"] == ManagedRunState.FAILED.value
    assert run["latest_reason"] == "work_item_result_id_mismatch:expected=wi-1:actual=wi-not-started"
    assert completed[-1]["attempt_id"] == work_attempt["attempt_id"]
    assert completed[-1]["sanitized_error"] == run["latest_reason"]


@pytest.mark.asyncio
async def test_managed_run_driver_blocks_when_execute_attempt_gate_hash_is_missing(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _plan().to_dict()})
    await driver.drive_once()
    await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    result = _work_item_result()
    _materialize_result_files(Path(work_attempt["workspace_path"]), result)
    _write_result(work_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": result.to_dict()})
    await driver.drive_once()
    run = store.get_run(accepted.run_id) or {}
    attempts = [
        {**attempt, "gate_snapshot_hash": ""} if attempt["attempt_id"] == work_attempt["attempt_id"] else attempt
        for attempt in run["payload"]["completed_attempts"]
    ]
    store.merge_run_payload(accepted.run_id, {"completed_attempts": attempts})

    verified = await driver.drive_once()

    final = store.get_run(accepted.run_id) or {}
    item = store.list_work_items(accepted.run_id)[0]
    assert verified["failed"] == 1
    assert final["state"] == ManagedRunState.BLOCKED.value
    assert item["state"] == WorkItemState.BLOCKED.value
    assert item["gate_status"] == "gate_snapshot_missing:execute_attempt_gate_hash_missing"


@pytest.mark.asyncio
async def test_managed_run_driver_waits_for_plan_approval_before_work_item_turn(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    approval_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "approval_required": True})
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": approval_plan.to_dict()})
    applied_plan = await driver.drive_once()
    blocked_until_approval = await driver.drive_once()

    run = store.get_run(accepted.run_id)
    assert applied_plan["applied"] == 1
    assert blocked_until_approval == {"started": 0, "applied": 0, "failed": 0}
    assert run["state"] == ManagedRunState.AWAITING_APPROVAL.value
    assert [call["mode"] for call in runtime_manager.starts] == ["plan"]

    coordinator.approve_plan(accepted.run_id, approval_id="approval-1")
    started_work = await driver.drive_once()

    assert started_work["started"] == 1
    assert [call["mode"] for call in runtime_manager.starts] == ["plan", "execute"]


@pytest.mark.asyncio
async def test_managed_run_driver_applies_approved_plan_revision_from_isolated_plan_turn(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(
        accepted.run_id,
        WorkItemResult.from_dict(
            {
                **_work_item_result().to_dict(),
                "status_claimed": WorkItemResultStatus.PLAN_REVISION_REQUESTED.value,
                "plan_revision": {"reason": "add revised scope", "files_likely_touched": ["REVISED_RESULT.md"]},
            }
        ),
    )
    coordinator.approve_plan_revision_request(accepted.run_id, "wi-1", approval_id="linear-state-flip-1")
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    started = await driver.drive_once()
    revision_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    request = json.loads(Path(revision_attempt["request_path"]).read_text(encoding="utf-8"))
    revised_item = WorkItem.from_dict(
        {
            **_plan().work_items[0].to_dict(),
            "files_likely_touched": ["SYMPHONY_REAL_E2E_RESULT.md", "REVISED_RESULT.md"],
        }
    )
    revised_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [revised_item.to_dict()]})
    _write_result(revision_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-2", "plan": revised_plan.to_dict()})

    applied = await driver.drive_once()
    run = store.get_run(accepted.run_id) or {}
    item = store.list_work_items(accepted.run_id)[0]
    completed = run["payload"]["completed_attempts"][-1]

    assert started["started"] == 1
    assert request["turn_kind"] == "plan"
    assert request["plan_mode"] == "revision"
    assert request["plan_revision"]["work_item_id"] == "wi-1"
    assert "Managed Run Revision Request" in request["issue_description"]
    assert applied["applied"] == 1
    assert run["state"] == ManagedRunState.READY.value
    assert run["plan_version"] == 2
    assert item["state"] == WorkItemState.TODO.value
    assert item["gate_status"] == "plan_revision_approved:linear-state-flip-1"
    assert run["payload"]["approved_plan_revision"] == {}
    assert completed["mode"] == "plan_revision"
    assert completed["work_item_id"] == "wi-1"
    assert store.list_gate_snapshots(accepted.run_id)[0]["creator_attempt_id"] == revision_attempt["attempt_id"]


@pytest.mark.asyncio
async def test_managed_run_driver_blocks_invalid_revision_plan_and_allows_another_approved_revision_turn(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    coordinator.apply_plan(accepted.run_id, _plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    coordinator.submit_work_item_result(
        accepted.run_id,
        WorkItemResult.from_dict(
            {
                **_work_item_result().to_dict(),
                "status_claimed": WorkItemResultStatus.PLAN_REVISION_REQUESTED.value,
                "plan_revision": {"reason": "add revised scope", "files_likely_touched": ["REVISED_RESULT.md"]},
            }
        ),
    )
    coordinator.approve_plan_revision_request(accepted.run_id, "wi-1", approval_id="approval-1")
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    revision_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    invalid_item = WorkItem.from_dict({**_plan().work_items[0].to_dict(), "estimated_scope": "L"})
    invalid_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [invalid_item.to_dict()]})
    _write_result(revision_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-2", "plan": invalid_plan.to_dict()})

    blocked = await driver.drive_once()
    blocked_run = store.get_run(accepted.run_id) or {}
    blocked_item = store.list_work_items(accepted.run_id)[0]
    coordinator.approve_plan_revision_request(accepted.run_id, "wi-1", approval_id="approval-2")
    retried = store.get_run(accepted.run_id) or {}

    assert blocked["failed"] == 1
    assert blocked_run["state"] == ManagedRunState.BLOCKED.value
    assert blocked_run["plan_version"] == 1
    assert blocked_item["gate_status"].startswith("plan_revision_invalid:work_item_too_large")
    assert blocked_run["payload"]["approved_plan_revision"]["state"] == "invalid"
    assert retried["state"] == ManagedRunState.PLANNING.value
    assert retried["plan_version"] == 1
    assert retried["payload"]["approved_plan_revision"]["approval_id"] == "approval-2"


@pytest.mark.asyncio
async def test_managed_run_driver_records_sanitized_backend_events_in_attempt_view(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(
        plan_attempt["result_path"],
        {
            "turn_kind": "plan",
            "thread_id": "thread-1",
            "plan": _plan().to_dict(),
            "events": [
                {
                    "event": "turn_completed",
                    "thread_id": "thread-1",
                    "message": "created plan with Bearer sk-secret-value",
                    "authorization": "Bearer runtime-token",
                }
            ],
        },
    )
    await driver.drive_once()
    await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(
        work_attempt["result_path"],
        {
            "turn_kind": "work_item",
            "thread_id": "thread-1",
            "result": _work_item_result().to_dict(),
            "events": [{"event": "command_result", "message": "access_token=linear-secret"}],
        },
    )
    await driver.drive_once()

    view = store.managed_run_view()
    attempts = view["attempts"]
    assert [attempt["events"][0]["event"] for attempt in attempts] == ["turn_completed", "command_result"]
    assert attempts[0]["events"][0]["message"] == "created plan with <redacted>"
    assert attempts[0]["events"][0]["authorization"] == "<redacted>"
    rendered = json.dumps(view, sort_keys=True)
    assert "sk-secret-value" not in rendered
    assert "runtime-token" not in rendered
    assert "linear-secret" not in rendered


@pytest.mark.asyncio
async def test_managed_run_driver_starts_and_collects_parallel_work_items(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _parallel_plan().to_dict()})
    await driver.drive_once()
    started_work = await driver.drive_once()
    active_attempts = store.get_run(accepted.run_id)["payload"]["active_attempts"]
    first_attempt, second_attempt = active_attempts
    first_path = "SYMPHONY_REAL_E2E_RESULT.md" if first_attempt["work_item_id"] == "wi-1" else "SECOND_RESULT.md"
    first_result = _work_item_result(str(first_attempt["work_item_id"]), first_path)
    _materialize_result_files(Path(first_attempt["workspace_path"]), first_result)
    _write_result(first_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": first_result.to_dict()})
    applied_first = await driver.drive_once()
    still_waiting = await driver.drive_once()
    second_path = "SYMPHONY_REAL_E2E_RESULT.md" if second_attempt["work_item_id"] == "wi-1" else "SECOND_RESULT.md"
    second_result = _work_item_result(str(second_attempt["work_item_id"]), second_path)
    _materialize_result_files(Path(second_attempt["workspace_path"]), second_result)
    _write_result(second_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": second_result.to_dict()})
    applied_second = await driver.drive_once()
    verified_second = await driver.drive_once()

    items = {item["work_item_id"]: item for item in store.list_work_items(accepted.run_id)}
    view_attempts = store.managed_run_view()["attempts"]
    assert started_work["started"] == 2
    assert len(active_attempts) == 2
    assert applied_first["applied"] == 1
    assert still_waiting == {"started": 0, "applied": 0, "failed": 0}
    assert applied_second["applied"] == 1
    assert verified_second["applied"] == 2
    assert {item["state"] for item in items.values()} == {WorkItemState.DONE.value}
    assert [attempt["mode"] for attempt in view_attempts] == ["plan", "execute", "execute", "verify", "verify"]
    assert all(attempt.get("started_at") and attempt.get("completed_at") for attempt in view_attempts)
    assert [call["mode"] for call in runtime_manager.starts] == ["plan", "execute", "execute"]


@pytest.mark.asyncio
async def test_managed_run_driver_cancels_parallel_attempts_after_terminal_peer_block(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _parallel_plan().to_dict()})
    await driver.drive_once()
    await driver.drive_once()
    first_attempt, second_attempt = store.get_run(accepted.run_id)["payload"]["active_attempts"]
    blocked_result = WorkItemResult.from_dict(
        {
            **_work_item_result(str(first_attempt["work_item_id"])).to_dict(),
            "status_claimed": WorkItemResultStatus.BLOCKED.value,
            "blocked_reason": "backend_requires_operator_action",
        }
    )
    _write_result(first_attempt["result_path"], {"turn_kind": "work_item", "result": blocked_result.to_dict()})

    blocked = await driver.drive_once()

    run = store.get_run(accepted.run_id) or {}
    attempts = {attempt["attempt_id"]: attempt for attempt in run["payload"]["completed_attempts"]}
    assert blocked["failed"] == 1
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert runtime_manager.stopped_attempt_ids == [[first_attempt["attempt_id"], second_attempt["attempt_id"]]]
    assert run["payload"]["active_attempts"] == []
    assert attempts[first_attempt["attempt_id"]]["state"] == "blocked"
    assert attempts[second_attempt["attempt_id"]]["state"] == "cancelled"
    assert attempts[second_attempt["attempt_id"]]["sanitized_error"] == f"peer_work_item_blocked:{first_attempt['work_item_id']}"
    items = {item["work_item_id"]: item for item in store.list_work_items(accepted.run_id)}
    assert items[second_attempt["work_item_id"]]["state"] == WorkItemState.BLOCKED.value
    assert items[second_attempt["work_item_id"]]["gate_status"] == f"peer_work_item_blocked:{first_attempt['work_item_id']}"


@pytest.mark.asyncio
async def test_managed_run_driver_blocks_when_independent_green_command_fails(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )
    failing_command = "python -c \"import sys; sys.exit(7)\""
    failing_plan = ManagedRunPlan.from_dict(
        {
            **_plan().to_dict(),
            "work_items": [
                {
                    **_plan().work_items[0].to_dict(),
                    "verification": {
                        "red_command": failing_command,
                        "green_commands": [failing_command],
                        "runtime_checks": [],
                    },
                }
            ],
        }
    )

    await driver.drive_once()
    plan_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": failing_plan.to_dict()})
    await driver.drive_once()
    await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    claimed_result = WorkItemResult.from_dict(
        {
            **_work_item_result().to_dict(),
            "tests": {
                "red_command": failing_command,
                "red_observed": True,
                "green_commands_run": [failing_command],
                "secret_scan_passed": True,
            },
        }
    )
    _materialize_result_files(Path(work_attempt["workspace_path"]), claimed_result)
    _write_result(work_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": claimed_result.to_dict()})
    await driver.drive_once()
    verified = await driver.drive_once()

    run = store.get_run(accepted.run_id)
    item = store.list_work_items(accepted.run_id)[0]
    assert verified["failed"] == 1
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert item["state"] == WorkItemState.BLOCKED.value
    assert item["gate_status"].startswith("verification_command_failed:")
    assert "exit_7" in item["gate_status"]


@pytest.mark.asyncio
async def test_managed_run_driver_starts_dependent_work_item_from_joined_verified_manifests(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    _init_repo(Path(instance.resolved_repo_path))
    _write_commit(Path(instance.resolved_repo_path), "base.txt", "base\n", "base")
    first_commit = _branch_commit(Path(instance.resolved_repo_path), "managed-run/wi-1", "a.txt", "one\n", "wi-1")
    _git(Path(instance.resolved_repo_path), "checkout", "main")
    second_commit = _branch_commit(Path(instance.resolved_repo_path), "managed-run/wi-2", "b.txt", "two\n", "wi-2")
    _git(Path(instance.resolved_repo_path), "checkout", "main")
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "issue_identifier": "HELL-1"}, instance_id=instance.id)
    coordinator.apply_plan(accepted.run_id, _dependent_join_plan(), backend_session_id="thread-1")
    _complete_with_manifest(store, accepted.run_id, "wi-1", branch_name="managed-run/wi-1", commit_sha=first_commit)
    _complete_with_manifest(store, accepted.run_id, "wi-2", branch_name="managed-run/wi-2", commit_sha=second_commit)
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    started = await driver.drive_once()

    request = json.loads(Path(runtime_manager.starts[0]["attempt_request_path"]).read_text(encoding="utf-8"))
    workspace = Path(request["workspace_path"])
    join = store.get_run(accepted.run_id)["payload"]["branch_joins"][0]
    assert started["started"] == 1
    assert request["work_item"]["id"] == "wi-3"
    assert workspace == Path(join["worktree_path"])
    assert join["status"] == "integrated"
    assert (workspace / "a.txt").read_text(encoding="utf-8") == "one\n"
    assert (workspace / "b.txt").read_text(encoding="utf-8") == "two\n"


@pytest.mark.asyncio
async def test_managed_run_driver_blocks_dependent_work_item_on_join_conflict(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    _init_repo(Path(instance.resolved_repo_path))
    _write_commit(Path(instance.resolved_repo_path), "same.txt", "base\n", "base")
    first_commit = _branch_commit(Path(instance.resolved_repo_path), "managed-run/wi-1", "same.txt", "one\n", "wi-1")
    _git(Path(instance.resolved_repo_path), "checkout", "main")
    second_commit = _branch_commit(Path(instance.resolved_repo_path), "managed-run/wi-2", "same.txt", "two\n", "wi-2")
    _git(Path(instance.resolved_repo_path), "checkout", "main")
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "issue_identifier": "HELL-1"}, instance_id=instance.id)
    coordinator.apply_plan(accepted.run_id, _dependent_join_plan(), backend_session_id="thread-1")
    _complete_with_manifest(store, accepted.run_id, "wi-1", branch_name="managed-run/wi-1", commit_sha=first_commit)
    _complete_with_manifest(store, accepted.run_id, "wi-2", branch_name="managed-run/wi-2", commit_sha=second_commit)
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup={instance.id: instance}.get,
        instance_update=lambda updated: None,
        runtime_config=_runtime_config(),
    )

    blocked = await driver.drive_once()

    run = store.get_run(accepted.run_id)
    item = next(row for row in store.list_work_items(accepted.run_id) if row["work_item_id"] == "wi-3")
    join = run["payload"]["branch_joins"][0]
    assert blocked["failed"] == 1
    assert runtime_manager.starts == []
    assert run["state"] == ManagedRunState.BLOCKED.value
    assert item["state"] == WorkItemState.BLOCKED.value
    assert item["gate_status"] == "verified_branch_join_conflict:same.txt"
    assert join["status"] == "conflicted"
    assert join["conflict_files"] == ["same.txt"]


@pytest.mark.asyncio
async def test_managed_run_driver_runs_checkpoint_in_verified_manifest_workspace(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    repo = Path(instance.resolved_repo_path)
    first_commit = _branch_commit(repo, "managed-run/wi-1", "SYMPHONY_REAL_E2E_RESULT.md", "one\n", "wi-1")
    _git(repo, "checkout", "main")
    second_commit = _branch_commit(repo, "managed-run/wi-2", "SECOND_RESULT.md", "two\n", "wi-2")
    _git(repo, "checkout", "main")
    checkpoint_command = "python -c \"from pathlib import Path; assert Path('SYMPHONY_REAL_E2E_RESULT.md').read_text() == 'one\\\\n'; assert Path('SECOND_RESULT.md').read_text() == 'two\\\\n'\""
    plan = ManagedRunPlan.from_dict(
        {
            **_parallel_plan().to_dict(),
            "checkpoints": [{"after": ["wi-1", "wi-2"], "verify": [checkpoint_command]}],
        }
    )
    accepted = coordinator.accept_dispatch({"issue_id": "issue-1", "issue_identifier": "HELL-1"}, instance_id=instance.id)
    coordinator.apply_plan(accepted.run_id, plan, backend_session_id="thread-1")
    _complete_with_manifest(store, accepted.run_id, "wi-1", branch_name="managed-run/wi-1", commit_sha=first_commit)
    _complete_with_manifest(store, accepted.run_id, "wi-2", branch_name="managed-run/wi-2", commit_sha=second_commit)
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup={instance.id: instance}.get,
        instance_update=lambda updated: None,
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()

    run = store.get_run(accepted.run_id)
    checkpoint = store.list_checkpoint_results(accepted.run_id)[0]
    checkpoint_join = next(join for join in run["payload"]["branch_joins"] if join.get("purpose") == "checkpoint")
    workspace = Path(checkpoint_join["worktree_path"])
    assert checkpoint["passed"] is True
    assert run["state"] == ManagedRunState.VERIFIED.value
    assert workspace.is_relative_to(Path(instance.instance_dir) / "state")
    assert (workspace / "SYMPHONY_REAL_E2E_RESULT.md").read_text(encoding="utf-8") == "one\n"
    assert (workspace / "SECOND_RESULT.md").read_text(encoding="utf-8") == "two\n"
    assert not (repo / "SYMPHONY_REAL_E2E_RESULT.md").exists()


@pytest.mark.asyncio
async def test_managed_run_driver_fails_plan_turn_when_process_exits_without_result(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    instances = {instance.id: instance}
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup=instances.get,
        instance_update=lambda updated: instances.__setitem__(updated.id, updated),
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    runtime_manager.exited_attempts.append(
        {
            "instance_id": instance.id,
            "attempt_id": attempt["attempt_id"],
            "mode": "plan",
            "result_path": attempt["result_path"],
            "exit_code": 1,
        }
    )
    failed = await driver.drive_once()

    run = store.get_run(accepted.run_id)
    assert failed["failed"] == 1
    assert run["state"] == ManagedRunState.FAILED.value
    assert run["latest_reason"].startswith("plan_result_missing_after_process_exit:")
    assert run["payload"]["last_failed_attempt"]["exit"]["exit_code"] == 1


@pytest.mark.asyncio
async def test_managed_run_driver_terminalizes_malformed_plan_attempt(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup={instance.id: instance}.get,
        instance_update=lambda updated: None,
        runtime_config=_runtime_config(),
    )

    await driver.drive_once()
    attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(attempt["result_path"], {"turn_kind": "plan"})
    failed = await driver.drive_once()

    run = store.get_run(accepted.run_id) or {}
    completed = run["payload"]["completed_attempts"]
    assert failed["failed"] == 1
    assert run["state"] == ManagedRunState.FAILED.value
    assert run["payload"]["active_attempt"] == {}
    assert completed[-1]["attempt_id"] == attempt["attempt_id"]
    assert completed[-1]["state"] == "failed"
    assert completed[-1]["sanitized_error"].startswith("plan_result_failed:")


@pytest.mark.asyncio
async def test_managed_run_driver_retries_invalid_plan_before_terminal_block(tmp_path: Path) -> None:
    store = ConductorManagedRunStore(tmp_path / "managed_run")
    coordinator = ConductorManagedRunCoordinator(store=store, plan_validation_retry_limit=1)
    runtime_manager = FakeRuntimeManager()
    instance = _instance(tmp_path)
    accepted = coordinator.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "description": "Create result"},
        instance_id=instance.id,
    )
    driver = ConductorManagedRunDriver(
        store=store,
        coordinator=coordinator,
        runtime_manager=runtime_manager,
        instance_lookup={instance.id: instance}.get,
        instance_update=lambda updated: None,
        runtime_config=_runtime_config(),
    )
    oversized = WorkItem.from_dict({**_plan().work_items[0].to_dict(), "estimated_scope": "L"})
    invalid_plan = ManagedRunPlan.from_dict({**_plan().to_dict(), "work_items": [oversized.to_dict()]})

    await driver.drive_once()
    first = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(first["result_path"], {"turn_kind": "plan", "plan": invalid_plan.to_dict()})
    retried = await driver.drive_once()
    after_first = store.get_run(accepted.run_id) or {}
    restarted = await driver.drive_once()
    second = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(second["result_path"], {"turn_kind": "plan", "plan": invalid_plan.to_dict()})
    blocked = await driver.drive_once()
    final = store.get_run(accepted.run_id) or {}

    assert retried["applied"] == 1
    assert after_first["state"] == ManagedRunState.PLANNING.value
    assert after_first["payload"]["completed_attempts"][-1]["retryable"] is True
    assert restarted["started"] == 1
    assert second["attempt_id"] != first["attempt_id"]
    assert blocked["failed"] == 1
    assert final["state"] == ManagedRunState.BLOCKED.value
    assert final["latest_reason"] == "plan_validation_retries_exhausted:work_item_too_large"
    assert [attempt["state"] for attempt in final["payload"]["completed_attempts"]] == ["failed", "failed"]
    assert final["payload"]["completed_attempts"][-1]["retryable"] is False


def _write_result(path: str, payload: dict[str, Any]) -> None:
    result_path = Path(path)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(payload), encoding="utf-8")


def _materialize_result_files(repo: Path, result: WorkItemResult) -> None:
    for changed in result.changed_files:
        relative = Path(changed.path)
        if relative.is_absolute() or any(part == ".." for part in relative.parts):
            raise AssertionError(f"invalid changed file path in fixture: {changed.path}")
        target = repo / relative
        if changed.action.lower() in {"deleted", "removed", "delete", "remove"}:
            if target.exists():
                target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"managed-run result for {result.work_item_id}\n", encoding="utf-8")


def _complete_with_manifest(store: ConductorManagedRunStore, run_id: str, work_item_id: str, *, branch_name: str, commit_sha: str) -> None:
    store.update_work_item_state(run_id, work_item_id, WorkItemState.DONE, gate_status="verification passed")
    store.publish_task_output_manifest(
        run_id,
        TaskOutputManifest(
            work_item_id=work_item_id,
            verify_attempt_id=f"verify-{work_item_id}",
            plan_version=1,
            score=3,
            branch_name=branch_name,
            commit_sha=commit_sha,
            artifacts=[],
            created_at="2026-07-09T00:00:00Z",
        ),
    )


def _init_repo(repo: Path) -> None:
    if (repo / ".git").exists():
        return
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")


def _branch_commit(repo: Path, branch: str, path: str, text: str, message: str) -> str:
    _git(repo, "checkout", "-B", branch)
    _write_commit(repo, path, text, message)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _write_commit(repo: Path, path: str, text: str, message: str) -> None:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    _git(repo, "add", path)
    _git(repo, "commit", "-m", message)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
