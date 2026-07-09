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


MANAGED_RUN_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "architecture_decisions": {"type": "array", "items": {"type": "string"}},
        "work_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "objective": {"type": "string"},
                    "slice_type": {"type": "string", "enum": ["vertical", "contract-first", "risk-first", "test-only", "docs-only", "research"]},
                    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
                    "verification": {
                        "type": "object",
                        "properties": {
                            "red_command": {"type": "string"},
                            "green_commands": {"type": "array", "items": {"type": "string"}},
                            "runtime_checks": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["red_command", "green_commands", "runtime_checks"],
                        "additionalProperties": False,
                    },
                    "dependencies": {"type": "array", "items": {"type": "string"}},
                    "estimated_scope": {"type": "string"},
                    "files_likely_touched": {"type": "array", "items": {"type": "string"}},
                    "parallelization": {
                        "type": "object",
                        "properties": {
                            "safe_to_parallelize": {"type": "boolean"},
                            "parallel_group": {"type": ["string", "null"]},
                            "reason": {"type": "string"},
                            "shared_contracts": {"type": "array", "items": {"type": "string"}},
                            "merge_strategy": {"type": "string"},
                        },
                        "required": ["safe_to_parallelize", "parallel_group", "reason", "shared_contracts", "merge_strategy"],
                        "additionalProperties": False,
                    },
                    "needs_human_approval": {"type": "boolean"},
                },
                "required": [
                    "id",
                    "title",
                    "objective",
                    "slice_type",
                    "acceptance_criteria",
                    "verification",
                    "dependencies",
                    "estimated_scope",
                    "files_likely_touched",
                    "parallelization",
                    "needs_human_approval",
                ],
                "additionalProperties": False,
            },
        },
        "checkpoints": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "after": {"type": "array", "items": {"type": "string"}},
                    "verify": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["after", "verify"],
                "additionalProperties": False,
            },
        },
        "verification_rubric": {
            "type": "object",
            "properties": {
                "correctness": {"type": "array", "items": {"type": "string"}},
                "quality": {"type": "array", "items": {"type": "string"}},
                "integration": {"type": "array", "items": {"type": "string"}},
                "documentation": {"type": "array", "items": {"type": "string"}},
                "ship_readiness": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["correctness", "quality", "integration", "documentation", "ship_readiness"],
            "additionalProperties": False,
        },
        "risks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "risk": {"type": "string"},
                    "mitigation": {"type": "string"},
                },
                "required": ["risk", "mitigation"],
                "additionalProperties": False,
            },
        },
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "approval_required": {"type": "boolean"},
    },
    "required": [
        "summary",
        "architecture_decisions",
        "work_items",
        "checkpoints",
        "verification_rubric",
        "risks",
        "open_questions",
        "approval_required",
    ],
    "additionalProperties": False,
}


WORK_ITEM_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "work_item_id": {"type": "string"},
        "status_claimed": {"type": "string", "enum": ["ready_for_review", "blocked", "plan_revision_requested"]},
        "changed_files": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "action": {"type": "string"},
                    "planned": {"type": "boolean"},
                    "reason": {"type": "string"},
                    "handling": {"type": "string"},
                    "verification": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["path", "action", "planned", "reason", "handling", "verification"],
                "additionalProperties": False,
            },
        },
        "undeclared_files": {"type": "array", "items": {"type": "string"}},
        "tests": {
            "type": "object",
            "properties": {
                "red_command": {"type": "string"},
                "red_observed": {"type": "boolean"},
                "green_commands_run": {"type": "array", "items": {"type": "string"}},
                "secret_scan_passed": {"type": "boolean"},
            },
            "required": ["red_command", "red_observed", "green_commands_run", "secret_scan_passed"],
            "additionalProperties": False,
        },
        "acceptance_results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "criterion": {"type": "string"},
                    "status": {"type": "string", "enum": ["passed", "failed", "blocked"]},
                    "evidence": {"type": "string"},
                },
                "required": ["criterion", "status", "evidence"],
                "additionalProperties": False,
            },
        },
        "blocked_reason": {"type": ["string", "null"]},
        "plan_revision": {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string"},
                        "files_likely_touched": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["reason", "files_likely_touched"],
                    "additionalProperties": False,
                },
                {"type": "null"},
            ]
        },
        "notes": {"type": "string"},
    },
    "required": [
        "work_item_id",
        "status_claimed",
        "changed_files",
        "undeclared_files",
        "tests",
        "acceptance_results",
        "blocked_reason",
        "plan_revision",
        "notes",
    ],
    "additionalProperties": False,
}


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
