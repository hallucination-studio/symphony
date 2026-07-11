from __future__ import annotations

from typing import Any


class ContractValidationError(ValueError):
    """Raised when an external performer contract is malformed."""


_PLAN_FIELDS = {
    "summary",
    "tasks",
    "risks",
    "architecture_decisions",
    "open_questions",
    "acceptance_catalog",
    "approval_required",
}
_TASK_FIELDS = {
    "id",
    "title",
    "objective",
    "acceptance_criteria",
    "verification_commands",
    "files_likely_touched",
}


def validate_plan(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ContractValidationError("plan must be an object")
    if "checkpoints" in payload:
        raise ContractValidationError("checkpoint groups are not supported")
    unknown = set(payload) - _PLAN_FIELDS
    if unknown:
        raise ContractValidationError(f"unknown plan fields: {', '.join(sorted(unknown))}")
    if not str(payload.get("summary") or "").strip():
        raise ContractValidationError("summary is required")

    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 10:
        raise ContractValidationError("tasks must contain 1 to 10 items")
    seen: set[str] = set()
    for item in tasks:
        _validate_task(item, seen)


def _validate_task(payload: Any, seen: set[str]) -> None:
    if not isinstance(payload, dict):
        raise ContractValidationError("task must be an object")
    unknown = set(payload) - _TASK_FIELDS
    if unknown:
        raise ContractValidationError(f"unknown task fields: {', '.join(sorted(unknown))}")
    task_id = str(payload.get("id") or "")
    if not task_id or task_id in seen:
        raise ContractValidationError("task ids must be unique and non-empty")
    seen.add(task_id)
    for field in ("title", "objective"):
        if not str(payload.get(field) or "").strip():
            raise ContractValidationError(f"{field} is required")
    criteria = payload.get("acceptance_criteria")
    if not isinstance(criteria, list) or not 1 <= len(criteria) <= 5 or any(not str(item).strip() for item in criteria):
        raise ContractValidationError("acceptance_criteria must contain 1 to 5 non-empty items")
    commands = payload.get("verification_commands")
    if not isinstance(commands, list) or not commands or any(not str(item).strip() for item in commands):
        raise ContractValidationError("verification_commands must contain a command")
    files = payload.get("files_likely_touched")
    if not isinstance(files, list) or not files or any(not str(item).strip() for item in files):
        raise ContractValidationError("files_likely_touched must contain a path")


__all__ = ["ContractValidationError", "validate_plan"]
