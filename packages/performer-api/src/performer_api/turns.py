from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


TURN_KINDS = frozenset({"plan", "execute", "gate"})
RUNTIME_WAIT_KINDS = frozenset({"approval_requested", "permission_required", "tool_input_required"})


@dataclass(frozen=True)
class TurnContext:
    run_id: str
    task_id: str
    attempt_id: str
    fencing_token: int
    turn_kind: str

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
        token = payload.get("fencing_token")
        return cls(
            run_id=str(payload.get("run_id") or ""),
            task_id=str(payload.get("task_id") or ""),
            attempt_id=str(payload.get("attempt_id") or ""),
            fencing_token=token if isinstance(token, int) and not isinstance(token, bool) else 0,
            turn_kind=str(payload.get("turn_kind") or ""),
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

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "reason": self.reason}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeWait:
        return cls(kind=str(payload.get("kind") or ""), reason=str(payload.get("reason") or ""))

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
        return cls(
            status=str(payload.get("status") or "failed"),
            summary=str(payload.get("summary") or ""),
            changed_files=[str(item) for item in payload.get("changed_files") or []],
            acceptance_evidence=[dict(item) for item in payload.get("acceptance_evidence") or [] if isinstance(item, dict)],
            blocked_reason=str(payload["blocked_reason"]) if payload.get("blocked_reason") is not None else None,
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
        rubric = payload.get("rubric") or {}
        return cls(
            passed=bool(payload.get("passed")),
            score=int(payload.get("score") or 0),
            threshold=int(payload.get("threshold") or 0),
            rubric={str(key): dict(value) for key, value in rubric.items() if isinstance(value, dict)},
            provenance=[dict(item) for item in payload.get("provenance") or [] if isinstance(item, dict)],
            findings=[str(item) for item in payload.get("findings") or []],
            artifact_refs=[str(item) for item in payload.get("artifact_refs") or []],
        )


__all__ = [
    "ExecuteResult",
    "GateResult",
    "RUNTIME_WAIT_KINDS",
    "RuntimeWait",
    "TURN_KINDS",
    "TurnContext",
]
