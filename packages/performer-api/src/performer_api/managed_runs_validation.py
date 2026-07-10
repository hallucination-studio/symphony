from __future__ import annotations

from performer_api.managed_runs_enums import ManagedRunPlanValidatorError
from performer_api.managed_runs_plan import ManagedRunPlan, WorkItem


class ManagedRunPlanValidator:
    MAX_WORK_ITEMS = 12

    def validate(self, plan: ManagedRunPlan) -> list[ManagedRunPlanValidatorError]:
        errors: list[ManagedRunPlanValidatorError] = []
        if not plan.verification_rubric.is_complete():
            errors.append(ManagedRunPlanValidatorError.INCOMPLETE_RUBRIC)
        if len(plan.work_items) > self.MAX_WORK_ITEMS:
            errors.append(ManagedRunPlanValidatorError.TOO_MANY_WORK_ITEMS)
        ids = [item.id for item in plan.work_items]
        id_set = set(ids)
        if len(ids) != len(id_set):
            errors.append(ManagedRunPlanValidatorError.DUPLICATE_WORK_ITEM_ID)
        items_by_id = {item.id: item for item in plan.work_items}
        edges: list[tuple[str, str]] = []
        for item in plan.work_items:
            errors.extend(self._validate_item(item))
            if _is_validation_only_followup(item, items_by_id):
                errors.append(ManagedRunPlanValidatorError.VALIDATION_ONLY_WORK_ITEM)
            for dependency in item.dependencies:
                if dependency not in id_set:
                    errors.append(ManagedRunPlanValidatorError.MISSING_DEPENDENCY)
                edges.append((dependency, item.id))
        for checkpoint in plan.checkpoints:
            for command in checkpoint.verify:
                if not _looks_like_shell_command(command):
                    errors.append(ManagedRunPlanValidatorError.INVALID_CHECKPOINT_COMMAND)
        if _has_cycle(id_set, edges):
            errors.append(ManagedRunPlanValidatorError.CYCLE_DETECTED)
        return _dedupe_errors(errors)

    def _validate_item(self, item: WorkItem) -> list[ManagedRunPlanValidatorError]:
        errors: list[ManagedRunPlanValidatorError] = []
        scope = item.estimated_scope.upper()
        if scope in {"L", "XL"}:
            errors.append(ManagedRunPlanValidatorError.WORK_ITEM_TOO_LARGE)
        elif scope not in {"XS", "S", "M"}:
            errors.append(ManagedRunPlanValidatorError.INVALID_SCOPE)
        if len(item.acceptance_criteria) > 3:
            errors.append(ManagedRunPlanValidatorError.TOO_MANY_ACCEPTANCE_CRITERIA)
        if " and " in item.title.lower():
            errors.append(ManagedRunPlanValidatorError.TITLE_HAS_AND)
        if not _title_starts_with_action_verb(item.title):
            errors.append(ManagedRunPlanValidatorError.TITLE_NOT_VERB_FIRST)
        if not item.verification.red_command.strip():
            errors.append(ManagedRunPlanValidatorError.MISSING_RED_COMMAND)
        if not item.verification.green_commands:
            errors.append(ManagedRunPlanValidatorError.MISSING_GREEN_COMMANDS)
        if not item.files_likely_touched:
            errors.append(ManagedRunPlanValidatorError.EMPTY_FILE_SCOPE)
        if item.parallelization.safe_to_parallelize and not (
            item.parallelization.shared_contracts or item.parallelization.parallel_group
        ):
            errors.append(ManagedRunPlanValidatorError.UNSAFE_PARALLELIZATION)
        return errors


def _title_starts_with_action_verb(title: str) -> bool:
    return _first_title_word(title) in {
        "add",
        "audit",
        "build",
        "change",
        "clean",
        "connect",
        "create",
        "delete",
        "document",
        "enforce",
        "extract",
        "fix",
        "harden",
        "implement",
        "integrate",
        "migrate",
        "publish",
        "record",
        "refactor",
        "remove",
        "render",
        "replace",
        "route",
        "ship",
        "split",
        "test",
        "update",
        "validate",
        "verify",
    }


def _first_title_word(title: str) -> str:
    return str(title or "").strip().split(" ", 1)[0].lower().strip(":-")


def _looks_like_shell_command(command: str) -> bool:
    first = str(command or "").strip().split(" ", 1)[0].lower()
    basename = first.rsplit("/", 1)[-1]
    if basename in {"python", "python3"}:
        return True
    return first.startswith("./") or first in {
        "bash",
        "git",
        "grep",
        "make",
        "mypy",
        "npm",
        "pnpm",
        "pytest",
        "python",
        "python3",
        "ruff",
        "sh",
        "test",
        "tox",
        "uv",
        "yarn",
    }


def _is_validation_only_followup(item: WorkItem, items_by_id: dict[str, WorkItem]) -> bool:
    if not item.dependencies or _first_title_word(item.title) not in {"test", "validate", "verify"}:
        return False
    red = _normalized_command(item.verification.red_command)
    greens = {_normalized_command(command) for command in item.verification.green_commands}
    if not red or red not in greens:
        return False
    dependency_files: set[str] = set()
    for dependency in item.dependencies:
        dependency_item = items_by_id.get(dependency)
        if dependency_item is not None:
            dependency_files.update(dependency_item.files_likely_touched)
    return bool(item.files_likely_touched) and set(item.files_likely_touched).issubset(dependency_files)


def _normalized_command(command: str) -> str:
    return " ".join(str(command or "").split())


def _has_cycle(node_ids: set[str], edges: list[tuple[str, str]]) -> bool:
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    for source, target in edges:
        if source in adjacency and target in adjacency:
            adjacency[source].append(target)
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in visiting:
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        for target in adjacency.get(node_id, []):
            if visit(target):
                return True
        visiting.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in node_ids)


def _dedupe_errors(errors: list[ManagedRunPlanValidatorError]) -> list[ManagedRunPlanValidatorError]:
    seen: set[ManagedRunPlanValidatorError] = set()
    deduped: list[ManagedRunPlanValidatorError] = []
    for error in errors:
        if error in seen:
            continue
        deduped.append(error)
        seen.add(error)
    return deduped
