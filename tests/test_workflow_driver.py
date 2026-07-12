from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from conductor.gate import CommandResult
from conductor.store import ConductorStore
from conductor.workflow_driver import WorkflowDriver
from performer_api.turns import GateResult
from performer_api.workflow import Plan


@dataclass
class FakeInstance:
    id: str
    instance_dir: str
    workspace_root: str


class FakeConductorStore(ConductorStore):
    def __init__(self, root: Path, instance: FakeInstance) -> None:
        super().__init__(root)
        self.instance = instance

    def get_instance(self, instance_id: str) -> FakeInstance | None:
        return self.instance if instance_id == self.instance.id else None


class FakeLinear:
    def __init__(self) -> None:
        self.children: list[dict[str, str]] = []
        self.transitions: list[tuple[str, str]] = []
        self.comments: list[tuple[str, str]] = []
        self.issue_states: dict[str, str] = {"parent-1": "In Progress"}

    async def create_child_issue_for(self, **kwargs: Any) -> dict[str, str]:
        issue = {"id": f"child-{len(self.children) + 1}", "identifier": f"SYM-{len(self.children) + 1}"}
        self.children.append(issue)
        self.issue_states[issue["id"]] = "Backlog"
        return issue

    async def update_issue_description_marker_block(self, *_args: Any, **_kwargs: Any) -> dict[str, bool]:
        return {"success": True}

    async def transition_issue_by_state_target(self, issue_id: str, *, names: list[str], state_type: str) -> dict[str, Any]:
        self.transitions.append((issue_id, names[0]))
        self.issue_states[issue_id] = names[0]
        return {"success": True, "state": names[0], "state_type": state_type}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, bool]:
        self.comments.append((issue_id, body))
        return {"success": True}

    async def fetch_issue(self, issue_id: str) -> dict[str, Any]:
        return {"state": self.issue_states.get(issue_id, "In Progress")}


class FakeGate:
    def run_commands(self, task: Any, workspace: Path) -> list[CommandResult]:
        return [CommandResult(task.verification_commands[0], True, 0, "ok")]

    def evaluate(
        self,
        _task: Any,
        _workspace: Path,
        codex_result: GateResult,
        *,
        command_results: list[CommandResult],
    ) -> tuple[GateResult, dict[str, Any]]:
        return codex_result, {"commands": [result.to_dict() for result in command_results]}


class FakeService:
    def __init__(self, root: Path) -> None:
        instance = FakeInstance("instance-1", str(root), str(root))
        self.store = FakeConductorStore(root, instance)
        self.performer_runtime = SimpleNamespace()
        self.acceptance_gate = FakeGate()
        self._managed_run_runtime_config = {"version": 1}
        self.linear = FakeLinear()

    def _managed_run_tracker(self, _instance: FakeInstance) -> FakeLinear:
        return self.linear


def _queue_turns(driver: WorkflowDriver, bodies: list[dict[str, Any]]) -> None:
    async def fake_run_turn(_run: dict[str, Any], _instance: Any, context: Any, _request: dict[str, Any], *, role: str) -> dict[str, Any]:
        body = dict(bodies.pop(0))
        body["context"] = context.to_dict()
        body["turn_kind"] = role
        return body

    driver._run_turn = fake_run_turn  # type: ignore[method-assign]


@pytest.mark.anyio
async def test_workflow_driver_creates_subissues_and_runs_sequential_gate(tmp_path: Path, two_task_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.update_run_payload(
        run["run_id"],
        {"issue_description": "Build the feature", "agent_app_user_id": "app-user-1"},
    )
    driver = WorkflowDriver(service)
    bodies = [
        {"context": {}, "plan": two_task_plan.to_dict(), "thread_id": "thread-1"},
        {"context": {}, "result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
        {
            "context": {},
            "gate_result": {
                "passed": True,
                "score": 4,
                "threshold": 3,
                "rubric": {},
                "provenance": [{"source": "codex"}],
                "findings": [],
                "artifact_refs": [],
            },
            "thread_id": "thread-1",
        },
    ]

    _queue_turns(driver, bodies)

    assert (await driver.drive_once())["applied"] == 1
    assert (await driver.drive_once())["applied"] == 1
    view = service.store.managed_run_view()
    tasks = view["runs"][0]["tasks"]
    assert [task["state"] for task in tasks] == ["done", "todo"]
    assert len(service.linear.children) == 2
    assert service.linear.transitions[0] == ("child-1", "In Progress")


@pytest.mark.anyio
async def test_workflow_driver_projects_runtime_wait_as_human_action_child(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    bodies = [
        {"context": {}, "runtime_wait": {"kind": "approval_requested", "reason": "Approve command"}},
        {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
    ]

    _queue_turns(driver, bodies)

    assert (await driver.drive_once())["applied"] == 0
    wait = service.store.list_runtime_waits(run["run_id"])[0]
    assert wait["linear_issue_id"] == "child-1"
    assert service.store.get_run(run["run_id"])["state"] == "blocked"

    assert (await driver.drive_once())["applied"] == 0
    assert service.store.get_run(run["run_id"])["plan_version"] == 0

    service.linear.issue_states["child-1"] = "In Progress"
    assert (await driver.drive_once())["applied"] == 1
    assert service.store.get_run(run["run_id"])["plan_version"] == 1


@pytest.mark.anyio
async def test_workflow_driver_waits_for_parent_approval_state_change(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    approval_plan = Plan(summary=minimal_plan.summary, tasks=minimal_plan.tasks, approval_required=True)
    _queue_turns(driver, [{"context": {}, "plan": approval_plan.to_dict(), "thread_id": "thread-1"}])

    assert (await driver.drive_once())["applied"] == 1
    assert service.linear.transitions == [("parent-1", "Blocked")]
    assert service.store.get_run(run["run_id"])["state"] == "awaiting_approval"

    assert (await driver.drive_once())["applied"] == 0
    assert service.store.get_run(run["run_id"])["state"] == "awaiting_approval"

    service.linear.issue_states["parent-1"] = "In Progress"
    assert (await driver.drive_once())["applied"] == 1
    assert service.store.get_run(run["run_id"])["state"] == "executing"


@pytest.mark.anyio
async def test_workflow_driver_does_not_duplicate_existing_subissues(tmp_path: Path, two_task_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.record_plan(run["run_id"], service.store.start_plan(run["run_id"])["attempt_id"], 1, two_task_plan)
    driver = WorkflowDriver(service)
    instance = service.store.get_instance("instance-1")

    await driver._project_plan(run, instance, two_task_plan)
    await driver._project_plan(run, instance, two_task_plan)

    assert len(service.linear.children) == 2


@pytest.mark.anyio
async def test_workflow_driver_repairs_missing_subissue_projection_before_execution(tmp_path: Path, two_task_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.save_plan(run["run_id"], two_task_plan)
    driver = WorkflowDriver(service)

    assert (await driver.drive_once())["applied"] == 1
    assert len(service.linear.children) == 2
    assert service.store.get_run(run["run_id"])["state"] == "executing"
