from __future__ import annotations

import ast
import subprocess
from pathlib import Path

import pytest

from performer.managed_run_backend import CodexManagedRunBackend, MANAGED_RUN_PLAN_SCHEMA, WORK_ITEM_RESULT_SCHEMA, ManagedRunBackendError, execute_work_item_prompt
from performer_api.managed_runs import (
    ManagedRunPlan,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemResultStatus,
    WorkItemSliceType,
    WorkItemVerification,
)


class FakeCodexClient:
    def __init__(self, structured_result: dict | list[dict], *, write_file: str | None = None) -> None:
        self.structured_results = structured_result if isinstance(structured_result, list) else [structured_result]
        self.write_file = write_file
        self.calls: list[dict] = []

    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs):
        self.calls.append({"workspace_path": workspace_path, "prompt": prompt, "title": title, **kwargs})
        if self.write_file is not None:
            (workspace_path / self.write_file).write_text("planner changed files\n", encoding="utf-8")
        return type(
            "Result",
            (),
            {
                "thread_id": "thread-1",
                "structured_result": self.structured_results[min(len(self.calls) - 1, len(self.structured_results) - 1)],
                "events": [{"event": "turn_completed"}],
            },
        )()


def _plan_payload() -> dict:
    return ManagedRunPlan(
        summary="ManagedRun plan",
        architecture_decisions=["Use work items"],
        work_items=[_work_item()],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["ok"],
            quality=["scoped"],
            integration=["tested"],
            documentation=["projected"],
            ship_readiness=["risks"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    ).to_dict()


def _work_item() -> WorkItem:
    return WorkItem(
        id="wi-1",
        title="Add backend",
        objective="Run one managed_run turn",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=["result parsed"],
        verification=WorkItemVerification(red_command="pytest tests/test_performer_managed_run_backend.py -q", green_commands=["pytest tests/test_performer_managed_run_backend.py -q"]),
        dependencies=[],
        estimated_scope="S",
        files_likely_touched=["packages/performer/src/performer/managed_run_backend.py"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="single turn"),
    )


@pytest.mark.asyncio
async def test_codex_managed_run_backend_plan_turn_validates_plan(tmp_path) -> None:
    client = FakeCodexClient(_plan_payload())
    backend = CodexManagedRunBackend(client)

    result = await backend.plan_turn(tmp_path, "Build the managed_run")

    assert result.plan.work_items[0].id == "wi-1"
    assert result.thread_id == "thread-1"
    assert client.calls[0]["output_schema"]["required"] == ["summary", "architecture_decisions", "work_items", "checkpoints", "verification_rubric", "risks", "open_questions", "approval_required"]


@pytest.mark.asyncio
async def test_codex_managed_run_backend_rejects_invalid_plan(tmp_path) -> None:
    client = FakeCodexClient({**_plan_payload(), "work_items": [{**_work_item().to_dict(), "estimated_scope": "L"}]})
    backend = CodexManagedRunBackend(client)

    with pytest.raises(ManagedRunBackendError, match="work_item_too_large"):
        await backend.plan_turn(tmp_path, "Build the managed_run")


@pytest.mark.asyncio
async def test_codex_managed_run_backend_repairs_invalid_plan_before_returning(tmp_path) -> None:
    bad = {**_plan_payload(), "work_items": [{**_work_item().to_dict(), "estimated_scope": "L"}]}
    client = FakeCodexClient([bad, _plan_payload()])
    backend = CodexManagedRunBackend(client)

    result = await backend.plan_turn(tmp_path, "Build the managed_run")

    assert result.plan.work_items[0].estimated_scope == "S"
    assert len(client.calls) == 2
    assert client.calls[1]["existing_thread_id"] == "thread-1"
    assert "work_item_too_large" in client.calls[1]["prompt"]


@pytest.mark.asyncio
async def test_codex_managed_run_backend_rejects_plan_turn_file_changes(tmp_path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    client = FakeCodexClient(_plan_payload(), write_file="planner-output.txt")
    backend = CodexManagedRunBackend(client)

    with pytest.raises(ManagedRunBackendError, match="plan_turn_changed_files:planner-output.txt"):
        await backend.plan_turn(tmp_path, "Build the managed_run")


@pytest.mark.asyncio
async def test_codex_managed_run_backend_execute_turn_parses_work_item_result(tmp_path) -> None:
    client = FakeCodexClient(
        {
            "work_item_id": "wi-1",
            "status_claimed": "ready_for_review",
            "changed_files": [
                {
                    "path": "packages/performer/src/performer/managed_run_backend.py",
                    "action": "created",
                    "planned": True,
                    "reason": "adds backend",
                    "handling": "kept",
                    "verification": ["pytest tests/test_performer_managed_run_backend.py -q"],
                }
            ],
            "undeclared_files": [],
            "tests": {
                "red_command": "pytest tests/test_performer_managed_run_backend.py -q",
                "red_observed": True,
                "green_commands_run": ["pytest tests/test_performer_managed_run_backend.py -q"],
                "secret_scan_passed": True,
            },
            "acceptance_results": [{"criterion": "result parsed", "status": "passed", "evidence": "pytest passed"}],
            "blocked_reason": None,
            "plan_revision": None,
            "notes": "ready",
        }
    )
    backend = CodexManagedRunBackend(client)

    result = await backend.execute_turn(tmp_path, _work_item(), thread_id="thread-1")

    assert result.result.status_claimed is WorkItemResultStatus.READY_FOR_REVIEW
    assert result.result.changed_files[0].reason == "adds backend"
    assert "Execute work item wi-1 only" in client.calls[0]["prompt"]
    assert client.calls[0]["existing_thread_id"] == "thread-1"


def test_execute_work_item_prompt_includes_scope_and_tdd_rules() -> None:
    prompt = execute_work_item_prompt(_work_item())

    assert "touch only" in prompt
    assert "RED" in prompt
    assert "packages/performer/src/performer/managed_run_backend.py" in prompt


def test_managed_run_backend_output_schemas_close_every_object() -> None:
    for schema in (MANAGED_RUN_PLAN_SCHEMA, WORK_ITEM_RESULT_SCHEMA):
        _assert_object_schemas_closed(schema)


def _assert_object_schemas_closed(schema: dict) -> None:
    schema_type = schema.get("type")
    if schema_type == "object" or (isinstance(schema_type, list) and "object" in schema_type):
        assert schema.get("additionalProperties") is False
        assert isinstance(schema.get("required"), list)
    for key in ("properties",):
        values = schema.get(key)
        if isinstance(values, dict):
            for child in values.values():
                if isinstance(child, dict):
                    _assert_object_schemas_closed(child)
    items = schema.get("items")
    if isinstance(items, dict):
        _assert_object_schemas_closed(items)
    for key in ("anyOf", "oneOf", "allOf"):
        values = schema.get(key)
        if isinstance(values, list):
            for child in values:
                if isinstance(child, dict):
                    _assert_object_schemas_closed(child)


def test_managed_run_backend_cannot_write_linear_or_transition_work_items() -> None:
    source = Path("packages/performer/src/performer/managed_run_backend.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    imports = [
        node.module or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    ] + [
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    ]
    calls = [
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    ]

    assert not any("linear" in name.lower() for name in imports)
    assert not any(name.startswith(("transition_issue", "comment_issue", "update_issue")) for name in calls)
