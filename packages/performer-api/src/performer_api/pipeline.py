from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shlex
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4


PASS_THRESHOLD = 3
RUBRIC_SCORES = {"0", "1", "2", "3", "4"}
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

class RuntimeMode(StrEnum):
    PLAN = "plan"
    EXECUTE = "execute"
    VERIFY = "verify"


RUNTIME_BACKENDS_BY_MODE = {
    RuntimeMode.PLAN: {"codex"},
    RuntimeMode.EXECUTE: {"codex"},
    RuntimeMode.VERIFY: {"codex", "local-verifier"},
}


class GraphNodeState(StrEnum):
    PLANNED = "planned"
    READY = "ready"
    EXECUTING = "executing"
    EXECUTE_FAILED = "execute_failed"
    VERIFYING = "verifying"
    VERIFY_PASSED = "verify_passed"
    VERIFY_FAILED = "verify_failed"
    REWORKING = "reworking"
    REPLANNING = "replanning"
    SUPERSEDED = "superseded"
    AWAITING_HUMAN = "awaiting_human"
    FAILED = "failed"


class AttemptState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


class HumanEscalationReason(StrEnum):
    PLAN_INVALID = "PLAN_INVALID"
    GATE_UNEXECUTABLE = "GATE_UNEXECUTABLE"
    LINEAR_SYNC_CONFLICT = "LINEAR_SYNC_CONFLICT"
    CREDENTIAL_REQUIRED = "CREDENTIAL_REQUIRED"
    REPLAN_LIMIT_EXCEEDED = "REPLAN_LIMIT_EXCEEDED"
    BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
    CAPACITY_STARVED = "CAPACITY_STARVED"


class DependencySatisfactionPolicy(StrEnum):
    TERMINAL_SUCCESS = "terminal_success"
    VERIFY_PASSED = "verify_passed"


class PlanValidatorError(StrEnum):
    MISSING_GATE = "missing_gate"
    GATE_UNEXECUTABLE = "gate_unexecutable"
    INCOMPLETE_RUBRIC = "incomplete_rubric"
    LOWERED_THRESHOLD = "lowered_threshold"
    CYCLE_DETECTED = "cycle_detected"
    ILLEGAL_EDGE = "illegal_edge"
    MISSING_ENTRY_EXIT = "missing_entry_exit"
    POLICY_LIMIT_EXCEEDED = "policy_limit_exceeded"
    EXECUTOR_ONLY_GATE_DEPENDENCY = "executor_only_gate_dependency"
    VERIFIER_CREDENTIAL_UNAVAILABLE = "verifier_credential_unavailable"
    NO_AUTHORITATIVE_GATE_STEP = "no_authoritative_gate_step"
    INVALID_GATE_STEP_SOURCE = "invalid_gate_step_source"
    REQUIRED_PARALLEL_SHAPE_MISSING = "required_parallel_shape_missing"


class GateStepSource(StrEnum):
    ISSUE_REQUIREMENT = "issue_requirement"
    APPENDIX_HARNESS = "appendix_harness"
    PLANNER_INFERRED = "planner_inferred"
    SYSTEM_REPAIR = "system_repair"


class GateStep(str):
    source: GateStepSource | str

    def __new__(
        cls,
        step: str,
        source: GateStepSource | str = GateStepSource.PLANNER_INFERRED,
    ) -> GateStep:
        obj = str.__new__(cls, step)
        try:
            obj.source = source if isinstance(source, GateStepSource) else GateStepSource(str(source))
        except ValueError:
            obj.source = str(source)
        return obj

    @property
    def step(self) -> str:
        return str(self)

    @property
    def has_valid_source(self) -> bool:
        return isinstance(self.source, GateStepSource)

    @property
    def is_authoritative(self) -> bool:
        return self.has_valid_source and self.source is not GateStepSource.PLANNER_INFERRED

    def to_dict(self) -> dict[str, str]:
        source = self.source.value if isinstance(self.source, GateStepSource) else str(self.source)
        return {"step": str(self), "source": source}

    @classmethod
    def from_obj(cls, value: Any) -> GateStep:
        if isinstance(value, GateStep):
            return value
        if isinstance(value, dict):
            return cls(str(value.get("step") or ""), str(value.get("source") or GateStepSource.PLANNER_INFERRED.value))
        return cls(str(value), GateStepSource.PLANNER_INFERRED)


@dataclass(frozen=True)
class IntentSpec:
    issue_id: str
    issue_identifier: str
    issue_description: str
    required_gate_steps: list[GateStep] = field(default_factory=list)
    requires_all_parallel_branches_for_downstream: bool = False

    @classmethod
    def from_issue(
        cls,
        *,
        issue_id: str,
        issue_identifier: str,
        issue_description: str,
    ) -> IntentSpec:
        return cls(
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            issue_description=issue_description,
            required_gate_steps=[
                GateStep(step, GateStepSource.ISSUE_REQUIREMENT)
                for step in _required_gate_commands_from_issue(issue_description, issue_identifier=issue_identifier)
            ],
            requires_all_parallel_branches_for_downstream=bool(
                _BOTH_PARALLEL_DOWNSTREAM_PATTERN.search(issue_description)
            ),
        )


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    backend: str
    mode: RuntimeMode
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "mode": self.mode.value,
            "settings": _jsonable_dict(self.settings),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeProfile:
        return cls(
            name=str(payload.get("name") or ""),
            backend=str(payload.get("backend") or ""),
            mode=_mode(payload.get("mode")),
            settings=_dict(payload.get("settings")),
        )

    def sanitized(self) -> RuntimeProfile:
        return replace(self, settings=sanitize_profile_settings(self.settings))


@dataclass(frozen=True)
class SchedulerCapacity:
    global_limit: int | None = None
    by_mode: dict[RuntimeMode, int | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "global": self.global_limit,
            "by_mode": {mode.value: limit for mode, limit in sorted(self.by_mode.items(), key=lambda item: item[0].value)},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> SchedulerCapacity:
        by_mode_payload = payload.get("by_mode")
        by_mode: dict[RuntimeMode, int | None] = {}
        if isinstance(by_mode_payload, dict):
            for mode, limit in by_mode_payload.items():
                by_mode[_mode(mode)] = _optional_int(limit)
        return cls(global_limit=_optional_int(payload.get("global")), by_mode=by_mode)

    def remaining_for_mode(
        self,
        mode: RuntimeMode,
        *,
        active_global: int,
        active_by_mode: dict[RuntimeMode, int],
    ) -> int | None:
        available_global = None if self.global_limit is None else max(0, self.global_limit - active_global)
        mode_limit = self.by_mode.get(mode)
        if mode_limit is None:
            return available_global
        available_mode = max(0, mode_limit - int(active_by_mode.get(mode, 0)))
        if available_global is None:
            return available_mode
        return min(available_global, available_mode)


@dataclass(frozen=True)
class SchedulerPolicy:
    policy_id: str
    version: int
    effective_at: str
    capacity: SchedulerCapacity
    dependency_policy: DependencySatisfactionPolicy = DependencySatisfactionPolicy.VERIFY_PASSED
    max_rework_attempts: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "effective_at": self.effective_at,
            "capacity": self.capacity.to_dict(),
            "dependency_policy": self.dependency_policy.value,
            "max_rework_attempts": self.max_rework_attempts,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> SchedulerPolicy:
        return cls(
            policy_id=str(payload.get("policy_id") or ""),
            version=_int(payload.get("version"), default=0),
            effective_at=str(payload.get("effective_at") or ""),
            capacity=SchedulerCapacity.from_dict(_dict(payload.get("capacity"))),
            dependency_policy=DependencySatisfactionPolicy(
                str(payload.get("dependency_policy") or DependencySatisfactionPolicy.VERIFY_PASSED.value)
            ),
            max_rework_attempts=_int(payload.get("max_rework_attempts"), default=3),
        )

    def accepts_update(self, candidate: SchedulerPolicy) -> bool:
        return candidate.version > self.version

    def remaining_for_mode(
        self,
        mode: RuntimeMode,
        *,
        active_global: int,
        active_by_mode: dict[RuntimeMode, int],
    ) -> int | None:
        return self.capacity.remaining_for_mode(mode, active_global=active_global, active_by_mode=active_by_mode)

    def with_version(self, version: int) -> SchedulerPolicy:
        return replace(self, version=version)


@dataclass(frozen=True)
class RuntimeConfigEnvelope:
    runtime_group_id: str
    version: int
    scheduler_policy: SchedulerPolicy
    profiles: dict[RuntimeMode, RuntimeProfile] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_group_id": self.runtime_group_id,
            "version": self.version,
            "scheduler_policy": self.scheduler_policy.to_dict(),
            "profiles": {mode.value: profile.to_dict() for mode, profile in self.profiles.items()},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfigEnvelope:
        profiles_payload = payload.get("profiles")
        profiles: dict[RuntimeMode, RuntimeProfile] = {}
        if isinstance(profiles_payload, dict):
            for mode, profile_payload in profiles_payload.items():
                if isinstance(profile_payload, dict):
                    profiles[_mode(mode)] = RuntimeProfile.from_dict({**profile_payload, "mode": profile_payload.get("mode") or mode})
        return cls(
            runtime_group_id=str(payload.get("runtime_group_id") or ""),
            version=_int(payload.get("version"), default=0),
            scheduler_policy=SchedulerPolicy.from_dict(_dict(payload.get("scheduler_policy"))),
            profiles=profiles,
        )

    def sanitized(self) -> RuntimeConfigEnvelope:
        return replace(self, profiles={mode: profile.sanitized() for mode, profile in self.profiles.items()})

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.runtime_group_id.strip():
            errors.append("runtime_group_id_required")
        if self.version <= 0:
            errors.append("version_required")
        policy = self.scheduler_policy
        if not policy.policy_id.strip():
            errors.append("scheduler_policy_id_required")
        if policy.version <= 0:
            errors.append("scheduler_policy_version_required")
        if policy.version != self.version:
            errors.append("scheduler_policy_version_mismatch")
        if not policy.effective_at.strip():
            errors.append("scheduler_policy_effective_at_required")
        if policy.max_rework_attempts <= 0:
            errors.append("max_rework_attempts_required")
        if policy.capacity.global_limit is not None and policy.capacity.global_limit < 0:
            errors.append("capacity_global_invalid")
        for mode, limit in policy.capacity.by_mode.items():
            if mode not in set(RuntimeMode):
                errors.append("capacity_mode_invalid")
            if limit is not None and limit < 0:
                errors.append(f"capacity_{mode.value}_invalid")
        required_modes = set(RuntimeMode)
        if set(self.profiles) != required_modes:
            missing = sorted(mode.value for mode in required_modes - set(self.profiles))
            extra = sorted(str(mode) for mode in set(self.profiles) - required_modes)
            if missing:
                errors.append(f"runtime_profiles_missing:{','.join(missing)}")
            if extra:
                errors.append(f"runtime_profiles_unknown:{','.join(extra)}")
        for mode, profile in self.profiles.items():
            if profile.mode is not mode:
                errors.append(f"runtime_profile_mode_mismatch:{mode.value}")
            if not profile.name.strip():
                errors.append(f"runtime_profile_name_required:{mode.value}")
            if not profile.backend.strip():
                errors.append(f"runtime_profile_backend_required:{mode.value}")
            elif profile.backend not in RUNTIME_BACKENDS_BY_MODE.get(mode, set()):
                errors.append(f"runtime_profile_backend_unsupported:{mode.value}:{profile.backend}")
        return errors

    def validate(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError("invalid runtime config: " + ", ".join(errors))


@dataclass(frozen=True)
class GraphNode:
    node_id: str
    title: str
    state: GraphNodeState
    issue_id: str | None = None
    issue_identifier: str | None = None
    parent_node_id: str | None = None
    gate_snapshot_hash: str | None = None
    verify_score: int | None = None
    rework_count: int = 0
    superseded_by: list[str] = field(default_factory=list)
    human_reason: HumanEscalationReason | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "title": self.title,
            "state": self.state.value,
            "issue_id": self.issue_id,
            "issue_identifier": self.issue_identifier,
            "parent_node_id": self.parent_node_id,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "verify_score": self.verify_score,
            "rework_count": self.rework_count,
            "superseded_by": list(self.superseded_by),
            "human_reason": self.human_reason.value if self.human_reason is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GraphNode:
        reason = payload.get("human_reason")
        return cls(
            node_id=str(payload.get("node_id") or ""),
            title=str(payload.get("title") or ""),
            state=GraphNodeState(str(payload.get("state") or GraphNodeState.PLANNED.value)),
            issue_id=_optional_str(payload.get("issue_id")),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            parent_node_id=_optional_str(payload.get("parent_node_id")),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            verify_score=_optional_int(payload.get("verify_score")),
            rework_count=_int(payload.get("rework_count"), default=0),
            superseded_by=_str_list(payload.get("superseded_by")),
            human_reason=HumanEscalationReason(str(reason)) if reason else None,
        )


@dataclass(frozen=True)
class GateSpecContent:
    acceptance_criteria: list[str]
    verification_procedure: list[GateStep | str | dict[str, Any]]
    rubric: dict[str, str]
    pass_threshold: int = PASS_THRESHOLD
    verifier_credentials: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.pass_threshold != PASS_THRESHOLD:
            raise ValueError(f"pass_threshold must be {PASS_THRESHOLD}")
        object.__setattr__(
            self,
            "verification_procedure",
            [GateStep.from_obj(step) for step in self.verification_procedure if step is not None],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification_procedure": [step.to_dict() for step in self.verification_procedure],
            "rubric": dict(sorted(self.rubric.items())),
            "pass_threshold": self.pass_threshold,
            "verifier_credentials": list(self.verifier_credentials),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecContent:
        return cls(
            acceptance_criteria=_str_list(payload.get("acceptance_criteria")),
            verification_procedure=_gate_steps(payload.get("verification_procedure")),
            rubric={str(key): str(value) for key, value in _dict(payload.get("rubric")).items()},
            pass_threshold=_int(payload.get("pass_threshold"), default=PASS_THRESHOLD),
            verifier_credentials=_str_list(payload.get("verifier_credentials")),
        )


@dataclass(frozen=True)
class GateSpecSnapshot:
    gate_id: str
    task_id: str
    version: int
    created_by: str
    created_at: str
    content: GateSpecContent
    hash: str
    frozen: bool = True

    @classmethod
    def create(
        cls,
        *,
        gate_id: str,
        task_id: str,
        created_by: str,
        created_at: str,
        content: GateSpecContent,
        version: int = 1,
    ) -> GateSpecSnapshot:
        return cls(
            gate_id=gate_id,
            task_id=task_id,
            version=version,
            created_by=created_by,
            created_at=created_at,
            content=content,
            hash=canonical_gate_hash(content),
            frozen=True,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "task_id": self.task_id,
            "version": self.version,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "content": self.content.to_dict(),
            "hash": self.hash,
            "frozen": self.frozen,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecSnapshot:
        content = GateSpecContent.from_dict(_dict(payload.get("content")))
        gate_hash = str(payload.get("hash") or canonical_gate_hash(content))
        expected = canonical_gate_hash(content)
        if gate_hash != expected:
            raise ValueError("gate hash does not match canonical content")
        return cls(
            gate_id=str(payload.get("gate_id") or ""),
            task_id=str(payload.get("task_id") or ""),
            version=_int(payload.get("version"), default=1),
            created_by=str(payload.get("created_by") or ""),
            created_at=str(payload.get("created_at") or ""),
            content=content,
            hash=gate_hash,
            frozen=bool(payload.get("frozen", True)),
        )


@dataclass(frozen=True)
class AttemptRecord:
    attempt_id: str
    node_id: str
    mode: RuntimeMode
    state: AttemptState
    graph_revision: int = 0
    policy_revision: int = 0
    lease_id: str = ""
    fencing_token: str = ""
    gate_snapshot_hash: str | None = None
    score: int | None = None
    started_at: str | None = None
    completed_at: str | None = None
    result_uri: str | None = None
    error: str | None = None
    process_pid: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "state": self.state.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "result_uri": self.result_uri,
            "error": self.error,
            "process_pid": self.process_pid,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AttemptRecord:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            mode=_mode(payload.get("mode")),
            state=AttemptState(str(payload.get("state") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            score=_optional_int(payload.get("score")),
            started_at=_optional_str(payload.get("started_at")),
            completed_at=_optional_str(payload.get("completed_at")),
            result_uri=_optional_str(payload.get("result_uri")),
            error=_optional_str(payload.get("error")),
            process_pid=_optional_int(payload.get("process_pid")),
        )


@dataclass(frozen=True)
class AttemptSummary:
    attempt_id: str
    node_id: str
    mode: RuntimeMode
    status: AttemptState
    graph_revision: int
    policy_revision: int
    gate_snapshot_hash: str | None = None
    score: int | None = None
    result_uri: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "status": self.status.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "result_uri": self.result_uri,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AttemptSummary:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            mode=_mode(payload.get("mode")),
            status=AttemptState(str(payload.get("status") or payload.get("state") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            score=_optional_int(payload.get("score")),
            result_uri=_optional_str(payload.get("result_uri")),
            error=_optional_str(payload.get("error")),
        )


@dataclass(frozen=True)
class FencedAttemptResult:
    attempt_id: str
    node_id: str
    status: AttemptState
    graph_revision: int
    policy_revision: int
    gate_snapshot_hash: str
    lease_id: str
    fencing_token: str
    error: str | None = None

    mode: RuntimeMode = RuntimeMode.EXECUTE

    def _base_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "mode": self.mode.value,
            "status": self.status.value,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "error": self.error,
        }


@dataclass(frozen=True)
class PlanAttemptRequest:
    attempt_id: str
    graph_id: str
    root_node_id: str
    node_id: str
    issue_id: str
    issue_identifier: str | None
    title: str
    graph_revision: int
    policy_revision: int
    lease_id: str
    fencing_token: str
    workspace_path: str
    issue_description: str = ""
    failure_context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanAttemptRequest:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            graph_id=str(payload.get("graph_id") or ""),
            root_node_id=str(payload.get("root_node_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            title=str(payload.get("title") or ""),
            issue_description=str(payload.get("issue_description") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            workspace_path=str(payload.get("workspace_path") or ""),
            failure_context=_dict(payload.get("failure_context")),
        )


@dataclass(frozen=True)
class PlanAttemptResult(FencedAttemptResult):
    proposal: PlanProposal | None = None
    mode: RuntimeMode = RuntimeMode.PLAN

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload["proposal"] = self.proposal.to_dict() if self.proposal is not None else None
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanAttemptResult:
        proposal_payload = payload.get("proposal")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            proposal=PlanProposal.from_dict(proposal_payload) if isinstance(proposal_payload, dict) else None,
        )


@dataclass(frozen=True)
class ExecuteAttemptRequest:
    attempt_id: str
    node_id: str
    graph_revision: int
    policy_revision: int
    gate_snapshot: GateSpecSnapshot
    lease_id: str
    fencing_token: str
    task_title: str = ""
    issue_identifier: str | None = None
    issue_description: str = ""
    base_revision: str = ""
    repository: dict[str, Any] = field(default_factory=dict)
    artifact_paths: dict[str, Any] = field(default_factory=dict)
    upstream_manifests: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot": self.gate_snapshot.to_dict(),
            "gate_snapshot_hash": self.gate_snapshot.hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "task_title": self.task_title,
            "issue_identifier": self.issue_identifier,
            "issue_description": self.issue_description,
            "base_revision": self.base_revision,
            "repository": _jsonable_dict(self.repository),
            "artifact_paths": _jsonable_dict(self.artifact_paths),
            "upstream_manifests": [_jsonable_dict(manifest) for manifest in self.upstream_manifests],
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecuteAttemptRequest:
        gate_payload = payload.get("gate_snapshot")
        if not isinstance(gate_payload, dict):
            raise ValueError("execute attempt request requires gate_snapshot")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot=GateSpecSnapshot.from_dict(gate_payload),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            task_title=str(payload.get("task_title") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            issue_description=str(payload.get("issue_description") or ""),
            base_revision=str(payload.get("base_revision") or ""),
            repository=_dict(payload.get("repository")),
            artifact_paths=_dict(payload.get("artifact_paths")),
            upstream_manifests=[_dict(item) for item in payload.get("upstream_manifests") or [] if isinstance(item, dict)],
            reason=_optional_str(payload.get("reason")),
        )


@dataclass(frozen=True)
class ExecuteAttemptResult(FencedAttemptResult):
    verification_input: dict[str, Any] | None = None
    mode: RuntimeMode = RuntimeMode.EXECUTE

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload["verification_input"] = _jsonable_dict(self.verification_input or {})
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecuteAttemptResult:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            verification_input=_dict(payload.get("verification_input")),
        )


@dataclass(frozen=True)
class VerifyAttemptRequest:
    attempt_id: str
    node_id: str
    execute_attempt_id: str
    graph_revision: int
    policy_revision: int
    gate_snapshot: GateSpecSnapshot
    lease_id: str
    fencing_token: str
    verification_input: dict[str, Any]
    artifact_paths: dict[str, Any] = field(default_factory=dict)
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "node_id": self.node_id,
            "execute_attempt_id": self.execute_attempt_id,
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "gate_snapshot": self.gate_snapshot.to_dict(),
            "gate_snapshot_hash": self.gate_snapshot.hash,
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "verification_input": _jsonable_dict(self.verification_input),
            "artifact_paths": _jsonable_dict(self.artifact_paths),
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerifyAttemptRequest:
        gate_payload = payload.get("gate_snapshot")
        if not isinstance(gate_payload, dict):
            raise ValueError("verify attempt request requires gate_snapshot")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot=GateSpecSnapshot.from_dict(gate_payload),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            verification_input=_dict(payload.get("verification_input")),
            artifact_paths=_dict(payload.get("artifact_paths")),
            reason=_optional_str(payload.get("reason")),
        )


@dataclass(frozen=True)
class VerifyAttemptResult(FencedAttemptResult):
    score: int = 0
    passed: bool = False
    execute_attempt_id: str = ""
    mode: RuntimeMode = RuntimeMode.VERIFY

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload.update({"score": self.score, "passed": self.passed, "execute_attempt_id": self.execute_attempt_id})
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerifyAttemptResult:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            score=_int(payload.get("score"), default=0),
            passed=bool(payload.get("passed")),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
        )


@dataclass(frozen=True)
class VerificationInputSnapshot:
    task_id: str
    execute_attempt_id: str
    base_revision: str
    patch_uri: str
    patch_hash: str
    expected_result_tree: str
    artifact_uris: list[dict[str, Any]]
    declared_commands: list[str]
    evidence_uri: str
    gate_snapshot_hash: str
    repository_path: str = ""
    workspace_path: str = ""
    result_revision: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerificationInputSnapshot:
        return cls(
            task_id=str(payload.get("task_id") or ""),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
            base_revision=str(payload.get("base_revision") or ""),
            patch_uri=str(payload.get("patch_uri") or ""),
            patch_hash=str(payload.get("patch_hash") or ""),
            expected_result_tree=str(payload.get("expected_result_tree") or ""),
            artifact_uris=[_dict(item) for item in payload.get("artifact_uris") or [] if isinstance(item, dict)],
            declared_commands=_str_list(payload.get("declared_commands")),
            evidence_uri=str(payload.get("evidence_uri") or ""),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            repository_path=str(payload.get("repository_path") or ""),
            workspace_path=str(payload.get("workspace_path") or ""),
            result_revision=_optional_str(payload.get("result_revision")),
        )


@dataclass(frozen=True)
class TaskOutputManifest:
    node_id: str
    verify_attempt_id: str
    gate_snapshot_hash: str
    score: int
    code: dict[str, Any]
    artifacts: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.score < PASS_THRESHOLD:
            raise ValueError(f"task output manifests require score >= {PASS_THRESHOLD}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "verify_attempt_id": self.verify_attempt_id,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "score": self.score,
            "code": _jsonable_dict(self.code),
            "artifacts": [_jsonable_dict(artifact) for artifact in self.artifacts],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TaskOutputManifest:
        return cls(
            node_id=str(payload.get("node_id") or ""),
            verify_attempt_id=str(payload.get("verify_attempt_id") or ""),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            score=_int(payload.get("score"), default=0),
            code=_dict(payload.get("code")),
            artifacts=[_dict(item) for item in payload.get("artifacts") or [] if isinstance(item, dict)],
        )


@dataclass(frozen=True)
class PlanProposal:
    graph_id: str
    plan_attempt_id: str
    root_node_id: str
    nodes: list[GraphNode]
    blocks: list[tuple[str, str]]
    gates: list[GateSpecSnapshot]
    entry_node_ids: list[str]
    exit_node_ids: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "graph_id": self.graph_id,
            "plan_attempt_id": self.plan_attempt_id,
            "root_node_id": self.root_node_id,
            "nodes": [node.to_dict() for node in self.nodes],
            "blocks": [[source, target] for source, target in self.blocks],
            "gates": [gate.to_dict() for gate in self.gates],
            "entry_node_ids": list(self.entry_node_ids),
            "exit_node_ids": list(self.exit_node_ids),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanProposal:
        blocks: list[tuple[str, str]] = []
        for edge in payload.get("blocks") or []:
            if isinstance(edge, (list, tuple)) and len(edge) == 2:
                blocks.append((str(edge[0]), str(edge[1])))
        return cls(
            graph_id=str(payload.get("graph_id") or ""),
            plan_attempt_id=str(payload.get("plan_attempt_id") or ""),
            root_node_id=str(payload.get("root_node_id") or ""),
            nodes=[GraphNode.from_dict(item) for item in payload.get("nodes") or [] if isinstance(item, dict)],
            blocks=blocks,
            gates=[GateSpecSnapshot.from_dict(item) for item in payload.get("gates") or [] if isinstance(item, dict)],
            entry_node_ids=_str_list(payload.get("entry_node_ids")),
            exit_node_ids=_str_list(payload.get("exit_node_ids")),
        )


class PlanRepair:
    def __init__(self, intent_spec: IntentSpec):
        self.intent_spec = intent_spec

    def repair(self, proposal: PlanProposal) -> PlanProposal:
        next_blocks = self._repair_parallel_dependency_shape(proposal)
        normalized_gate_content = self._normalized_gate_content(proposal)
        target_node_ids = set(proposal.exit_node_ids or [node.node_id for node in proposal.nodes])
        next_gates: list[GateSpecSnapshot] = []
        changed_hash_by_task: dict[str, str] = {}
        for gate in proposal.gates:
            existing_content = normalized_gate_content.get(gate.task_id) or gate.content
            missing_required_steps = (
                [step for step in self.intent_spec.required_gate_steps if step not in existing_content.verification_procedure]
                if gate.task_id in target_node_ids
                else []
            )
            if not missing_required_steps and existing_content is gate.content:
                next_gates.append(gate)
                continue
            content = GateSpecContent(
                acceptance_criteria=[
                    *existing_content.acceptance_criteria,
                    *[
                        f"Preserve issue requirement verified by `{step.step}`."
                        for step in missing_required_steps
                    ],
                ],
                verification_procedure=[*existing_content.verification_procedure, *missing_required_steps],
                rubric=dict(existing_content.rubric),
                pass_threshold=existing_content.pass_threshold,
                verifier_credentials=list(existing_content.verifier_credentials),
            )
            updated = GateSpecSnapshot.create(
                gate_id=gate.gate_id,
                task_id=gate.task_id,
                created_by=gate.created_by or proposal.plan_attempt_id,
                created_at=gate.created_at,
                content=content,
                version=gate.version,
            )
            next_gates.append(updated)
            changed_hash_by_task[updated.task_id] = updated.hash
        blocks_changed = next_blocks != list(proposal.blocks)
        if not changed_hash_by_task and not blocks_changed:
            return proposal
        next_nodes = [
            replace(node, gate_snapshot_hash=changed_hash_by_task[node.node_id])
            if node.node_id in changed_hash_by_task
            else node
            for node in proposal.nodes
        ]
        entry_node_ids, exit_node_ids = (
            _entry_exit_node_ids_for_blocks(next_nodes, next_blocks)
            if blocks_changed
            else (list(proposal.entry_node_ids), list(proposal.exit_node_ids))
        )
        return PlanProposal(
            graph_id=proposal.graph_id,
            plan_attempt_id=proposal.plan_attempt_id,
            root_node_id=proposal.root_node_id,
            nodes=next_nodes,
            blocks=next_blocks,
            gates=next_gates,
            entry_node_ids=entry_node_ids,
            exit_node_ids=exit_node_ids,
        )

    def _repair_parallel_dependency_shape(self, proposal: PlanProposal) -> list[tuple[str, str]]:
        if not self.intent_spec.requires_all_parallel_branches_for_downstream:
            return list(proposal.blocks)
        required_edges = _required_parallel_dependency_edges(proposal)
        if not required_edges:
            return list(proposal.blocks)
        next_blocks = list(dict.fromkeys(proposal.blocks))
        next_block_set = set(next_blocks)
        for edge in required_edges:
            if edge not in next_block_set:
                next_blocks.append(edge)
                next_block_set.add(edge)
        return next_blocks

    def _normalized_gate_content(self, proposal: PlanProposal) -> dict[str, GateSpecContent]:
        if not _issue_requests_shared_conflict_file(self.intent_spec.issue_description):
            return {}
        normalized: dict[str, GateSpecContent] = {}
        node_labels = {node.node_id: f"{node.node_id} {node.title}".lower() for node in proposal.nodes}
        for gate in proposal.gates:
            label = node_labels.get(gate.task_id, gate.task_id.lower())
            commands = list(gate.content.verification_procedure)
            if _SHARED_CONFLICT_FILE not in " ".join(str(command) for command in commands) and "parallel" not in label:
                continue
            exact_text_commands = [
                command
                for command in commands
                if _SHARED_CONFLICT_FILE in command
                and ("grep -q" in command or command.startswith("git diff -- "))
                and command.step not in self.intent_spec.issue_description
            ]
            if not exact_text_commands:
                continue
            next_commands = [command for command in commands if command not in exact_text_commands]
            for command in (
                f"test -f {_SHARED_CONFLICT_FILE}",
                f'test -n "$(git diff -- {_SHARED_CONFLICT_FILE})"',
            ):
                repair_step = GateStep(command, GateStepSource.SYSTEM_REPAIR)
                if repair_step not in next_commands:
                    next_commands.append(repair_step)
            normalized[gate.task_id] = GateSpecContent(
                acceptance_criteria=[
                    criterion
                    for criterion in gate.content.acceptance_criteria
                    if not ("exact marker" in criterion.lower() and _SHARED_CONFLICT_FILE not in self.intent_spec.issue_description)
                ],
                verification_procedure=next_commands,
                rubric=dict(gate.content.rubric),
                pass_threshold=gate.content.pass_threshold,
                verifier_credentials=list(gate.content.verifier_credentials),
            )
        return normalized


@dataclass(frozen=True)
class WorkerLease:
    lease_id: str
    fencing_token: str
    mode: RuntimeMode
    node_id: str
    attempt_id: str
    acquired_at: str
    heartbeat_at: str
    expires_at: str

    @classmethod
    def create(
        cls,
        *,
        lease_id: str,
        mode: RuntimeMode,
        node_id: str,
        attempt_id: str,
        acquired_at: datetime,
        ttl_seconds: int,
    ) -> WorkerLease:
        acquired = _utc(acquired_at)
        expires = acquired + timedelta(seconds=ttl_seconds)
        return cls(
            lease_id=lease_id,
            fencing_token=uuid4().hex,
            mode=mode,
            node_id=node_id,
            attempt_id=attempt_id,
            acquired_at=_format_time(acquired),
            heartbeat_at=_format_time(acquired),
            expires_at=_format_time(expires),
        )

    def is_active(self, at: datetime, *, fencing_token: str) -> bool:
        return self.fencing_token == fencing_token and _utc(at) <= _parse_time(self.expires_at)

    def to_dict(self) -> dict[str, Any]:
        return {
            "lease_id": self.lease_id,
            "fencing_token": self.fencing_token,
            "mode": self.mode.value,
            "node_id": self.node_id,
            "attempt_id": self.attempt_id,
            "acquired_at": self.acquired_at,
            "heartbeat_at": self.heartbeat_at,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> WorkerLease:
        return cls(
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            mode=_mode(payload.get("mode")),
            node_id=str(payload.get("node_id") or ""),
            attempt_id=str(payload.get("attempt_id") or ""),
            acquired_at=str(payload.get("acquired_at") or ""),
            heartbeat_at=str(payload.get("heartbeat_at") or ""),
            expires_at=str(payload.get("expires_at") or ""),
        )


@dataclass(frozen=True)
class PipelineModeView:
    mode: RuntimeMode
    active: int
    limit: int | None
    queued: int
    node_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode.value,
            "active": self.active,
            "limit": self.limit,
            "queued": self.queued,
            "node_ids": list(self.node_ids),
        }


@dataclass(frozen=True)
class PredictedCall:
    node_id: str
    predicted_position: int | None
    blocked_by: list[str]
    earliest_mode: RuntimeMode | None
    confidence: str = "conditional"
    aggregate_state: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "node": self.node_id,
            "predicted_position": self.predicted_position,
            "blocked_by": list(self.blocked_by),
            "earliest_mode": self.earliest_mode.value if self.earliest_mode is not None else None,
            "confidence": self.confidence,
            "aggregate_state": self.aggregate_state,
        }


@dataclass(frozen=True)
class PipelineView:
    graph_revision: int
    policy_revision: int
    nodes: list[dict[str, Any]]
    modes: list[PipelineModeView]
    predicted_call_order: list[PredictedCall]
    capacity: dict[str, Any] = field(default_factory=dict)
    blocks: list[tuple[str, str]] = field(default_factory=list)
    gates: list[dict[str, Any]] = field(default_factory=list)
    leases: list[dict[str, Any]] = field(default_factory=list)
    attempts: list[dict[str, Any]] = field(default_factory=list)
    integration_queue: list[dict[str, Any]] = field(default_factory=list)
    manifests: list[dict[str, Any]] = field(default_factory=list)
    human_waits: list[dict[str, Any]] = field(default_factory=list)
    runtime_waits: list[dict[str, Any]] = field(default_factory=list)
    linear_projections: list[dict[str, Any]] = field(default_factory=list)
    prediction_basis: dict[str, Any] = field(default_factory=dict)
    runtime_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "graph_revision": self.graph_revision,
            "policy_revision": self.policy_revision,
            "nodes": [_jsonable_dict(node) for node in self.nodes],
            "modes": [mode.to_dict() for mode in self.modes],
            "predicted_call_order": [call.to_dict() for call in self.predicted_call_order],
            "capacity": _jsonable_dict(self.capacity),
            "blocks": [[source, target] for source, target in self.blocks],
            "gates": [_jsonable_dict(gate) for gate in self.gates],
            "leases": [_jsonable_dict(lease) for lease in self.leases],
            "attempts": [_jsonable_dict(attempt) for attempt in self.attempts],
            "integration_queue": [_jsonable_dict(item) for item in self.integration_queue],
            "manifests": [_jsonable_dict(manifest) for manifest in self.manifests],
            "human_waits": [_jsonable_dict(wait) for wait in self.human_waits],
            "runtime_waits": [_jsonable_dict(wait) for wait in self.runtime_waits],
            "linear_projections": [_jsonable_dict(projection) for projection in self.linear_projections],
            "prediction_basis": _jsonable_dict(self.prediction_basis),
            "runtime_config": _jsonable_dict(self.runtime_config),
        }


class PlanValidator:
    def __init__(
        self,
        *,
        max_subtasks: int = 50,
        verifier_credentials: set[str] | None = None,
        intent_spec: IntentSpec | None = None,
    ):
        self.max_subtasks = max_subtasks
        self.verifier_credentials = set(verifier_credentials or set())
        self.intent_spec = intent_spec

    def validate(self, proposal: PlanProposal) -> set[PlanValidatorError]:
        errors: set[PlanValidatorError] = set()
        node_id_list = [node.node_id for node in proposal.nodes]
        node_ids = set(node_id_list)
        gate_task_list = [gate.task_id for gate in proposal.gates]
        gate_id_list = [gate.gate_id for gate in proposal.gates]
        gate_by_task = {gate.task_id: gate for gate in proposal.gates}
        if not node_ids:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        if len(node_id_list) != len(node_ids):
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if len(gate_task_list) != len(set(gate_task_list)) or len(gate_id_list) != len(set(gate_id_list)):
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if len(proposal.nodes) > self.max_subtasks:
            errors.add(PlanValidatorError.POLICY_LIMIT_EXCEEDED)
        if not proposal.entry_node_ids or not proposal.exit_node_ids:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        if not set(proposal.entry_node_ids).issubset(node_ids) or not set(proposal.exit_node_ids).issubset(node_ids):
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        legal_edges = [(source, target) for source, target in proposal.blocks if source in node_ids and target in node_ids and source != target]
        computed_entries = node_ids - {target for _source, target in legal_edges}
        computed_exits = node_ids - {source for source, _target in legal_edges}
        if set(proposal.entry_node_ids) != computed_entries or set(proposal.exit_node_ids) != computed_exits:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        for node in proposal.nodes:
            gate = gate_by_task.get(node.node_id)
            if gate is None or not node.gate_snapshot_hash:
                errors.add(PlanValidatorError.MISSING_GATE)
                continue
            if node.gate_snapshot_hash != gate.hash:
                errors.add(PlanValidatorError.MISSING_GATE)
            self._validate_gate(gate, errors)
        for source, target in proposal.blocks:
            if source not in node_ids or target not in node_ids or source == target:
                errors.add(PlanValidatorError.ILLEGAL_EDGE)
        parent_by_child = {node.node_id: node.parent_node_id for node in proposal.nodes if node.parent_node_id}
        for source, target in proposal.blocks:
            if parent_by_child.get(target) == source:
                errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if _has_cycle(node_ids, proposal.blocks):
            errors.add(PlanValidatorError.CYCLE_DETECTED)
        if self.intent_spec is not None and self.intent_spec.requires_all_parallel_branches_for_downstream:
            required_edges = set(_required_parallel_dependency_edges(proposal))
            if not required_edges.issubset(set(proposal.blocks)):
                errors.add(PlanValidatorError.REQUIRED_PARALLEL_SHAPE_MISSING)
        return errors

    def _validate_gate(self, gate: GateSpecSnapshot, errors: set[PlanValidatorError]) -> None:
        content = gate.content
        if not gate.frozen or gate.hash != canonical_gate_hash(content):
            errors.add(PlanValidatorError.MISSING_GATE)
        if not content.verification_procedure or not all(step.strip() for step in content.verification_procedure):
            errors.add(PlanValidatorError.GATE_UNEXECUTABLE)
        if any(not step.has_valid_source for step in content.verification_procedure):
            errors.add(PlanValidatorError.INVALID_GATE_STEP_SOURCE)
        if content.verification_procedure and not any(step.is_authoritative for step in content.verification_procedure):
            errors.add(PlanValidatorError.NO_AUTHORITATIVE_GATE_STEP)
        if set(content.rubric) != RUBRIC_SCORES or any(not str(value).strip() for value in content.rubric.values()):
            errors.add(PlanValidatorError.INCOMPLETE_RUBRIC)
        if content.pass_threshold != PASS_THRESHOLD:
            errors.add(PlanValidatorError.LOWERED_THRESHOLD)
        unavailable_credentials = set(content.verifier_credentials) - self.verifier_credentials
        if unavailable_credentials:
            errors.add(PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE)
        for step in content.verification_procedure:
            lowered = step.lower()
            if "executor workspace" in lowered or "$executor_" in lowered:
                errors.add(PlanValidatorError.EXECUTOR_ONLY_GATE_DEPENDENCY)
            if not _looks_like_executable_gate_command(step):
                errors.add(PlanValidatorError.GATE_UNEXECUTABLE)


def canonical_gate_hash(content: GateSpecContent | dict[str, Any]) -> str:
    payload = content.to_dict() if isinstance(content, GateSpecContent) else _jsonable_dict(content)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


_RELATIVE_FILE_PATTERN = re.compile(r"(?<![\w./-])([A-Za-z0-9][A-Za-z0-9_./-]*\.[A-Za-z0-9][A-Za-z0-9_-]*)(?![\w./-])")
_PYTEST_COMMAND_PATTERN = re.compile(r"\bpytest\s+[A-Za-z0-9_./-]+(?:\s+-[A-Za-z0-9_-]+)*")
_REQUESTED_WORDS_PATTERN = re.compile(r"\bwords?\s+([A-Za-z0-9][A-Za-z0-9 _-]*?)(?=\.|,|;|$)", re.IGNORECASE)
_BOTH_PARALLEL_DOWNSTREAM_PATTERN = re.compile(
    r"\bdepend\s+on\s+both\s+parallel\s+subtasks\b",
    re.IGNORECASE,
)
_SHARED_CONFLICT_FILE = "SYMPHONY_CONFLICT_SHARED.md"


def _required_gate_commands_from_issue(issue_description: str, *, issue_identifier: str) -> list[str]:
    commands: list[str] = []
    pytest_spans = [match.span() for match in _PYTEST_COMMAND_PATTERN.finditer(issue_description)]
    for match in _RELATIVE_FILE_PATTERN.finditer(issue_description):
        if any(start <= match.start() < end for start, end in pytest_spans):
            continue
        path = match.group(1)
        if _is_relative_workspace_file(path):
            quoted_path = shlex.quote(path)
            commands.append(f"test -f {quoted_path}")
            if Path(path).name == "SYMPHONY_REAL_E2E_RESULT.md":
                if issue_identifier:
                    commands.append(f"grep -q {shlex.quote(issue_identifier)} {quoted_path}")
                for phrase in _REQUESTED_WORDS_PATTERN.findall(issue_description):
                    phrase = " ".join(phrase.split())
                    if phrase:
                        commands.append(f"grep -q {shlex.quote(phrase)} {quoted_path}")
    for command in _PYTEST_COMMAND_PATTERN.findall(issue_description):
        commands.append(command.strip())
    return list(dict.fromkeys(commands))


def _is_relative_workspace_file(path: str) -> bool:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        return False
    return bool(candidate.name) and not path.startswith(("./.git/", ".git/"))


def _issue_requests_shared_conflict_file(issue_description: str) -> bool:
    lowered = issue_description.lower()
    return (
        _SHARED_CONFLICT_FILE in issue_description
        and "different content" in lowered
        and "verified patches overlap" in lowered
    )


def _required_parallel_dependency_edges(proposal: PlanProposal) -> list[tuple[str, str]]:
    node_by_id = {node.node_id: node for node in proposal.nodes}
    node_ids = set(node_by_id)
    labels = {node.node_id: f"{node.node_id} {node.title}".lower() for node in proposal.nodes}
    parallel_node_ids = [node.node_id for node in proposal.nodes if "parallel" in labels[node.node_id]]
    if len(parallel_node_ids) < 2:
        return []
    downstream_node_ids = [
        node.node_id
        for node in proposal.nodes
        if node.node_id not in parallel_node_ids
        and ("downstream" in labels[node.node_id] or "integration" in labels[node.node_id])
    ]
    if not downstream_node_ids:
        downstream_node_ids = list(
            dict.fromkeys(
                target
                for source, target in proposal.blocks
                if source in parallel_node_ids and target in node_ids and target not in parallel_node_ids
            )
        )
    if not downstream_node_ids:
        downstream_node_ids = [
            node_id for node_id in proposal.exit_node_ids if node_id in node_ids and node_id not in parallel_node_ids
        ]
    required_edges: list[tuple[str, str]] = []
    for downstream_node_id in downstream_node_ids:
        for parallel_node_id in parallel_node_ids:
            edge = (parallel_node_id, downstream_node_id)
            if _has_block_path(downstream_node_id, parallel_node_id, proposal.blocks):
                continue
            required_edges.append(edge)
    return list(dict.fromkeys(required_edges))


def _has_block_path(source: str, target: str, blocks: list[tuple[str, str]]) -> bool:
    pending = [source]
    seen: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target:
            return True
        if current in seen:
            continue
        seen.add(current)
        pending.extend(next_node for from_node, next_node in blocks if from_node == current and next_node not in seen)
    return False


def _entry_exit_node_ids_for_blocks(
    nodes: list[GraphNode],
    blocks: list[tuple[str, str]],
) -> tuple[list[str], list[str]]:
    node_ids = {node.node_id for node in nodes}
    incoming = {target for source, target in blocks if source in node_ids and target in node_ids}
    outgoing = {source for source, target in blocks if source in node_ids and target in node_ids}
    ordered_node_ids = [node.node_id for node in nodes]
    return (
        [node_id for node_id in ordered_node_ids if node_id not in incoming],
        [node_id for node_id in ordered_node_ids if node_id not in outgoing],
    )


def _looks_like_executable_gate_command(step: str) -> bool:
    candidate = step.strip()
    if not candidate:
        return False
    lowered = candidate.lower()
    prose_prefixes = (
        "check ",
        "confirm ",
        "ensure ",
        "from ",
        "read ",
        "run ",
        "verify ",
        "validate ",
    )
    if lowered.startswith(prose_prefixes):
        return False
    if "`" in candidate:
        return False
    return True


def sanitize_profile_settings(settings: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, value in settings.items():
        lowered = str(key).lower()
        if lowered in SECRET_SETTING_KEYS or any(secret in lowered for secret in ("token", "secret", "password", "cookie")):
            continue
        sanitized[str(key)] = value
    return sanitized


def _has_cycle(node_ids: set[str], edges: list[tuple[str, str]]) -> bool:
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    for source, target in edges:
        if source in node_ids and target in node_ids:
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


def _mode(value: Any) -> RuntimeMode:
    return value if isinstance(value, RuntimeMode) else RuntimeMode(str(value or RuntimeMode.EXECUTE.value))


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _jsonable_dict(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None and str(item)]


def _gate_steps(value: Any) -> list[GateStep]:
    if not isinstance(value, list):
        return []
    return [GateStep.from_obj(item) for item in value if item is not None]


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_time(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
