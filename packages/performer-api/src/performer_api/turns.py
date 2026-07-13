from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import re
from typing import Any

from performer_api._wire_safety import (
    exact_keys as _exact_keys,
    identifier as _identifier,
    json_copy as _json_copy,
    optional_identifier as _optional_identifier,
    optional_text as _optional_text,
    positive_int as _positive_int,
    safe_text as _safe_text,
    sha256 as _sha256,
)
from performer_api.runtime_policy import RuntimePolicy, RuntimePolicyError, canonical_sha256
from performer_api.validation import validate_plan
from performer_api.workflow import Plan, Task


TURN_KINDS = frozenset({"plan", "execute", "gate"})
RUNTIME_WAIT_KINDS = frozenset({"approval_requested", "permission_required", "tool_input_required"})
TURN_EVENT_KINDS = frozenset({"progress", "warning", "heartbeat"})
PERFORMER_KINDS = frozenset({"codex"})
TURN_PROTOCOL_VERSION = 1
MAX_TURN_TEXT_BYTES = 64 * 1024
MAX_TURN_PAYLOAD_BYTES = 256 * 1024
_TURN_CONTEXT_FIELDS = frozenset(
    {"run_id", "task_id", "attempt_id", "fencing_token", "turn_kind"}
)
_TURN_REQUEST_FIELDS = frozenset(
    {
        "context",
        "protocol_version",
        "performer_kind",
        "performer_binding_id",
        "binding_generation",
        "execution_policy",
        "execution_policy_sha256",
        "turn_policy_sha256",
        "workspace_path",
        "thread_id",
        "issue_description",
        "task",
        "evidence",
    }
)
_TURN_RESULT_FIELDS = frozenset(
    {
        "context",
        "protocol_version",
        "thread_id",
        "plan",
        "execute_result",
        "gate_result",
        "runtime_wait",
        "events",
    }
)
_TASK_FIELDS = frozenset(
    {
        "id",
        "title",
        "objective",
        "acceptance_criteria",
        "verification_commands",
        "files_likely_touched",
    }
)
_EXECUTE_RESULT_FIELDS = frozenset(
    {"status", "summary", "changed_files", "acceptance_evidence", "blocked_reason"}
)
_GATE_RESULT_FIELDS = frozenset(
    {"passed", "score", "threshold", "rubric", "provenance", "findings", "artifact_refs"}
)
_MAX_CONTRACT_DEPTH = 32
_MAX_CONTRACT_NODES = 2_048


@dataclass(frozen=True)
class TurnContext:
    run_id: str
    task_id: str
    attempt_id: str
    fencing_token: int
    turn_kind: str

    def __post_init__(self) -> None:
        _identifier(self.run_id, "run_id")
        _optional_identifier(self.task_id, "task_id")
        _identifier(self.attempt_id, "attempt_id")
        _positive_int(self.fencing_token, "fencing_token")
        errors = self.validation_errors()
        if errors:
            raise ValueError(f"invalid turn context: {errors[0]}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "attempt_id": self.attempt_id,
            "fencing_token": self.fencing_token,
            "turn_kind": self.turn_kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TurnContext:
        _exact_keys(payload, _TURN_CONTEXT_FIELDS, "turn context")
        return cls(
            run_id=_identifier(payload.get("run_id"), "run_id"),
            task_id=_optional_identifier(payload.get("task_id"), "task_id"),
            attempt_id=_identifier(payload.get("attempt_id"), "attempt_id"),
            fencing_token=_positive_int(payload.get("fencing_token"), "fencing_token"),
            turn_kind=payload.get("turn_kind"),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.run_id:
            errors.append("run_id_required")
        if not self.attempt_id:
            errors.append("attempt_id_required")
        if self.fencing_token <= 0:
            errors.append("fencing_token_required")
        if self.turn_kind not in TURN_KINDS:
            errors.append("turn_kind_invalid")
        if self.turn_kind in {"execute", "gate"} and not self.task_id:
            errors.append("task_id_required")
        if self.turn_kind == "plan" and self.task_id:
            errors.append("plan_task_id_must_be_empty")
        return errors

    def mismatch_reason(self, actual: TurnContext) -> str | None:
        errors = actual.validation_errors()
        if errors:
            return f"invalid_turn_context:{errors[0]}"
        for field, reason in (
            ("run_id", "result_run_id_mismatch"),
            ("task_id", "result_task_id_mismatch"),
            ("attempt_id", "stale_attempt_id"),
            ("fencing_token", "stale_fencing_token"),
            ("turn_kind", "turn_kind_mismatch"),
        ):
            if getattr(self, field) != getattr(actual, field):
                return reason
        return None


@dataclass(frozen=True)
class RuntimeWait:
    kind: str
    reason: str

    def __post_init__(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError(errors[0])
        _safe_text(self.reason, "runtime wait reason", max_bytes=2_000)

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "reason": self.reason}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeWait:
        _exact_keys(payload, frozenset({"kind", "reason"}), "runtime wait")
        return cls(kind=payload.get("kind"), reason=payload.get("reason"))

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if self.kind not in RUNTIME_WAIT_KINDS:
            errors.append("runtime_wait_kind_invalid")
        if not self.reason.strip():
            errors.append("runtime_wait_reason_required")
        return errors


@dataclass(frozen=True)
class ExecuteResult:
    status: str
    summary: str
    changed_files: list[str] = field(default_factory=list)
    acceptance_evidence: list[dict[str, str]] = field(default_factory=list)
    blocked_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "summary": self.summary,
            "changed_files": list(self.changed_files),
            "acceptance_evidence": [dict(item) for item in self.acceptance_evidence],
            "blocked_reason": self.blocked_reason,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ExecuteResult:
        _validate_execute_payload(payload)
        return cls(
            status=payload["status"],
            summary=payload["summary"],
            changed_files=list(payload["changed_files"]),
            acceptance_evidence=[dict(item) for item in payload["acceptance_evidence"]],
            blocked_reason=payload["blocked_reason"],
        )


@dataclass(frozen=True)
class GateResult:
    passed: bool
    score: int
    threshold: int
    rubric: dict[str, dict[str, Any]] = field(default_factory=dict)
    provenance: list[dict[str, str]] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)
    artifact_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "score": self.score,
            "threshold": self.threshold,
            "rubric": {str(key): dict(value) for key, value in self.rubric.items()},
            "provenance": [dict(item) for item in self.provenance],
            "findings": list(self.findings),
            "artifact_refs": list(self.artifact_refs),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateResult:
        _validate_gate_payload(payload)
        rubric = payload["rubric"]
        return cls(
            passed=payload["passed"],
            score=payload["score"],
            threshold=payload["threshold"],
            rubric={key: dict(value) for key, value in rubric.items()},
            provenance=[dict(item) for item in payload["provenance"]],
            findings=list(payload["findings"]),
            artifact_refs=list(payload["artifact_refs"]),
        )


@dataclass(frozen=True)
class PerformerTurnEvent:
    protocol_version: int
    kind: str
    message: str
    sequence: int

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        if self.kind not in TURN_EVENT_KINDS:
            raise ValueError("turn event kind is unsupported")
        _safe_text(self.message, "turn event message", max_bytes=2_000)
        _positive_int(self.sequence, "sequence")

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "kind": self.kind,
            "message": self.message,
            "sequence": self.sequence,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerTurnEvent":
        _exact_keys(
            payload,
            frozenset({"protocol_version", "kind", "message", "sequence"}),
            "turn event",
        )
        return cls(
            protocol_version=payload.get("protocol_version"),
            kind=payload.get("kind"),
            message=payload.get("message"),
            sequence=payload.get("sequence"),
        )


@dataclass(frozen=True)
class PerformerTurnRequest:
    protocol_version: int
    context: TurnContext
    performer_kind: str
    performer_binding_id: str
    binding_generation: int
    execution_policy: dict[str, Any]
    execution_policy_sha256: str
    turn_policy_sha256: str
    workspace_path: str
    thread_id: str
    issue_description: str
    task: Task | None
    evidence: dict[str, Any] | None

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        if not isinstance(self.context, TurnContext):
            raise ValueError("turn request context must be a TurnContext")
        if self.performer_kind not in PERFORMER_KINDS:
            raise ValueError("performer_kind is unsupported")
        _identifier(self.performer_binding_id, "performer_binding_id")
        _positive_int(self.binding_generation, "binding_generation")
        policy = RuntimePolicy.from_dict(self.execution_policy)
        expected_hash = canonical_sha256(policy.to_dict())
        if self.execution_policy_sha256 != expected_hash:
            raise RuntimePolicyError(
                "execution_policy_hash_mismatch",
                "Supplied execution policy hash does not match content",
            )
        object.__setattr__(self, "execution_policy", policy.to_dict())
        object.__setattr__(self, "execution_policy_sha256", expected_hash)
        _sha256(self.turn_policy_sha256, "turn_policy_sha256")
        object.__setattr__(self, "workspace_path", _workspace_path(self.workspace_path))
        object.__setattr__(self, "thread_id", _optional_text(self.thread_id, "thread_id", 200))

        if self.context.turn_kind == "plan":
            _safe_text(self.issue_description, "issue_description", max_bytes=MAX_TURN_TEXT_BYTES)
            if self.task is not None or self.evidence is not None:
                raise ValueError("plan turn rejects task and evidence")
            return

        if self.issue_description:
            raise ValueError("execute and gate turns reject issue_description")
        if self.task is None:
            raise ValueError(f"{self.context.turn_kind} turn requires task")
        task = _normalized_task(self.task)
        if task.id != self.context.task_id:
            raise ValueError("turn context task id mismatch")
        object.__setattr__(self, "task", task)
        if self.context.turn_kind == "execute":
            if self.evidence is not None:
                raise ValueError("execute turn rejects evidence")
            return
        if self.evidence is None:
            raise ValueError("gate turn requires evidence")
        object.__setattr__(self, "evidence", _normalized_evidence(self.evidence))

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "context": self.context.to_dict(),
            "performer_kind": self.performer_kind,
            "performer_binding_id": self.performer_binding_id,
            "binding_generation": self.binding_generation,
            "execution_policy": _json_copy(self.execution_policy),
            "execution_policy_sha256": self.execution_policy_sha256,
            "turn_policy_sha256": self.turn_policy_sha256,
            "workspace_path": self.workspace_path,
            "thread_id": self.thread_id,
            "issue_description": self.issue_description,
            "task": self.task.to_dict() if self.task is not None else None,
            "evidence": _json_copy(self.evidence) if self.evidence is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerTurnRequest":
        _exact_keys(payload, _TURN_REQUEST_FIELDS, "turn request")
        context = payload.get("context")
        policy = payload.get("execution_policy")
        task = payload.get("task")
        evidence = payload.get("evidence")
        if not isinstance(context, dict):
            raise ValueError("turn request context must be an object")
        if not isinstance(policy, dict):
            raise RuntimePolicyError("invalid_runtime_policy", "Runtime policy must be an object")
        if task is not None and not isinstance(task, dict):
            raise ValueError("turn task must be an object or null")
        if evidence is not None and not isinstance(evidence, dict):
            raise ValueError("turn evidence must be an object or null")
        return cls(
            protocol_version=payload.get("protocol_version"),
            context=TurnContext.from_dict(context),
            performer_kind=payload.get("performer_kind"),
            performer_binding_id=payload.get("performer_binding_id"),
            binding_generation=payload.get("binding_generation"),
            execution_policy=dict(policy),
            execution_policy_sha256=payload.get("execution_policy_sha256"),
            turn_policy_sha256=payload.get("turn_policy_sha256"),
            workspace_path=payload.get("workspace_path"),
            thread_id=payload.get("thread_id"),
            issue_description=payload.get("issue_description"),
            task=_parse_task(task) if isinstance(task, dict) else None,
            evidence=_normalized_evidence(evidence) if isinstance(evidence, dict) else None,
        )


@dataclass(frozen=True)
class PerformerTurnResult:
    protocol_version: int
    context: TurnContext
    thread_id: str
    plan: Plan | None
    execute_result: ExecuteResult | None
    gate_result: GateResult | None
    runtime_wait: RuntimeWait | None
    events: tuple[PerformerTurnEvent, ...]

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        if not isinstance(self.context, TurnContext):
            raise ValueError("turn result context must be a TurnContext")
        object.__setattr__(self, "thread_id", _optional_text(self.thread_id, "thread_id", 200))
        if not isinstance(self.events, tuple) or any(
            not isinstance(event, PerformerTurnEvent) for event in self.events
        ):
            raise ValueError("turn result events must be PerformerTurnEvent values")
        sequences = [event.sequence for event in self.events]
        if sequences != sorted(set(sequences)):
            raise ValueError("turn result event sequences must be unique and ordered")

        business_results = (self.plan, self.execute_result, self.gate_result)
        if self.runtime_wait is not None:
            if not isinstance(self.runtime_wait, RuntimeWait):
                raise ValueError("runtime_wait must be a RuntimeWait")
            if any(value is not None for value in business_results):
                raise ValueError("runtime_wait result cannot carry a business result")
            return

        if self.context.turn_kind == "plan":
            if self.plan is None or self.execute_result is not None or self.gate_result is not None:
                raise ValueError("plan turn result must carry only plan")
            payload = self.plan.to_dict()
            object.__setattr__(self, "plan", _parse_plan(payload))
            return
        if self.context.turn_kind == "execute":
            if self.execute_result is None or self.plan is not None or self.gate_result is not None:
                raise ValueError("execute turn result must carry only execute_result")
            object.__setattr__(
                self,
                "execute_result",
                _normalized_execute_result(self.execute_result),
            )
            return
        if self.gate_result is None or self.plan is not None or self.execute_result is not None:
            raise ValueError("gate turn result must carry only gate_result")
        object.__setattr__(self, "gate_result", _normalized_gate_result(self.gate_result))

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "context": self.context.to_dict(),
            "thread_id": self.thread_id,
            "plan": self.plan.to_dict() if self.plan is not None else None,
            "execute_result": (
                self.execute_result.to_dict() if self.execute_result is not None else None
            ),
            "gate_result": self.gate_result.to_dict() if self.gate_result is not None else None,
            "runtime_wait": self.runtime_wait.to_dict() if self.runtime_wait is not None else None,
            "events": [event.to_dict() for event in self.events],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerTurnResult":
        _exact_keys(payload, _TURN_RESULT_FIELDS, "turn result")
        context = payload.get("context")
        plan = payload.get("plan")
        execute_result = payload.get("execute_result")
        gate_result = payload.get("gate_result")
        runtime_wait = payload.get("runtime_wait")
        events = payload.get("events")
        for label, value in (
            ("context", context),
            ("plan", plan),
            ("execute_result", execute_result),
            ("gate_result", gate_result),
            ("runtime_wait", runtime_wait),
        ):
            if label == "context" and not isinstance(value, dict):
                raise ValueError("turn result context must be an object")
            if label != "context" and value is not None and not isinstance(value, dict):
                raise ValueError(f"turn result {label} must be an object or null")
        if not isinstance(events, list) or any(not isinstance(event, dict) for event in events):
            raise ValueError("turn result events must be an object list")
        return cls(
            protocol_version=payload.get("protocol_version"),
            context=TurnContext.from_dict(context),
            thread_id=payload.get("thread_id"),
            plan=_parse_plan(plan) if isinstance(plan, dict) else None,
            execute_result=(
                _parse_execute_result(execute_result)
                if isinstance(execute_result, dict)
                else None
            ),
            gate_result=(
                _parse_gate_result(gate_result) if isinstance(gate_result, dict) else None
            ),
            runtime_wait=(
                RuntimeWait.from_dict(runtime_wait) if isinstance(runtime_wait, dict) else None
            ),
            events=tuple(PerformerTurnEvent.from_dict(event) for event in events),
        )


def _normalized_task(value: Task) -> Task:
    if not isinstance(value, Task):
        raise ValueError("turn task must be a Task")
    payload = value.to_dict()
    _exact_keys(payload, _TASK_FIELDS, "turn task")
    _validate_task_types(payload)
    validate_plan({"summary": "Turn task", "tasks": [payload]})
    _validate_json_safety(payload, "turn task")
    return Task.from_dict(payload)


def _parse_task(payload: dict[str, Any]) -> Task:
    _exact_keys(payload, _TASK_FIELDS, "turn task")
    _validate_task_types(payload)
    validate_plan({"summary": "Turn task", "tasks": [payload]})
    _validate_json_safety(payload, "turn task")
    return Task.from_dict(payload)


def _parse_plan(payload: dict[str, Any]) -> Plan:
    _validate_plan_types(payload)
    validate_plan(payload)
    acceptance_catalog = payload.get("acceptance_catalog")
    if acceptance_catalog is not None:
        _exact_keys(
            acceptance_catalog,
            frozenset({"id", "rubric"}),
            "acceptance catalog",
        )
        if not isinstance(acceptance_catalog.get("rubric"), dict):
            raise ValueError("acceptance catalog rubric must be an object")
    _validate_json_safety(payload, "plan")
    return Plan.from_dict(payload)


def _validate_plan_types(payload: dict[str, Any]) -> None:
    if not isinstance(payload.get("summary"), str):
        raise ValueError("plan summary must be a string")
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
        raise ValueError("plan tasks must be an object list")
    for task in tasks:
        _validate_task_types(task)
    for field_name in ("risks", "architecture_decisions", "open_questions"):
        _require_string_list(payload.get(field_name, []), f"plan {field_name}")
    if not isinstance(payload.get("approval_required", False), bool):
        raise ValueError("plan approval_required must be a boolean")
    catalog = payload.get("acceptance_catalog")
    if catalog is not None:
        if not isinstance(catalog, dict):
            raise ValueError("acceptance catalog must be an object or null")
        if not isinstance(catalog.get("id"), str) or not isinstance(
            catalog.get("rubric"), dict
        ):
            raise ValueError("acceptance catalog fields are invalid")


def _validate_task_types(payload: dict[str, Any]) -> None:
    for field_name in ("id", "title", "objective"):
        if not isinstance(payload.get(field_name), str):
            raise ValueError(f"turn task {field_name} must be a string")
    for field_name in (
        "acceptance_criteria",
        "verification_commands",
        "files_likely_touched",
    ):
        _require_string_list(payload.get(field_name), f"turn task {field_name}")


def _normalized_evidence(value: dict[str, Any]) -> dict[str, Any]:
    _exact_keys(value, frozenset({"commands"}), "turn evidence")
    commands = value.get("commands")
    if not isinstance(commands, list) or not 1 <= len(commands) <= 50:
        raise ValueError("turn evidence commands must contain 1 to 50 items")
    normalized: list[dict[str, Any]] = []
    for command in commands:
        _exact_keys(
            command,
            frozenset({"command", "passed", "exit_code", "output"}),
            "turn evidence command",
        )
        passed = command.get("passed")
        exit_code = command.get("exit_code")
        if not isinstance(passed, bool):
            raise ValueError("turn evidence passed must be a boolean")
        if exit_code is not None and (
            isinstance(exit_code, bool) or not isinstance(exit_code, int)
        ):
            raise ValueError("turn evidence exit_code must be an integer or null")
        normalized.append(
            {
                "command": _safe_text(
                    command.get("command"), "turn evidence command", max_bytes=4_000
                ),
                "passed": passed,
                "exit_code": exit_code,
                "output": _optional_text(
                    command.get("output"),
                    "turn evidence output",
                    MAX_TURN_TEXT_BYTES,
                    allow_newlines=True,
                ),
            }
        )
    return {"commands": normalized}


def _validate_execute_payload(payload: dict[str, Any]) -> None:
    _exact_keys(payload, _EXECUTE_RESULT_FIELDS, "execute result")
    if not isinstance(payload.get("status"), str) or not isinstance(
        payload.get("summary"), str
    ):
        raise ValueError("execute result status and summary must be strings")
    _require_string_list(payload.get("changed_files"), "execute result changed_files")
    evidence = payload.get("acceptance_evidence")
    if not isinstance(evidence, list) or any(not isinstance(item, dict) for item in evidence):
        raise ValueError("execute result acceptance_evidence must be an object list")
    for item in evidence:
        _exact_keys(
            item,
            frozenset({"criterion", "evidence", "passed"}),
            "acceptance evidence",
        )
        if not isinstance(item.get("criterion"), str) or not isinstance(
            item.get("evidence"), str
        ):
            raise ValueError("acceptance evidence text must be strings")
        if not isinstance(item.get("passed"), bool):
            raise ValueError("acceptance evidence passed must be a boolean")
    blocked_reason = payload.get("blocked_reason")
    if blocked_reason is not None and not isinstance(blocked_reason, str):
        raise ValueError("execute result blocked_reason must be a string or null")
    _validate_json_safety(payload, "execute result")


def _normalized_execute_result(value: ExecuteResult) -> ExecuteResult:
    payload = value.to_dict()
    _exact_keys(payload, _EXECUTE_RESULT_FIELDS, "execute result")
    _validate_json_safety(payload, "execute result")
    if payload["status"] not in {"ready_for_gate", "blocked", "failed"}:
        raise ValueError("execute result status is unsupported")
    _safe_text(payload["summary"], "execute result summary", max_bytes=4_000)
    if not isinstance(payload["changed_files"], list) or any(
        not isinstance(item, str) for item in payload["changed_files"]
    ):
        raise ValueError("execute result changed_files must be a string list")
    if not isinstance(payload["acceptance_evidence"], list):
        raise ValueError("execute result acceptance_evidence must be a list")
    for evidence in payload["acceptance_evidence"]:
        _exact_keys(
            evidence,
            frozenset({"criterion", "evidence", "passed"}),
            "acceptance evidence",
        )
        _safe_text(evidence.get("criterion"), "acceptance criterion", max_bytes=2_000)
        _safe_text(evidence.get("evidence"), "acceptance evidence", max_bytes=4_000)
        if not isinstance(evidence.get("passed"), bool):
            raise ValueError("acceptance evidence passed must be a boolean")
    blocked_reason = payload["blocked_reason"]
    if blocked_reason is not None:
        _safe_text(blocked_reason, "blocked_reason", max_bytes=4_000)
    return ExecuteResult.from_dict(payload)


def _parse_execute_result(payload: dict[str, Any]) -> ExecuteResult:
    _validate_execute_payload(payload)
    return _normalized_execute_result(ExecuteResult.from_dict(payload))


def _normalized_gate_result(value: GateResult) -> GateResult:
    payload = value.to_dict()
    _exact_keys(payload, _GATE_RESULT_FIELDS, "gate result")
    _validate_json_safety(payload, "gate result")
    if not isinstance(payload["passed"], bool):
        raise ValueError("gate result passed must be a boolean")
    for field_name in ("score", "threshold"):
        field_value = payload[field_name]
        if isinstance(field_value, bool) or not isinstance(field_value, int):
            raise ValueError(f"gate result {field_name} must be an integer")
    if not isinstance(payload["rubric"], dict):
        raise ValueError("gate result rubric must be an object")
    for field_name in ("provenance", "findings", "artifact_refs"):
        if not isinstance(payload[field_name], list):
            raise ValueError(f"gate result {field_name} must be a list")
    for provenance in payload["provenance"]:
        if not isinstance(provenance, dict):
            raise ValueError("gate provenance must be an object")
        if set(provenance) - {"source", "reference", "attempt_id"}:
            raise ValueError("gate provenance fields are invalid")
        for key, item in provenance.items():
            _safe_text(item, f"gate provenance {key}", max_bytes=2_000)
    for field_name in ("findings", "artifact_refs"):
        if any(not isinstance(item, str) for item in payload[field_name]):
            raise ValueError(f"gate result {field_name} must be a string list")
        for item in payload[field_name]:
            _safe_text(item, f"gate result {field_name}", max_bytes=4_000)
    return GateResult.from_dict(payload)


def _validate_gate_payload(payload: dict[str, Any]) -> None:
    _exact_keys(payload, _GATE_RESULT_FIELDS, "gate result")
    if not isinstance(payload.get("passed"), bool):
        raise ValueError("gate result passed must be a boolean")
    for field_name in ("score", "threshold"):
        field_value = payload.get(field_name)
        if isinstance(field_value, bool) or not isinstance(field_value, int):
            raise ValueError(f"gate result {field_name} must be an integer")
    rubric = payload.get("rubric")
    if not isinstance(rubric, dict) or any(
        not isinstance(key, str) or not isinstance(value, dict)
        for key, value in rubric.items()
    ):
        raise ValueError("gate result rubric must map strings to objects")
    provenance = payload.get("provenance")
    if not isinstance(provenance, list) or any(
        not isinstance(item, dict) for item in provenance
    ):
        raise ValueError("gate result provenance must be an object list")
    for item in provenance:
        if set(item) - {"source", "reference", "attempt_id"} or any(
            not isinstance(value, str) for value in item.values()
        ):
            raise ValueError("gate provenance fields are invalid")
    _require_string_list(payload.get("findings"), "gate result findings")
    _require_string_list(payload.get("artifact_refs"), "gate result artifact_refs")
    _validate_json_safety(payload, "gate result")


def _parse_gate_result(payload: dict[str, Any]) -> GateResult:
    _validate_gate_payload(payload)
    return _normalized_gate_result(GateResult.from_dict(payload))


def _workspace_path(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4_096:
        raise ValueError("workspace_path must be a bounded absolute path")
    if "\x00" in value or "\n" in value or "\r" in value or not Path(value).is_absolute():
        raise ValueError("workspace_path must be a bounded absolute path")
    return value


def _require_string_list(value: Any, label: str) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be a string list")


def _protocol_version(value: Any) -> int:
    if value != TURN_PROTOCOL_VERSION or isinstance(value, bool):
        raise ValueError("protocol_version must be 1")
    return TURN_PROTOCOL_VERSION


def _validate_json_safety(
    value: Any,
    label: str,
    *,
    depth: int = 0,
    counter: list[int] | None = None,
) -> None:
    if counter is None:
        counter = [0]
        try:
            encoded = json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValueError(f"{label} contains an unsupported value") from exc
        if len(encoded) > MAX_TURN_PAYLOAD_BYTES:
            raise ValueError(f"{label} is too large")
    counter[0] += 1
    if depth > _MAX_CONTRACT_DEPTH or counter[0] > _MAX_CONTRACT_NODES:
        raise ValueError(f"{label} is too deeply nested or complex")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not key or _unsafe_contract_key(key):
                raise ValueError(f"{label} contains an unsafe field")
            _validate_json_safety(
                item,
                label,
                depth=depth + 1,
                counter=counter,
            )
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_safety(
                item,
                label,
                depth=depth + 1,
                counter=counter,
            )
        return
    if isinstance(value, str):
        _safe_text(value, label, max_bytes=MAX_TURN_TEXT_BYTES, allow_newlines=True)
        return
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{label} contains a non-finite number")
    if value is None or isinstance(value, (bool, int, float)):
        return
    raise ValueError(f"{label} contains an unsupported value")


def _unsafe_contract_key(value: str) -> bool:
    segmented = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    normalized = re.sub(r"[^a-z0-9]+", "_", segmented.lower()).strip("_")
    parts = normalized.split("_") if normalized else []
    pairs = set(zip(parts, parts[1:]))
    return bool(
        "sdk" in parts
        or normalized in {
            "api_key",
            "client_secret",
            "access_token",
            "refresh_token",
            "password",
            "authorization",
            "private_key",
            "raw_payload",
            "raw_response",
        }
        or ("api", "key") in pairs
        or ("client", "secret") in pairs
        or ("access", "token") in pairs
        or ("refresh", "token") in pairs
        or ("private", "key") in pairs
        or ("raw", "payload") in pairs
        or ("raw", "response") in pairs
    )


__all__ = [
    "ExecuteResult",
    "GateResult",
    "MAX_TURN_TEXT_BYTES",
    "MAX_TURN_PAYLOAD_BYTES",
    "PERFORMER_KINDS",
    "PerformerTurnEvent",
    "PerformerTurnRequest",
    "PerformerTurnResult",
    "RUNTIME_WAIT_KINDS",
    "RuntimeWait",
    "TURN_EVENT_KINDS",
    "TURN_KINDS",
    "TURN_PROTOCOL_VERSION",
    "TurnContext",
]
