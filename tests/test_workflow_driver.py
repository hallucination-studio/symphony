from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from conductor.gate import CommandResult
from conductor.runtime import StaleRuntimeResult
from conductor.store import ConductorStore
from conductor.workflow_driver import WorkflowDriver
from performer_api.performer_control import PerformerControlError, PerformerReadinessState
from performer_api.runtime_policy import canonical_sha256
from performer_api.turns import GateResult, TurnContext
from performer_api.workflow import AcceptanceCatalog, Plan


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {"plan": "read_only", "execute": "workspace_write", "gate": "read_only"},
    "initialize_timeout_ms": 5000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}


@dataclass
class FakeInstance:
    id: str
    instance_dir: str
    workspace_root: str
    log_path: str
    linear_filters: dict[str, Any] = field(
        default_factory=lambda: {
            "performer_kind": "codex",
            "performer_binding_id": "performer-binding-1",
            "performer_binding_generation": 1,
            "execution_policy": dict(EXECUTION_POLICY),
            "execution_policy_sha256": canonical_sha256(EXECUTION_POLICY),
            "turn_policy_sha256": "b" * 64,
        }
    )


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
        self.marker_updates: list[tuple[str, str, str]] = []
        self.issue_states: dict[str, str] = {"parent-1": "In Progress"}
        self.transition_failures = 0
        self.transition_failure_target = ""

    async def create_child_issue_for(self, **kwargs: Any) -> dict[str, str]:
        issue = {
            "id": f"child-{len(self.children) + 1}",
            "identifier": f"SYM-{len(self.children) + 1}",
            "description": str(kwargs.get("description") or ""),
        }
        self.children.append(issue)
        self.issue_states[issue["id"]] = "Backlog"
        return issue

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, bool]:
        self.marker_updates.append((issue_id, marker_name, block))
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


class FakePerformerCoordinator:
    def __init__(self) -> None:
        self.turn_active = False

    @asynccontextmanager
    async def turn_exchange(self):
        assert self.turn_active is False
        self.turn_active = True
        try:
            yield
        finally:
            self.turn_active = False


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
        self.performer_coordinator = FakePerformerCoordinator()
        self.store.record_performer_readiness(
            PerformerReadinessState(
                performer_kind="codex",
                binding_generation=1,
                capability_version=1,
                execution_policy_sha256=canonical_sha256(EXECUTION_POLICY),
                status="ready",
                last_check_status="passed",
                error=None,
            )
        )
        self._managed_run_runtime_config = {"version": 1}
        self.linear = FakeLinear()

    def _managed_run_tracker(self) -> FakeLinear:
        return self.linear


def _set_readiness(
    service: FakeService,
    status: str,
    *,
    error_code: str = "performer_check_required",
) -> None:
    error = None
    last_check_status = "passed" if status == "ready" else "none"
    if status == "failed":
        last_check_status = "failed"
        error = PerformerControlError(
            error_code=error_code,
            sanitized_reason="The Performer backend requires operator action.",
            action_required=True,
            retryable=True,
            attempt_number=1,
            next_action="Run the manual Performer Check.",
        )
    service.store.record_performer_readiness(
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=1,
            capability_version=1,
            execution_policy_sha256=canonical_sha256(EXECUTION_POLICY),
            status=status,
            last_check_status=last_check_status,
            error=error,
        )
    )


def _queue_turns(driver: WorkflowDriver, bodies: list[dict[str, Any]]) -> None:
    async def fake_run_turn(_run: dict[str, Any], _instance: Any, context: Any, _request: dict[str, Any], *, role: str) -> dict[str, Any]:
        body = dict(bodies.pop(0))
        body["context"] = context.to_dict()
        if isinstance(body.get("execute_result"), dict):
            body["execute_result"] = {
                "changed_files": [],
                "acceptance_evidence": [],
                "blocked_reason": None,
                **body["execute_result"],
            }
        return body

    driver._run_turn = fake_run_turn  # type: ignore[method-assign]


@pytest.mark.anyio
async def test_workflow_driver_carries_execution_policy_in_plan_execute_and_gate_requests(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    requests: list[dict[str, Any]] = []
    bodies = [
        {"plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
        {"execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
        {
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
    ]

    async def capture_turn(
        _run: dict[str, Any],
        _instance: Any,
        context: Any,
        request: dict[str, Any],
        *,
        role: str,
    ) -> dict[str, Any]:
        requests.append(dict(request))
        body = dict(bodies.pop(0))
        body["context"] = context.to_dict()
        if isinstance(body.get("execute_result"), dict):
            body["execute_result"] = {
                "changed_files": [],
                "acceptance_evidence": [],
                "blocked_reason": None,
                **body["execute_result"],
            }
        return body

    driver._run_turn = capture_turn  # type: ignore[method-assign]

    assert (await driver.drive_once())["applied"] == 1
    assert (await driver.drive_once())["applied"] == 1

    assert [request["context"]["turn_kind"] for request in requests] == ["plan", "execute", "gate"]
    assert all(request["execution_policy"] == EXECUTION_POLICY for request in requests)
    assert all(request["performer_kind"] == "codex" for request in requests)
    assert all(request["performer_binding_id"] == "performer-binding-1" for request in requests)
    assert all(request["binding_generation"] == 1 for request in requests)
    assert all(request["execution_policy_sha256"] == canonical_sha256(EXECUTION_POLICY) for request in requests)
    assert all(request["turn_policy_sha256"] == "b" * 64 for request in requests)


@pytest.mark.anyio
async def test_workflow_driver_holds_performer_turn_exclusion_for_complete_call(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    instance = service.store.instance
    run = service.store.create_run("parent-1", "SYM-1", instance_id=instance.id)
    context = TurnContext(str(run["run_id"]), "", "attempt-1", 1, "plan")

    class LockAssertingRuntime(FakeRuntime):
        def paths(self, root: Path) -> Any:
            root.mkdir(parents=True, exist_ok=True)
            return SimpleNamespace(
                request=root / "turn-request.json",
                result=root / "turn-result.json",
                log=root / "performer.log",
            )

        def write_request(self, paths: Any, payload: dict[str, Any]) -> None:
            self.request = dict(payload)
            paths.request.write_text("{}", encoding="utf-8")

        async def run_async(self, _paths: Any) -> dict[str, Any]:
            assert service.performer_coordinator.turn_active is True
            return {
                "protocol_version": 1,
                "context": context.to_dict(),
                "thread_id": "",
                    "plan": minimal_plan.to_dict(),
                "execute_result": None,
                "gate_result": None,
                "runtime_wait": None,
                "events": [],
            }

        @staticmethod
        def accept_result(_expected: TurnContext, payload: dict[str, Any]) -> dict[str, Any]:
            return payload

    service.performer_runtime = LockAssertingRuntime()
    driver = WorkflowDriver(service)

    result = await driver._run_turn(
        run,
        instance,
        context,
        {
            "protocol_version": 1,
            "context": context.to_dict(),
            "performer_kind": "codex",
            "performer_binding_id": "performer-binding-1",
            "binding_generation": 1,
            "execution_policy": EXECUTION_POLICY,
            "execution_policy_sha256": canonical_sha256(EXECUTION_POLICY),
            "turn_policy_sha256": "b" * 64,
            "workspace_path": instance.workspace_root,
            "thread_id": "",
            "issue_description": "test",
            "task": None,
            "evidence": None,
        },
        role="plan",
    )

    assert result["context"]["turn_kind"] == "plan"
    assert service.performer_coordinator.turn_active is False


@pytest.mark.anyio
async def test_planning_blocks_before_attempt_and_compatible_ready_state_resumes_once(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    _set_readiness(service, "failed")
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)

    async def unexpected_turn(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("a non-ready Performer must not start a turn")

    driver._run_turn = unexpected_turn  # type: ignore[method-assign]

    blocked = await driver.drive_once()

    assert blocked["failed"] == 0
    persisted = service.store.get_run(run["run_id"])
    assert persisted["state"] == "blocked"
    assert persisted["latest_reason"] == "performer_check_required"
    with service.store.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()[0] == 0
    assert any(event.startswith("event=managed_run_performer_blocked ") for event in service.performer_runtime.events)
    assert any(
        marker_name == "SYMPHONY_PERFORMER_READINESS"
        and "performer_check_required" in block
        for _issue_id, marker_name, block in service.linear.marker_updates
    )
    assert service.linear.comments == []

    _set_readiness(service, "ready")
    _queue_turns(driver, [{"plan": minimal_plan.to_dict(), "thread_id": "thread-1"}])

    resumed = await driver.drive_once()

    assert resumed["failed"] == 0
    with service.store.connect() as connection:
        rows = connection.execute(
            "SELECT kind, fencing_token FROM attempts WHERE run_id = ?",
            (run["run_id"],),
        ).fetchall()
    assert [(row["kind"], row["fencing_token"]) for row in rows] == [("plan", 1)]
    assert any(event.startswith("event=managed_run_performer_resumed ") for event in service.performer_runtime.events)


@pytest.mark.anyio
async def test_readiness_linear_projection_retries_durably_before_resuming_or_starting_turn(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    _set_readiness(service, "failed")
    service.linear.transition_failures = 2
    service.linear.transition_failure_target = "Blocked"
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)

    def attempts() -> list[tuple[str, int]]:
        with service.store.connect() as connection:
            rows = connection.execute(
                "SELECT kind, fencing_token FROM attempts WHERE run_id = ? ORDER BY created_at",
                (run["run_id"],),
            ).fetchall()
        return [(str(row["kind"]), int(row["fencing_token"])) for row in rows]

    first = await driver.drive_once()

    first_block = service.store.get_run(run["run_id"])["payload"]["performer_readiness_block"]
    assert first["failed"] == 0
    assert first_block["linear_projection"]["status"] == "pending"
    assert first_block["linear_projection"]["attempt_number"] == 1
    assert first_block["linear_projection"]["last_error_code"] == "performer_readiness_projection_failed"
    assert "temporary_projection_failure" in first_block["linear_projection"]["last_sanitized_reason"]
    assert first_block["linear_projection"]["next_action"] == "retry_linear_projection"
    assert attempts() == []
    assert service.linear.transitions == []
    assert [
        update
        for update in service.linear.marker_updates
        if update[1] == "SYMPHONY_PERFORMER_READINESS"
    ] == []

    second = await driver.drive_once()

    second_block = service.store.get_run(run["run_id"])["payload"]["performer_readiness_block"]
    assert second["failed"] == 0
    assert second_block["linear_projection"]["status"] == "pending"
    assert second_block["linear_projection"]["attempt_number"] == 2
    assert second_block["linear_projection"]["last_error_code"] == "performer_readiness_projection_failed"
    assert "temporary_projection_failure" in second_block["linear_projection"]["last_sanitized_reason"]
    assert second_block["linear_projection"]["next_action"] == "retry_linear_projection"
    assert attempts() == []
    failure_logs = [
        event
        for event in service.performer_runtime.events
        if "error_code=performer_readiness_projection_failed" in event
    ]
    assert len(failure_logs) == 2
    assert "attempt_number=1" in failure_logs[0]
    assert "attempt_number=2" in failure_logs[1]

    third = await driver.drive_once()

    third_block = service.store.get_run(run["run_id"])["payload"]["performer_readiness_block"]
    readiness_updates = [
        update
        for update in service.linear.marker_updates
        if update[1] == "SYMPHONY_PERFORMER_READINESS"
    ]
    assert third["failed"] == 0
    assert third_block["linear_projection"]["status"] == "complete"
    assert third_block["linear_projection"]["attempt_number"] == 3
    assert attempts() == []
    assert service.linear.transitions == [("parent-1", "Blocked")]
    assert len(readiness_updates) == 1
    assert "performer_check_required" in readiness_updates[0][2]

    fourth = await driver.drive_once()

    assert fourth["failed"] == 0
    assert attempts() == []
    assert service.linear.transitions == [("parent-1", "Blocked")]
    assert len([
        update
        for update in service.linear.marker_updates
        if update[1] == "SYMPHONY_PERFORMER_READINESS"
    ]) == 1

    _set_readiness(service, "ready")
    _queue_turns(driver, [{"plan": minimal_plan.to_dict(), "thread_id": "thread-1"}])

    resumed = await driver.drive_once()

    assert resumed["failed"] == 0
    assert attempts() == [("plan", 1)]
    assert "performer_readiness_block" not in service.store.get_run(run["run_id"])["payload"]
    resumed_updates = [
        update
        for update in service.linear.marker_updates
        if update[1] == "SYMPHONY_PERFORMER_READINESS"
    ]
    assert len(resumed_updates) == 2
    assert "Status: resumed" in resumed_updates[-1][2]
    assert service.linear.comments == []


@pytest.mark.anyio
async def test_turn_reservation_rechecks_readiness_before_creating_plan_attempt(
    tmp_path: Path,
) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")

    class CheckStartsBeforeTurn:
        @asynccontextmanager
        async def turn_exchange(self):
            _set_readiness(service, "checking")
            yield

    service.performer_coordinator = CheckStartsBeforeTurn()
    driver = WorkflowDriver(service)

    result = await driver.drive_once()

    assert result["failed"] == 0
    assert service.store.get_run(run["run_id"])["state"] == "blocked"
    with service.store.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()[0] == 0


@pytest.mark.anyio
async def test_execution_blocks_before_task_attempt_when_readiness_is_not_ready(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.save_plan(run["run_id"], minimal_plan)
    driver = WorkflowDriver(service)
    assert (await driver.drive_once())["applied"] == 1
    _set_readiness(service, "failed")

    result = await driver.drive_once()

    assert result["failed"] == 0
    task = service.store.get_task(run["run_id"], "task-1")
    assert task["state"] == "blocked"
    with service.store.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE run_id = ? AND task_id = 'task-1'",
            (run["run_id"],),
        ).fetchone()[0] == 0


@pytest.mark.anyio
async def test_gate_blocks_before_gate_attempt_if_readiness_changes_after_execute(
    tmp_path: Path,
    minimal_plan,
) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.save_plan(run["run_id"], minimal_plan)
    driver = WorkflowDriver(service)
    assert (await driver.drive_once())["applied"] == 1

    async def execute_then_invalidate(
        _run: dict[str, Any],
        _instance: Any,
        context: TurnContext,
        _request: dict[str, Any],
        *,
        role: str,
    ) -> dict[str, Any]:
        assert role == "execute"
        _set_readiness(service, "failed")
        return {
            "context": context.to_dict(),
            "thread_id": "thread-1",
            "execute_result": {
                "status": "ready_for_gate",
                "summary": "implemented",
                "changed_files": [],
                "acceptance_evidence": [],
                "blocked_reason": None,
            },
        }

    driver._run_turn = execute_then_invalidate  # type: ignore[method-assign]

    result = await driver.drive_once()

    assert result["failed"] == 0
    task = service.store.get_task(run["run_id"], "task-1")
    assert task["state"] == "blocked"
    assert task["result"]["summary"] == "implemented"
    with service.store.connect() as connection:
        kinds = [
            row["kind"]
            for row in connection.execute(
                "SELECT kind FROM attempts WHERE run_id = ? AND task_id = 'task-1' ORDER BY created_at",
                (run["run_id"],),
            ).fetchall()
        ]
    assert kinds == ["execute"]


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
        {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
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
async def test_workflow_driver_closes_parent_after_every_subissue_passes(tmp_path: Path, two_task_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    driver = WorkflowDriver(service)
    _queue_turns(
        driver,
        [
            {"context": {}, "plan": two_task_plan.to_dict(), "thread_id": "thread-1"},
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "task one"}, "thread_id": "thread-1"},
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "task two"}, "thread_id": "thread-1"},
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

    for _ in range(5):
        assert (await driver.drive_once())["failed"] == 0

    persisted = service.store.get_run(run["run_id"])
    assert persisted is not None
    assert persisted["state"] == "done"
    assert [task["state"] for task in service.store.list_tasks(run["run_id"])] == ["done", "done"]
    assert service.linear.transitions == [
        ("child-1", "In Progress"),
        ("child-1", "Done"),
        ("child-2", "In Progress"),
        ("child-2", "Done"),
        ("parent-1", "Done"),
    ]


@pytest.mark.anyio
async def test_workflow_driver_ignores_stale_result_without_failing_run(tmp_path: Path, minimal_plan) -> None:
    service = FakeService(tmp_path)
    run = service.store.create_run("parent-1", "SYM-1", instance_id="instance-1")
    service.store.save_plan(run["run_id"], minimal_plan)
    driver = WorkflowDriver(service)

    async def stale_turn(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise StaleRuntimeResult("stale_fencing_token")

    driver._run_turn = stale_turn  # type: ignore[method-assign]

    assert (await driver.drive_once())["failed"] == 0
    result = await driver.drive_once()

    assert result["failed"] == 0
    persisted = service.store.get_run(run["run_id"])
    assert persisted is not None
    assert persisted["state"] == "executing"
    assert persisted["latest_reason"] == "stale_fencing_token"
    assert any(
        event.startswith("event=managed_run_result_stale level=warning ")
        and "run_id=" + str(run["run_id"]) in event
        and "error_code=stale_fencing_token" in event
        and "next_action=ignore_stale_result" in event
        for event in service.performer_runtime.events
    )


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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
            {
                "context": {},
                "gate_result": {
                    "passed": True,
                    "score": 4,
                        "threshold": 3,
                        "rubric": {"correctness": {"score": 4, "weight": 2}},
                        "provenance": [{"source": "codex"}],
                        "findings": ["Verification passed."],
                        "artifact_refs": ["artifact://run-1/evidence"],
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "reworked"}, "thread_id": "thread-1"},
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
            {"context": {}, "execute_result": {"status": "ready_for_gate", "summary": "implemented"}, "thread_id": "thread-1"},
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
        {
            "context": {},
            "runtime_wait": {
                "kind": "approval_requested",
                "reason": "Authorization: Bearer wait-secret",
            },
        },
        {"context": {}, "plan": minimal_plan.to_dict(), "thread_id": "thread-1"},
    ]

    _queue_turns(driver, bodies)

    assert (await driver.drive_once())["applied"] == 0
    wait = service.store.list_runtime_waits(run["run_id"])[0]
    assert wait["linear_issue_id"] == "child-1"
    assert "wait-secret" not in str(wait)
    assert "wait-secret" not in str(service.linear.children)
    assert "wait-secret" not in str(service.linear.comments)
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
