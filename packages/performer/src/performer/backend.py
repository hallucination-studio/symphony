from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from performer_api.turns import ExecuteResult, GateResult
from performer_api.validation import ContractValidationError, validate_plan
from performer_api.workflow import Plan, Task

from .schemas import EXECUTE_SCHEMA, GATE_SCHEMA, PLAN_SCHEMA


class TurnBackendError(RuntimeError):
    pass


@dataclass(frozen=True)
class PlanTurn:
    thread_id: str
    plan: Plan
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class ExecuteTurn:
    thread_id: str
    result: ExecuteResult
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class GateTurn:
    thread_id: str
    result: GateResult
    events: list[dict[str, Any]] = field(default_factory=list)


class TurnBackend:
    def __init__(self, codex_client: Any) -> None:
        self.codex_client = codex_client

    async def plan(self, workspace: Path, issue_description: str, *, thread_id: str = "") -> PlanTurn:
        before = _workspace_files(workspace)
        result = await self._run(
            workspace,
            prompt=_plan_prompt(issue_description),
            title="Plan delegated Linear issue",
            thread_id=thread_id,
            schema=PLAN_SCHEMA,
        )
        changed = sorted(_workspace_files(workspace) - before)
        if changed:
            raise TurnBackendError(f"plan_turn_changed_files:{','.join(changed)}")
        structured = _structured_result(result)
        try:
            validate_plan(structured)
        except ContractValidationError as exc:
            raise TurnBackendError(str(exc)) from exc
        return PlanTurn(str(getattr(result, "thread_id", "") or thread_id), Plan.from_dict(structured), _events(result))

    async def execute(self, workspace: Path, task: Task, *, thread_id: str = "") -> ExecuteTurn:
        result = await self._run(
            workspace,
            prompt=_execute_prompt(task),
            title=f"Execute {task.id}",
            thread_id=thread_id,
            schema=EXECUTE_SCHEMA,
        )
        execute_result = ExecuteResult.from_dict(_structured_result(result))
        return ExecuteTurn(str(getattr(result, "thread_id", "") or thread_id), execute_result, _events(result))

    async def gate(
        self,
        workspace: Path,
        task: Task,
        evidence: dict[str, Any],
        *,
        thread_id: str = "",
    ) -> GateTurn:
        before = _workspace_files(workspace)
        result = await self._run(
            workspace,
            prompt=_gate_prompt(task, evidence),
            title=f"Gate {task.id}",
            thread_id=thread_id,
            schema=GATE_SCHEMA,
        )
        changed = sorted(_workspace_files(workspace) - before)
        if changed:
            raise TurnBackendError(f"gate_turn_changed_files:{','.join(changed)}")
        return GateTurn(str(getattr(result, "thread_id", "") or thread_id), GateResult.from_dict(_structured_result(result)), _events(result))

    async def _run(self, workspace: Path, *, prompt: str, title: str, thread_id: str, schema: dict[str, Any]) -> Any:
        try:
            return await self.codex_client.run_session(
                workspace,
                prompt,
                title,
                existing_thread_id=thread_id or None,
                output_schema=schema,
            )
        except Exception as exc:
            raise TurnBackendError(str(exc)) from exc


def _plan_prompt(issue_description: str) -> str:
    return (
        "Create an ordered plan for this delegated Linear issue. Do not change files. "
        "Return only the requested JSON plan. Each task needs an objective, 1-5 acceptance criteria, "
        "one verification command, and a non-empty file scope.\n\n"
        f"Issue:\n{issue_description}"
    )


def _execute_prompt(task: Task) -> str:
    return (
        f"Execute task {task.id} only. Keep changes within: {', '.join(task.files_likely_touched)}.\n"
        f"Objective: {task.objective}\nAcceptance: {'; '.join(task.acceptance_criteria)}\n"
        f"Verification command: {' && '.join(task.verification_commands)}\n"
        "Return only the execute result JSON."
    )


def _gate_prompt(task: Task, evidence: dict[str, Any]) -> str:
    return (
        f"Review task {task.id} read-only. Do not change files.\n"
        f"Acceptance criteria: {'; '.join(task.acceptance_criteria)}\n"
        f"Verification evidence: {evidence}\n"
        "Return the single gate result JSON with score, rubric, threshold, and provenance."
    )


def _structured_result(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structured_result", None)
    if not isinstance(structured, dict):
        raise TurnBackendError("missing_structured_result")
    return structured


def _events(result: Any) -> list[dict[str, Any]]:
    return [dict(event) for event in getattr(result, "events", []) or [] if isinstance(event, dict)]


def _workspace_files(workspace: Path) -> set[str]:
    try:
        completed = subprocess.run(
            ["git", "-C", str(workspace), "status", "--porcelain"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if completed.returncode != 0:
        return set()
    return {line[3:].strip() for line in completed.stdout.splitlines() if len(line) > 3 and line[3:].strip()}


__all__ = ["ExecuteTurn", "GateTurn", "PlanTurn", "TurnBackend", "TurnBackendError"]
