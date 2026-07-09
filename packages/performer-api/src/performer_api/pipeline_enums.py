from __future__ import annotations

from enum import StrEnum
from typing import Any


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
    VERIFYING = "verifying"
    VERIFY_PASSED = "verify_passed"
    REPLANNING = "replanning"
    SUPERSEDED = "superseded"
    NEED_HUMAN = "need_human"
    FAILED = "failed"

    @classmethod
    def from_value(cls, value: Any) -> GraphNodeState:
        normalized = str(value or cls.PLANNED.value)
        return cls(normalized)


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
    THREAD_LOST = "THREAD_LOST"


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
