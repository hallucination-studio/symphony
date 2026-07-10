from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from performer_api.managed_runs import (
    ManagedRunPlan,
    ManagedRunPlanValidator,
    WorkItem,
    WorkItemResult,
)

from .managed_run_backend_schemas import MANAGED_RUN_PLAN_SCHEMA, WORK_ITEM_RESULT_SCHEMA


class ManagedRunBackendError(RuntimeError):
    pass


@dataclass(frozen=True)
class ManagedRunPlanTurnResult:
    thread_id: str
    plan: ManagedRunPlan
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class ManagedRunWorkItemTurnResult:
    thread_id: str
    result: WorkItemResult
    events: list[dict[str, Any]] = field(default_factory=list)


class CodexManagedRunBackend:
    def __init__(self, codex_client: Any) -> None:
        self.codex_client = codex_client

    async def plan_turn(
        self,
        workspace_path: Path,
        issue_description: str,
        *,
        existing_thread_id: str | None = None,
    ) -> ManagedRunPlanTurnResult:
        before = _workspace_changed_files(workspace_path)
        thread_id = existing_thread_id
        events: list[dict[str, Any]] = []
        validator = ManagedRunPlanValidator()
        last_errors: list[str] = []
        for attempt in range(1, 4):
            result = await self.codex_client.run_session(
                workspace_path,
                plan_prompt(issue_description) if attempt == 1 else repair_plan_prompt(issue_description, last_errors),
                "Plan Linear-native managed run",
                existing_thread_id=thread_id,
                output_schema=MANAGED_RUN_PLAN_SCHEMA,
            )
            thread_id = str(getattr(result, "thread_id", "") or thread_id or "")
            events.extend(list(getattr(result, "events", []) or []))
            changed = sorted(_workspace_changed_files(workspace_path) - before)
            if changed:
                raise ManagedRunBackendError(f"plan_turn_changed_files:{','.join(changed)}")
            structured = _structured_result(result)
            plan = ManagedRunPlan.from_dict(structured)
            errors = validator.validate(plan)
            if not errors:
                return ManagedRunPlanTurnResult(thread_id=thread_id, plan=plan, events=events)
            last_errors = [error.value for error in errors]
        raise ManagedRunBackendError(",".join(last_errors))

    async def execute_turn(
        self,
        workspace_path: Path,
        work_item: WorkItem,
        *,
        thread_id: str,
    ) -> ManagedRunWorkItemTurnResult:
        result = await self.codex_client.run_session(
            workspace_path,
            execute_work_item_prompt(work_item),
            f"Execute {work_item.id}",
            existing_thread_id=thread_id,
            output_schema=WORK_ITEM_RESULT_SCHEMA,
        )
        structured = _structured_result(result)
        work_item_result = WorkItemResult.from_dict(structured)
        if work_item_result.work_item_id != work_item.id:
            raise ManagedRunBackendError(f"work_item_result_id_mismatch:{work_item_result.work_item_id}")
        return ManagedRunWorkItemTurnResult(
            thread_id=str(getattr(result, "thread_id", "") or ""),
            result=work_item_result,
            events=list(getattr(result, "events", []) or []),
        )


def plan_prompt(issue_description: str) -> str:
    return (
        "Plan this delegated Linear issue. This turn is plan-only and must not change files.\n"
        "Return only the required Linear-native managed-run plan JSON schema.\n\n"
        f"{_plan_contract_instructions()}\n\n"
        f"Issue:\n{issue_description}"
    )


def repair_plan_prompt(issue_description: str, errors: list[str]) -> str:
    return (
        "Revise the previous managed-run plan. The previous JSON failed validation with these errors:\n"
        f"{', '.join(errors)}\n\n"
        "Return a complete replacement plan JSON object only. Do not change files.\n\n"
        f"{_plan_contract_instructions()}\n\n"
        f"Issue:\n{issue_description}"
    )


def _plan_contract_instructions() -> str:
    return (
        "Hard plan rules:\n"
        "- Every work item must have estimated_scope exactly XS, S, or M.\n"
        "- Every work item title must start with an action verb such as Add, Build, Create, Fix, Implement, Update, Validate, or Verify.\n"
        "- Work item titles must not contain the word 'and'; split combined work instead.\n"
        "- Each work item may have at most 3 acceptance_criteria.\n"
        "- Every work item needs red_command, at least one green_commands entry, and a non-empty files_likely_touched list.\n"
        "- Do not create a work item only to rerun validation for a dependency; put those commands in checkpoints after the producing work item.\n"
        "- If safe_to_parallelize is true, include parallel_group or shared_contracts.\n"
        "- Each checkpoint verify entry must be an executable shell command such as pytest tests/test_smoke.py -q; do not write prose checks.\n"
        "- Each risk object must contain risk and mitigation strings."
    )


def execute_work_item_prompt(work_item: WorkItem) -> str:
    return (
        f"Continue the approved plan. Execute work item {work_item.id} only.\n"
        "Rules:\n"
        "- Simplicity first: write the plainest obviously-correct implementation.\n"
        f"- Scope discipline: touch only {', '.join(work_item.files_likely_touched)}.\n"
        "- Keep it compilable: the project builds and existing tests pass at turn end.\n"
        f"- Make verification.red_command go RED: {work_item.verification.red_command}\n"
        f"- Then make green_commands pass: {', '.join(work_item.verification.green_commands)}\n"
        "- Report tests.secret_scan_passed=true only after checking the change for leaked secrets.\n"
        "Return only the structured work-item result JSON schema when finished."
    )


def _structured_result(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structured_result", None)
    if not isinstance(structured, dict):
        raise ManagedRunBackendError("missing_structured_result")
    return structured


def _workspace_changed_files(workspace_path: Path) -> set[str]:
    try:
        completed = subprocess.run(
            ["git", "-C", str(workspace_path), "status", "--porcelain"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if completed.returncode != 0:
        return set()
    changed: set[str] = set()
    for line in completed.stdout.splitlines():
        path = line[3:].strip()
        if path:
            changed.add(path)
    return changed


__all__ = [
    "CodexManagedRunBackend",
    "MANAGED_RUN_PLAN_SCHEMA",
    "ManagedRunBackendError",
    "ManagedRunPlanTurnResult",
    "ManagedRunWorkItemTurnResult",
    "WORK_ITEM_RESULT_SCHEMA",
    "execute_work_item_prompt",
    "plan_prompt",
]
