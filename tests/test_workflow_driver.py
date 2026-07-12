from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from conductor.gate import CommandResult
from conductor.store import ConductorStore
from conductor.workflow_driver import WorkflowDriver
from performer_api.turns import GateResult
from performer_api.workflow import AcceptanceCatalog, Plan


@dataclass
class FakeInstance:
    id: str
    instance_dir: str
    workspace_root: str
    log_path: str


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
        self.transition_failures = 0
        self.transition_failure_target = ""

    async def create_child_issue_for(self, **kwargs: Any) -> dict[str, str]:
        issue = {"id": f"child-{len(self.children) + 1}", "identifier": f"SYM-{len(self.children) + 1}"}
        self.children.append(issue)
        self.issue_states[issue["id"]] = "Backlog"
        return issue

    async def update_issue_description_marker_block(self, *_args: Any, **_kwargs: Any) -> dict[str, bool]:
        return {"success": True}

    async def transition_issue_by_state_target(self, issue_id: str, *, names: list[str], state_type: str) -> dict[str, Any]:
        if self.transition_failures and (not self.transition_failure_target or names[0] == self.transition_failure_target):
            self.transition_failures -= 1
            return {"success": False, "reason": "temporary_projection_failure"}
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


class FakeRuntime:
    def __init__(self) -> None:
        self.events: list[str] = []

    def append_event(self, _log_path: Path, message: str) -> None:
        self.events.append(message)


class EvidenceGate(FakeGate):
    def run_commands(self, _task: Any, _workspace: Path) -> list[CommandResult]:
        return [
            CommandResult(
                "OPENAI_API_KEY=command-secret pytest -q",
                True,
                0,
                "Authorization: Token output-secret",
            )
        ]


class RevisingGate(FakeGate):
    def __init__(self, store: ConductorStore, run_id: str, revised_plan: Plan) -> None:
        self.store = store
        self.run_id = run_id
        self.revised_plan = revised_plan
        self.revised = False

    def run_commands(self, task: Any, workspace: Path) -> list[CommandResult]:
        if not self.revised:
            self.revised = True
            self.store.save_plan(self.run_id, self.revised_plan, reason="revised during Gate")
        return super().run_commands(task, workspace)


class FakeService:
    def __init__(self, root: Path) -> None:
        instance = FakeInstance("instance-1", str(root), str(root), str(root / "performer.log"))
        self.store = FakeConductorStore(root, instance)
        self.performer_runtime = FakeRuntime()
        self.acceptance_gate = FakeGate()
        self._managed_run_runtime_config = {"version": 1}
        self.linear = FakeLinear()

    def _managed_run_tracker(self) -> FakeLinear:
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
async def test_workflow_driver_projects_only_a_gate_summary_to_linear(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    service.acceptance_gate = EvidenceGate()
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    token_shaped_catalog_id = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    plan = Plan(
        summary=minimal_plan.summary,
        tasks=minimal_plan.tasks,
        acceptance_catalog=AcceptanceCatalog(
            id=token_shaped_catalog_id,
            rubric={"correctness": {"weight": 2, "threshold": 3}},
        ),
    )
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": plan.to_dict(), "thread_id": "thread-1"},
            {"context": {}, "result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": True,
                    "score": 4,
                    "threshold": 3,
                    "rubric": {"correctness": {"score": 4, "weight": 2}},
                    "provenance": [{"source": "codex", "token": "provenance-secret"}],
                    "findings": ["token=finding-secret"],
                    "artifact_refs": ["artifact://run-1/secret-path"],
                },
                "thread_id": "thread-1",
            },
        ],
    )

    await driver.drive_once()
    await driver.drive_once()

    comment = next(body for _issue_id, body in service.linear.comments if body.startswith("Codex Gate"))
    assert "Codex Gate passed (4/3); verification commands 1/1 passed." in comment
    assert token_shaped_catalog_id not in comment
    assert "Catalog " not in comment
    assert "Rubric correctness=4 (weight 2)." in comment
    assert "Provenance codex." in comment
    assert "Manifest refs 0; artifacts 1." in comment
    for value in ("command-secret", "output-secret", "provenance-secret", "finding-secret", "secret-path"):
        assert value not in comment


@pytest.mark.anyio
async def test_workflow_driver_discards_a_stale_gate_without_failing_the_run(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    revised_plan = Plan(summary="Revised plan", tasks=minimal_plan.tasks)
    service.acceptance_gate = RevisingGate(service.store, run["run_id"], revised_plan)
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
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
        ],
    )

    await driver.drive_once()
    result = await driver.drive_once()

    assert result["failed"] == 0
    persisted_run = service.store.get_run(run["run_id"])
    persisted_task = service.store.next_task(run["run_id"])
    assert persisted_run is not None
    assert persisted_task is not None
    assert persisted_run["state"] == "executing"
    assert persisted_run["active_task_id"] == ""
    assert persisted_run["latest_reason"] == "stale_plan_version"
    assert persisted_task["state"] == "todo"
    assert persisted_task["linear_state"] == "todo"
    assert service.linear.transitions[-1] == ("child-1", "Backlog")
    assert any(
        event.startswith("event=managed_run_gate_result_stale level=warning ")
        and "run_id=" + str(run["run_id"]) in event
        and "work_item_id=task-1" in event
        and "sanitized_reason=stale_plan_version" in event
        and "next_action=re_run_current_plan_revision" in event
        for event in service.performer_runtime.events
    )
    assert any("Gate result discarded: stale_plan_version" in body for _issue_id, body in service.linear.comments)


@pytest.mark.anyio
async def test_workflow_driver_retries_a_stale_gate_todo_projection(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    revised_plan = Plan(summary="Revised plan", tasks=minimal_plan.tasks)
    service.acceptance_gate = RevisingGate(service.store, run["run_id"], revised_plan)
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
            {"context": {}, "result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": True,
                    "score": 4,
                    "threshold": 3,
                    "rubric": {},
                    "provenance": [],
                    "findings": [],
                    "artifact_refs": [],
                },
                "thread_id": "thread-1",
            },
        ],
    )

    await driver.drive_once()
    service.linear.transition_failures = 1
    service.linear.transition_failure_target = "Backlog"
    failed_projection = await driver.drive_once()

    pending = service.store.get_run(run["run_id"])
    assert pending is not None
    assert failed_projection["failed"] == 0
    assert pending["state"] == "executing"
    assert pending["latest_reason"] == "stale_gate_projection_failed"
    assert service.store.next_task(run["run_id"])["linear_state"] == "in_progress"
    assert any(
        event.startswith("event=managed_run_gate_stale_projection_failed level=error ")
        and "retryable=true" in event
        and "next_action=retry_linear_state_projection" in event
        for event in service.performer_runtime.events
    )

    retried_projection = await driver.drive_once()

    assert retried_projection["failed"] == 0
    assert service.store.next_task(run["run_id"])["linear_state"] == "todo"
    assert service.linear.transitions[-1] == ("child-1", "Backlog")


@pytest.mark.anyio
async def test_workflow_driver_logs_the_second_gate_failure(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
            {"context": {}, "result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": False,
                    "score": 2,
                    "threshold": 3,
                    "rubric": {},
                    "provenance": [],
                    "findings": [],
                    "artifact_refs": [],
                },
                "thread_id": "thread-1",
            },
            {"context": {}, "result": {"status": "ready_for_gate", "summary": "reworked"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": False,
                    "score": 2,
                    "threshold": 3,
                    "rubric": {},
                    "provenance": [],
                    "findings": [],
                    "artifact_refs": [],
                },
                "thread_id": "thread-1",
            },
        ],
    )

    await driver.drive_once()
    await driver.drive_once()
    await driver.drive_once()

    assert service.store.get_run(run["run_id"])["state"] == "blocked"
    assert any(
        event.startswith("event=managed_run_gate_failed level=error ")
        and "run_id=" + str(run["run_id"]) in event
        and "work_item_id=task-1" in event
        and "error_code=codex_gate_failed" in event
        and "action_required=true" in event
        and "retryable=false" in event
        for event in service.performer_runtime.events
    )


@pytest.mark.anyio
async def test_workflow_driver_logs_a_rejected_gate_result(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
            {"context": {}, "result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": True,
                    "score": 1_000_001,
                    "threshold": 3,
                    "rubric": {},
                    "provenance": [],
                    "findings": [],
                    "artifact_refs": [],
                },
                "thread_id": "thread-1",
            },
        ],
    )

    await driver.drive_once()
    result = await driver.drive_once()

    assert result["failed"] == 1
    assert service.store.get_run(run["run_id"])["state"] == "failed"
    assert any(
        event.startswith("event=managed_run_gate_rejected level=error ")
        and "run_id=" + str(run["run_id"]) in event
        and "work_item_id=task-1" in event
        and "error_code=invalid_gate_number" in event
        and "sanitized_reason=invalid_gate_number" in event
        for event in service.performer_runtime.events
    )


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
