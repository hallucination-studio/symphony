from __future__ import annotations

import json
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

    def refresh(self, instance: InstanceRecord) -> InstanceRecord:
        return instance

    def drain_exited_attempts(self, instance: InstanceRecord) -> list[dict[str, object]]:
        drained = [snapshot for snapshot in self.exited_attempts if snapshot.get("instance_id") == instance.id]
        self.exited_attempts = [snapshot for snapshot in self.exited_attempts if snapshot.get("instance_id") != instance.id]
        return drained

    async def start(self, instance: InstanceRecord, **kwargs: Any) -> InstanceRecord:
        self.starts.append(kwargs)
        return instance.with_updates(process_status="running", pid=1234)


def _instance(tmp_path: Path) -> InstanceRecord:
    repo = tmp_path / "repo"
    repo.mkdir()
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
    _write_result(plan_attempt["result_path"], {"turn_kind": "plan", "thread_id": "thread-1", "plan": _plan().to_dict()})
    applied_plan = await driver.drive_once()
    started_work = await driver.drive_once()
    work_attempt = store.get_run(accepted.run_id)["payload"]["active_attempt"]
    _write_result(work_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": _work_item_result().to_dict()})
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
    _write_result(first_attempt["result_path"], {"turn_kind": "work_item", "thread_id": "thread-1", "result": first_result.to_dict()})
    applied_first = await driver.drive_once()
    still_waiting = await driver.drive_once()
    second_path = "SYMPHONY_REAL_E2E_RESULT.md" if second_attempt["work_item_id"] == "wi-1" else "SECOND_RESULT.md"
    second_result = _work_item_result(str(second_attempt["work_item_id"]), second_path)
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
    assert [attempt["mode"] for attempt in view_attempts] == ["plan", "execute", "execute"]
    assert all(attempt.get("started_at") and attempt.get("completed_at") for attempt in view_attempts)
    assert [call["mode"] for call in runtime_manager.starts] == ["plan", "execute", "execute"]


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


def _write_result(path: str, payload: dict[str, Any]) -> None:
    result_path = Path(path)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(payload), encoding="utf-8")
