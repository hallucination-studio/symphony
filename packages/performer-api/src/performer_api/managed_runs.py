from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from dataclasses import replace
from enum import StrEnum
from typing import Any


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


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    backend: str
    role: ManagedRunRuntimeRole
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "role": self.role.value,
            "settings": _jsonable_dict(self.settings),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeProfile:
        return cls(
            name=str(payload.get("name") or ""),
            backend=str(payload.get("backend") or ""),
            role=_runtime_role(payload.get("role")),
            settings=_dict(payload.get("settings")),
        )

    def sanitized(self) -> RuntimeProfile:
        return replace(self, settings=sanitize_profile_settings(self.settings))


@dataclass(frozen=True)
class ManagedRunCapacity:
    global_limit: int | None = None
    by_role: dict[ManagedRunRuntimeRole, int | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "global": self.global_limit,
            "by_role": {role.value: limit for role, limit in sorted(self.by_role.items(), key=lambda item: item[0].value)},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunCapacity:
        by_role_payload = payload.get("by_role")
        by_role: dict[ManagedRunRuntimeRole, int | None] = {}
        if isinstance(by_role_payload, dict):
            for role, limit in by_role_payload.items():
                by_role[_runtime_role(role)] = _optional_int(limit)
        return cls(global_limit=_optional_int(payload.get("global")), by_role=by_role)

    def remaining_for_role(
        self,
        role: ManagedRunRuntimeRole,
        *,
        active_global: int,
        active_by_role: dict[ManagedRunRuntimeRole, int],
    ) -> int | None:
        available_global = None if self.global_limit is None else max(0, self.global_limit - active_global)
        role_limit = self.by_role.get(role)
        if role_limit is None:
            return available_global
        available_role = max(0, role_limit - int(active_by_role.get(role, 0)))
        if available_global is None:
            return available_role
        return min(available_global, available_role)


@dataclass(frozen=True)
class ManagedRunPolicy:
    policy_id: str
    version: int
    effective_at: str
    capacity: ManagedRunCapacity
    max_rework_attempts: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "effective_at": self.effective_at,
            "capacity": self.capacity.to_dict(),
            "max_rework_attempts": self.max_rework_attempts,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunPolicy:
        return cls(
            policy_id=str(payload.get("policy_id") or ""),
            version=_int(payload.get("version"), default=0),
            effective_at=str(payload.get("effective_at") or ""),
            capacity=ManagedRunCapacity.from_dict(_dict(payload.get("capacity"))),
            max_rework_attempts=_int(payload.get("max_rework_attempts"), default=3),
        )

    def accepts_update(self, candidate: ManagedRunPolicy) -> bool:
        return candidate.version > self.version

    def remaining_for_role(
        self,
        role: ManagedRunRuntimeRole,
        *,
        active_global: int,
        active_by_role: dict[ManagedRunRuntimeRole, int],
    ) -> int | None:
        return self.capacity.remaining_for_role(role, active_global=active_global, active_by_role=active_by_role)

    def with_version(self, version: int) -> ManagedRunPolicy:
        return replace(self, version=version)


@dataclass(frozen=True)
class RuntimeConfigEnvelope:
    runtime_group_id: str
    version: int
    managed_run_policy: ManagedRunPolicy
    profiles: dict[ManagedRunRuntimeRole, RuntimeProfile] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_group_id": self.runtime_group_id,
            "version": self.version,
            "managed_run_policy": self.managed_run_policy.to_dict(),
            "profiles": {role.value: profile.to_dict() for role, profile in self.profiles.items()},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfigEnvelope:
        profiles_payload = payload.get("profiles")
        profiles: dict[ManagedRunRuntimeRole, RuntimeProfile] = {}
        if isinstance(profiles_payload, dict):
            for role, profile_payload in profiles_payload.items():
                if isinstance(profile_payload, dict):
                    profiles[_runtime_role(role)] = RuntimeProfile.from_dict({**profile_payload, "role": profile_payload.get("role") or role})
        return cls(
            runtime_group_id=str(payload.get("runtime_group_id") or ""),
            version=_int(payload.get("version"), default=0),
            managed_run_policy=ManagedRunPolicy.from_dict(_dict(payload.get("managed_run_policy"))),
            profiles=profiles,
        )

    def sanitized(self) -> RuntimeConfigEnvelope:
        return replace(self, profiles={role: profile.sanitized() for role, profile in self.profiles.items()})

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.runtime_group_id.strip():
            errors.append("runtime_group_id_required")
        if self.version <= 0:
            errors.append("version_required")
        policy = self.managed_run_policy
        if not policy.policy_id.strip():
            errors.append("managed_run_policy_id_required")
        if policy.version <= 0:
            errors.append("managed_run_policy_version_required")
        if policy.version != self.version:
            errors.append("managed_run_policy_version_mismatch")
        if not policy.effective_at.strip():
            errors.append("managed_run_policy_effective_at_required")
        if policy.max_rework_attempts <= 0:
            errors.append("max_rework_attempts_required")
        if policy.capacity.global_limit is not None and policy.capacity.global_limit < 0:
            errors.append("capacity_global_invalid")
        for role, limit in policy.capacity.by_role.items():
            if role not in set(ManagedRunRuntimeRole):
                errors.append("capacity_role_invalid")
            if limit is not None and limit < 0:
                errors.append(f"capacity_{role.value}_invalid")
        required_roles = set(ManagedRunRuntimeRole)
        if set(self.profiles) != required_roles:
            missing = sorted(role.value for role in required_roles - set(self.profiles))
            extra = sorted(str(role) for role in set(self.profiles) - required_roles)
            if missing:
                errors.append(f"runtime_profiles_missing:{','.join(missing)}")
            if extra:
                errors.append(f"runtime_profiles_unknown:{','.join(extra)}")
        for role, profile in self.profiles.items():
            if profile.role is not role:
                errors.append(f"runtime_profile_role_mismatch:{role.value}")
            if not profile.name.strip():
                errors.append(f"runtime_profile_name_required:{role.value}")
            if not profile.backend.strip():
                errors.append(f"runtime_profile_backend_required:{role.value}")
            elif profile.backend not in MANAGED_RUN_BACKENDS_BY_ROLE.get(role, set()):
                errors.append(f"runtime_profile_backend_unsupported:{role.value}:{profile.backend}")
        return errors

    def validate(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError("invalid runtime config: " + ", ".join(errors))


@dataclass(frozen=True)
class WorkItemVerification:
    red_command: str
    green_commands: list[str] = field(default_factory=list)
    runtime_checks: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> WorkItemVerification:
        return cls(
            red_command=str(payload.get("red_command") or ""),
            green_commands=_str_list(payload.get("green_commands")),
            runtime_checks=_str_list(payload.get("runtime_checks")),
        )


@dataclass(frozen=True)
class ParallelizationPolicy:
    safe_to_parallelize: bool
    parallel_group: str | None = None
    reason: str = ""
    shared_contracts: list[str] = field(default_factory=list)
    merge_strategy: str = "single worktree"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ParallelizationPolicy:
        return cls(
            safe_to_parallelize=bool(payload.get("safe_to_parallelize")),
            parallel_group=_optional_str(payload.get("parallel_group")),
            reason=str(payload.get("reason") or ""),
            shared_contracts=_str_list(payload.get("shared_contracts")),
            merge_strategy=str(payload.get("merge_strategy") or "single worktree"),
        )


@dataclass(frozen=True)
class WorkItem:
    id: str
    title: str
    objective: str
    slice_type: WorkItemSliceType
    acceptance_criteria: list[str]
    verification: WorkItemVerification
    dependencies: list[str]
    estimated_scope: str
    files_likely_touched: list[str]
    parallelization: ParallelizationPolicy
    needs_human_approval: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "objective": self.objective,
            "slice_type": self.slice_type.value,
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification": self.verification.to_dict(),
            "dependencies": list(self.dependencies),
            "estimated_scope": self.estimated_scope,
            "files_likely_touched": list(self.files_likely_touched),
            "parallelization": self.parallelization.to_dict(),
            "needs_human_approval": self.needs_human_approval,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> WorkItem:
        return cls(
            id=str(payload.get("id") or ""),
            title=str(payload.get("title") or ""),
            objective=str(payload.get("objective") or ""),
            slice_type=_enum(WorkItemSliceType, payload.get("slice_type"), WorkItemSliceType.VERTICAL),
            acceptance_criteria=_str_list(payload.get("acceptance_criteria")),
            verification=WorkItemVerification.from_dict(_dict(payload.get("verification"))),
            dependencies=_str_list(payload.get("dependencies")),
            estimated_scope=str(payload.get("estimated_scope") or ""),
            files_likely_touched=_str_list(payload.get("files_likely_touched")),
            parallelization=ParallelizationPolicy.from_dict(_dict(payload.get("parallelization"))),
            needs_human_approval=bool(payload.get("needs_human_approval")),
        )


@dataclass(frozen=True)
class Checkpoint:
    after: list[str] = field(default_factory=list)
    verify: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Checkpoint:
        return cls(after=_str_list(payload.get("after")), verify=_str_list(payload.get("verify")))


@dataclass(frozen=True)
class VerificationRubric:
    correctness: list[str] = field(default_factory=list)
    quality: list[str] = field(default_factory=list)
    integration: list[str] = field(default_factory=list)
    documentation: list[str] = field(default_factory=list)
    ship_readiness: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerificationRubric:
        return cls(
            correctness=_str_list(payload.get("correctness")),
            quality=_str_list(payload.get("quality")),
            integration=_str_list(payload.get("integration")),
            documentation=_str_list(payload.get("documentation")),
            ship_readiness=_str_list(payload.get("ship_readiness")),
        )

    def is_complete(self) -> bool:
        return all(
            [
                self.correctness,
                self.quality,
                self.integration,
                self.documentation,
                self.ship_readiness,
            ]
        )


@dataclass(frozen=True)
class ManagedRunPlan:
    summary: str
    architecture_decisions: list[str]
    work_items: list[WorkItem]
    checkpoints: list[Checkpoint]
    verification_rubric: VerificationRubric
    risks: list[dict[str, Any]]
    open_questions: list[str]
    approval_required: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "architecture_decisions": list(self.architecture_decisions),
            "work_items": [item.to_dict() for item in self.work_items],
            "checkpoints": [checkpoint.to_dict() for checkpoint in self.checkpoints],
            "verification_rubric": self.verification_rubric.to_dict(),
            "risks": [_jsonable_dict(risk) for risk in self.risks],
            "open_questions": list(self.open_questions),
            "approval_required": self.approval_required,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunPlan:
        return cls(
            summary=str(payload.get("summary") or ""),
            architecture_decisions=_str_list(payload.get("architecture_decisions")),
            work_items=[WorkItem.from_dict(item) for item in payload.get("work_items") or [] if isinstance(item, dict)],
            checkpoints=[Checkpoint.from_dict(item) for item in payload.get("checkpoints") or [] if isinstance(item, dict)],
            verification_rubric=VerificationRubric.from_dict(_dict(payload.get("verification_rubric"))),
            risks=[_jsonable_dict(item) for item in payload.get("risks") or [] if isinstance(item, dict)],
            open_questions=_str_list(payload.get("open_questions")),
            approval_required=bool(payload.get("approval_required")),
        )


@dataclass(frozen=True)
class ChangedFile:
    path: str
    action: str
    planned: bool
    reason: str
    handling: str
    verification: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ChangedFile:
        return cls(
            path=str(payload.get("path") or ""),
            action=str(payload.get("action") or ""),
            planned=bool(payload.get("planned")),
            reason=str(payload.get("reason") or ""),
            handling=str(payload.get("handling") or ""),
            verification=_str_list(payload.get("verification")),
        )


@dataclass(frozen=True)
class WorkItemResult:
    work_item_id: str
    status_claimed: WorkItemResultStatus
    changed_files: list[ChangedFile]
    undeclared_files: list[str]
    tests: dict[str, Any]
    acceptance_results: list[dict[str, Any]]
    blocked_reason: str | None
    plan_revision: dict[str, Any] | None
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "work_item_id": self.work_item_id,
            "status_claimed": self.status_claimed.value,
            "changed_files": [changed.to_dict() for changed in self.changed_files],
            "undeclared_files": list(self.undeclared_files),
            "tests": _jsonable_dict(self.tests),
            "acceptance_results": [_jsonable_dict(item) for item in self.acceptance_results],
            "blocked_reason": self.blocked_reason,
            "plan_revision": _jsonable_dict(self.plan_revision) if isinstance(self.plan_revision, dict) else None,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> WorkItemResult:
        return cls(
            work_item_id=str(payload.get("work_item_id") or ""),
            status_claimed=_enum(WorkItemResultStatus, payload.get("status_claimed"), WorkItemResultStatus.BLOCKED),
            changed_files=[ChangedFile.from_dict(item) for item in payload.get("changed_files") or [] if isinstance(item, dict)],
            undeclared_files=_str_list(payload.get("undeclared_files")),
            tests=_jsonable_dict(_dict(payload.get("tests"))),
            acceptance_results=[_jsonable_dict(item) for item in payload.get("acceptance_results") or [] if isinstance(item, dict)],
            blocked_reason=_optional_str(payload.get("blocked_reason")),
            plan_revision=_jsonable_dict(payload.get("plan_revision")) if isinstance(payload.get("plan_revision"), dict) else None,
            notes=str(payload.get("notes") or ""),
        )


@dataclass(frozen=True)
class RevisionDecision:
    change_class: LinearChangeClass
    conclusion: str
    reason: str
    action: LinearRevisionAction
    requires_new_root_issue: bool
    comment_required: bool
    affected_work_items: list[str] = field(default_factory=list)
    proposed_revision: dict[str, Any] | None = None
    replacement_issue: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "change_class": self.change_class.value,
            "conclusion": self.conclusion,
            "reason": self.reason,
            "action": self.action.value,
            "requires_new_root_issue": self.requires_new_root_issue,
            "comment_required": self.comment_required,
            "affected_work_items": list(self.affected_work_items),
            "proposed_revision": _jsonable_dict(self.proposed_revision) if isinstance(self.proposed_revision, dict) else None,
            "replacement_issue": _jsonable_dict(self.replacement_issue) if isinstance(self.replacement_issue, dict) else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RevisionDecision:
        return cls(
            change_class=_enum(LinearChangeClass, payload.get("change_class"), LinearChangeClass.NO_OP),
            conclusion=str(payload.get("conclusion") or ""),
            reason=str(payload.get("reason") or ""),
            action=_enum(LinearRevisionAction, payload.get("action"), LinearRevisionAction.CONTINUE_CURRENT_RUN),
            requires_new_root_issue=bool(payload.get("requires_new_root_issue")),
            comment_required=bool(payload.get("comment_required")),
            affected_work_items=_str_list(payload.get("affected_work_items")),
            proposed_revision=_jsonable_dict(payload.get("proposed_revision")) if isinstance(payload.get("proposed_revision"), dict) else None,
            replacement_issue=_jsonable_dict(payload.get("replacement_issue")) if isinstance(payload.get("replacement_issue"), dict) else None,
        )


@dataclass(frozen=True)
class ThreadCompletionReport:
    status: str
    thread_id: str
    plan_version: int
    what_this_thread_did: list[str]
    files_changed: list[dict[str, Any]]
    rubric_results: list[dict[str, Any]]
    token_usage: list[dict[str, Any]]
    residual_risks: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "thread_id": self.thread_id,
            "plan_version": self.plan_version,
            "what_this_thread_did": list(self.what_this_thread_did),
            "files_changed": [_jsonable_dict(item) for item in self.files_changed],
            "rubric_results": [_jsonable_dict(item) for item in self.rubric_results],
            "token_usage": [_jsonable_dict(item) for item in self.token_usage],
            "residual_risks": list(self.residual_risks),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ThreadCompletionReport:
        return cls(
            status=str(payload.get("status") or ""),
            thread_id=str(payload.get("thread_id") or ""),
            plan_version=_int(payload.get("plan_version"), default=0),
            what_this_thread_did=_str_list(payload.get("what_this_thread_did")),
            files_changed=[_jsonable_dict(item) for item in payload.get("files_changed") or [] if isinstance(item, dict)],
            rubric_results=[_jsonable_dict(item) for item in payload.get("rubric_results") or [] if isinstance(item, dict)],
            token_usage=[_jsonable_dict(item) for item in payload.get("token_usage") or [] if isinstance(item, dict)],
            residual_risks=_str_list(payload.get("residual_risks")),
        )


@dataclass(frozen=True)
class CanonicalAgentEvent:
    event_type: CanonicalAgentEventType
    run_id: str
    turn_id: str
    work_item_id: str | None = None
    summary: str = ""
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.event_type.value,
            "run_id": self.run_id,
            "turn_id": self.turn_id,
            "work_item_id": self.work_item_id,
            "summary": self.summary,
            "payload": _jsonable_dict(self.payload),
        }


class ManagedRunPlanValidator:
    def validate(self, plan: ManagedRunPlan) -> list[ManagedRunPlanValidatorError]:
        errors: list[ManagedRunPlanValidatorError] = []
        if not plan.verification_rubric.is_complete():
            errors.append(ManagedRunPlanValidatorError.INCOMPLETE_RUBRIC)
        ids = [item.id for item in plan.work_items]
        id_set = set(ids)
        if len(ids) != len(id_set):
            errors.append(ManagedRunPlanValidatorError.DUPLICATE_WORK_ITEM_ID)
        edges: list[tuple[str, str]] = []
        for item in plan.work_items:
            errors.extend(self._validate_item(item))
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
    first = str(title or "").strip().split(" ", 1)[0].lower().strip(":-")
    return first in {
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


def _looks_like_shell_command(command: str) -> bool:
    first = str(command or "").strip().split(" ", 1)[0].lower()
    basename = first.rsplit("/", 1)[-1]
    if basename in {"python", "python3"}:
        return True
    return first.startswith("./") or first in {
        "bash",
        "git",
        "make",
        "mypy",
        "npm",
        "pnpm",
        "pytest",
        "python",
        "python3",
        "ruff",
        "sh",
        "tox",
        "uv",
        "yarn",
    }


def render_run_summary_block(report: ThreadCompletionReport) -> str:
    lines = [
        RUN_SUMMARY_START,
        "## Symphony Managed Run Summary",
        "",
        f"Status: {report.status}",
        f"Thread: {report.thread_id}",
        f"Plan version: {report.plan_version}",
        "",
        "### What This Thread Did",
    ]
    lines.extend(f"- {item}" for item in report.what_this_thread_did)
    lines.extend(["", "### Files Changed"])
    if report.files_changed:
        lines.extend(["| File | Action | Work Item | Reason |", "|---|---|---|---|"])
        for item in report.files_changed:
            lines.append(
                "| `{}` | {} | {} | {} |".format(
                    item.get("path", ""),
                    item.get("action", ""),
                    item.get("work_item_id", ""),
                    item.get("reason", ""),
                )
            )
    else:
        lines.append("- None.")
    lines.extend(["", "### Verification Rubric"])
    if report.rubric_results:
        lines.extend(["| Area | Result | Evidence |", "|---|---|---|"])
        for item in report.rubric_results:
            evidence = ", ".join(_str_list(item.get("evidence")))
            lines.append(f"| {item.get('area', '')} | {item.get('status', '')} | {evidence} |")
    else:
        lines.append("- No rubric results recorded.")
    lines.extend(["", "### Token Usage"])
    if report.token_usage:
        lines.extend(["| Turn | Input | Cached Input | Output | Reasoning Output |", "|---|---:|---:|---:|---:|"])
        for usage in report.token_usage:
            lines.append(
                "| {} | {} | {} | {} | {} |".format(
                    usage.get("turn", ""),
                    usage.get("input_tokens", 0),
                    usage.get("cached_input_tokens", 0),
                    usage.get("output_tokens", 0),
                    usage.get("reasoning_output_tokens", 0),
                )
            )
    else:
        lines.append("- Unavailable.")
    lines.extend(["", "### Residual Risks"])
    lines.extend(f"- {risk}" for risk in (report.residual_risks or ["None identified."]))
    lines.append(RUN_SUMMARY_END)
    return "\n".join(lines)


def replace_managed_run_summary_block(description: str, report: ThreadCompletionReport) -> str:
    block = render_run_summary_block(report)
    start = description.find(RUN_SUMMARY_START)
    end = description.find(RUN_SUMMARY_END)
    if start >= 0 and end >= start:
        return description[:start] + block + description[end + len(RUN_SUMMARY_END):]
    separator = "\n\n" if description.strip() else ""
    return f"{description.rstrip()}{separator}{block}"


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None and str(item)]


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    return _int(value, default=0)


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _jsonable_dict(value: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _enum(enum: type[StrEnum], value: Any, default: Any) -> Any:
    if isinstance(value, enum):
        return value
    try:
        return enum(str(value))
    except ValueError:
        return default


def _runtime_role(value: Any) -> ManagedRunRuntimeRole:
    try:
        return ManagedRunRuntimeRole(str(value))
    except ValueError:
        return ManagedRunRuntimeRole.PLAN


def sanitize_profile_settings(settings: dict[str, Any]) -> dict[str, Any]:
    sanitized = _jsonable_dict(settings)
    for key in list(sanitized):
        lowered = str(key).lower()
        if lowered in SECRET_SETTING_KEYS or any(marker in lowered for marker in ("token", "secret", "password", "cookie", "api_key", "apikey")):
            sanitized[key] = "$REDACTED"
    return sanitized


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
