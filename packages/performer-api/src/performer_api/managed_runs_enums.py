from __future__ import annotations

from enum import StrEnum


class ManagedRunRuntimeRole(StrEnum):
    PLAN = "plan"
    WORK_ITEM = "work_item"
    VERIFY = "verify"


MANAGED_RUN_BACKENDS_BY_ROLE = {
    ManagedRunRuntimeRole.PLAN: {"codex"},
    ManagedRunRuntimeRole.WORK_ITEM: {"codex"},
    ManagedRunRuntimeRole.VERIFY: {"codex", "local-verifier"},
}


class WorkItemSliceType(StrEnum):
    VERTICAL = "vertical"
    CONTRACT_FIRST = "contract-first"
    RISK_FIRST = "risk-first"
    TEST_ONLY = "test-only"
    DOCS_ONLY = "docs-only"
    RESEARCH = "research"


class WorkItemResultStatus(StrEnum):
    READY_FOR_REVIEW = "ready_for_review"
    BLOCKED = "blocked"
    PLAN_REVISION_REQUESTED = "plan_revision_requested"


class ManagedRunPlanValidatorError(StrEnum):
    WORK_ITEM_TOO_LARGE = "work_item_too_large"
    INVALID_SCOPE = "invalid_scope"
    TOO_MANY_ACCEPTANCE_CRITERIA = "too_many_acceptance_criteria"
    TITLE_HAS_AND = "title_has_and"
    TITLE_NOT_VERB_FIRST = "title_not_verb_first"
    MISSING_RED_COMMAND = "missing_red_command"
    MISSING_GREEN_COMMANDS = "missing_green_commands"
    CYCLE_DETECTED = "cycle_detected"
    EMPTY_FILE_SCOPE = "empty_file_scope"
    UNSAFE_PARALLELIZATION = "unsafe_parallelization"
    INCOMPLETE_RUBRIC = "incomplete_rubric"
    DUPLICATE_WORK_ITEM_ID = "duplicate_work_item_id"
    MISSING_DEPENDENCY = "missing_dependency"
    INVALID_CHECKPOINT_COMMAND = "invalid_checkpoint_command"
    VALIDATION_ONLY_WORK_ITEM = "validation_only_work_item"
    TOO_MANY_WORK_ITEMS = "too_many_work_items"
    MISSING_PLAN_SUMMARY = "missing_plan_summary"
    MISSING_ARCHITECTURE_DECISIONS = "missing_architecture_decisions"
    MISSING_WORK_ITEMS = "missing_work_items"
    MISSING_WORK_ITEM_ID = "missing_work_item_id"
    MISSING_OBJECTIVE = "missing_objective"
    MISSING_ACCEPTANCE_CRITERIA = "missing_acceptance_criteria"
    INVALID_VERIFICATION_COMMAND = "invalid_verification_command"
    INVALID_CHECKPOINT_TARGET = "invalid_checkpoint_target"
    MISSING_PARALLELIZATION_REASON = "missing_parallelization_reason"
