from __future__ import annotations

from enum import StrEnum


RUN_SUMMARY_START = "<!-- symphony:run-summary:start -->"
RUN_SUMMARY_END = "<!-- symphony:run-summary:end -->"
SECRET_SETTING_KEYS = {
    "api_key",
    "client_secret",
    "codex_home_source",
    "cookie",
    "linear_api_key",
    "password",
    "podium_proxy_token",
    "podium_runtime_token",
    "refresh_token",
    "secret",
    "session_cookie",
    "token",
}


class ManagedRunRuntimeRole(StrEnum):
    PLAN = "plan"
    WORK_ITEM = "work_item"
    VERIFY = "verify"


MANAGED_RUN_BACKENDS_BY_ROLE = {
    ManagedRunRuntimeRole.PLAN: {"codex"},
    ManagedRunRuntimeRole.WORK_ITEM: {"codex"},
    ManagedRunRuntimeRole.VERIFY: {"codex", "local-verifier"},
}


class ManagedRunState(StrEnum):
    QUEUED = "queued"
    PLANNING = "planning"
    PROJECTING_PLAN = "projecting_plan"
    AWAITING_APPROVAL = "awaiting_approval"
    READY = "ready"
    EXECUTING = "executing"
    REVIEWING = "reviewing"
    VERIFIED = "verified"
    RECONCILING_LINEAR_CHANGE = "reconciling_linear_change"
    BLOCKED = "blocked"
    FAILED = "failed"
    DONE = "done"


class WorkItemState(StrEnum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    DONE = "done"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


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


class LinearChangeClass(StrEnum):
    NO_OP = "no_op"
    NORMAL_REVISION = "normal_revision"
    DESTRUCTIVE_CHANGE = "destructive_change"
    ABNORMAL_TRANSITION = "abnormal_transition"


class LinearRevisionAction(StrEnum):
    CONTINUE_CURRENT_RUN = "continue_current_run"
    REVISE_CURRENT_PLAN = "revise_current_plan"
    CANCEL_WORK_ITEM = "cancel_work_item"
    COMPLETE_WORK_ITEM = "complete_work_item"
    CREATE_REPLACEMENT_ROOT_ISSUE = "create_replacement_root_issue"


class CanonicalAgentEventType(StrEnum):
    TURN_STARTED = "turn_started"
    TURN_RESUMED = "turn_resumed"
    TURN_COMPLETED = "turn_completed"
    TURN_FAILED = "turn_failed"
    APPROVAL_WAIT = "approval_wait"
    TOOL_INPUT_WAIT = "tool_input_wait"
    COMMAND_RESULT = "command_result"
    TOKEN_USAGE = "token_usage"


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
