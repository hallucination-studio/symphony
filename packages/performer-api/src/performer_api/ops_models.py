from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from typing import Any, Literal


@dataclass
class CompletionVerdict:
    """完成验证判定"""

    status: Literal["VERIFIED", "NEEDS_RETRY", "NEEDS_HUMAN"]
    reason: str
    checks: list["CheckResult"]
    verified_at: str
    evidence: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "checks": [c.to_dict() for c in self.checks],
            "verified_at": self.verified_at,
            "evidence": self.evidence,
        }


@dataclass
class CheckResult:
    """单个检查结果"""

    check_name: str
    passed: bool
    message: str
    evidence: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "check_name": self.check_name,
            "passed": self.passed,
            "message": self.message,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class RetentionMetadata:
    pinned_issue_ids: list[str] = field(default_factory=list)
    pinned_run_ids: list[str] = field(default_factory=list)
    last_collected_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RetentionMetadata:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class IssueRecord:
    issue_id: str
    issue_identifier: str
    title: str
    state: str
    total_turn_count: int = 0
    total_tokens: int = 0
    total_estimated_cost_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cached_tokens: int = 0
    run_count: int = 0
    attempt_count: int = 0
    tool_call_count: int = 0
    retry_count: int = 0
    duration_ms: int | None = None
    time_to_first_output_ms: int | None = None
    time_to_first_tool_call_ms: int | None = None
    failure_reason: str | None = None
    last_activity_at: str | None = None
    pinned: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> IssueRecord:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    issue_id: str
    instance_id: str
    status: str
    issue_identifier: str | None = None
    workspace_path: str | None = None
    prompt_digest: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    turn_count: int = 0
    attempt_count: int = 0
    tool_call_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    duration_ms: int | None = None
    retry_count: int = 0
    time_to_first_output_ms: int | None = None
    time_to_first_tool_call_ms: int | None = None
    failure_code: str | None = None
    failure_summary: str | None = None
    last_activity_at: str | None = None
    pinned: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RunRecord:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class AttemptRecord:
    attempt_id: str
    run_id: str
    attempt_number: int
    status: str
    codex_session_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    turn_count: int = 0
    tool_call_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    duration_ms: int | None = None
    failure_code: str | None = None
    failure_summary: str | None = None
    stop_reason: str | None = None
    last_activity_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> AttemptRecord:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class TurnRecord:
    turn_id: str
    attempt_id: str
    turn_number: int
    status: str
    started_at: str | None = None
    completed_at: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    duration_ms: int | None = None
    tool_call_count: int = 0
    time_to_first_output_ms: int | None = None
    time_to_first_tool_call_ms: int | None = None
    failure_code: str | None = None
    failure_summary: str | None = None
    stop_reason: str | None = None
    last_activity_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TurnRecord:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class TraceEvent:
    event_id: str
    event_type: str
    timestamp: str
    issue_id: str | None = None
    run_id: str | None = None
    attempt_id: str | None = None
    turn_id: str | None = None
    retention_tier: str = "trace"
    summary: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TraceEvent:
        return _record_from_dict(cls, payload)


@dataclass(frozen=True)
class RepositoryHandoffReport:
    issue_id: str
    issue_identifier: str
    workspace_path: str
    structured_result: dict[str, Any] | None
    git_snapshot: dict[str, Any]
    artifact_manifest: list[dict[str, Any]]
    bundle: dict[str, Any]
    recommended_next_action: str
    generated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RepositoryHandoffReport:
        return _record_from_dict(cls, payload)


@dataclass
class OpsSnapshot:
    issues: dict[str, IssueRecord] = field(default_factory=dict)
    runs: dict[str, RunRecord] = field(default_factory=dict)
    attempts: dict[str, AttemptRecord] = field(default_factory=dict)
    turns: dict[str, TurnRecord] = field(default_factory=dict)
    events: list[TraceEvent] = field(default_factory=list)
    retention: RetentionMetadata = field(default_factory=RetentionMetadata)
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "issues": {key: record.to_dict() for key, record in self.issues.items()},
            "runs": {key: record.to_dict() for key, record in self.runs.items()},
            "attempts": {key: record.to_dict() for key, record in self.attempts.items()},
            "turns": {key: record.to_dict() for key, record in self.turns.items()},
            "events": [event.to_dict() for event in self.events],
            "retention": self.retention.to_dict(),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> OpsSnapshot:
        return cls(
            schema_version=_int(payload.get("schema_version"), default=1),
            issues=_record_map(payload.get("issues"), IssueRecord),
            runs=_record_map(payload.get("runs"), RunRecord),
            attempts=_record_map(payload.get("attempts"), AttemptRecord),
            turns=_record_map(payload.get("turns"), TurnRecord),
            events=_record_list(payload.get("events"), TraceEvent),
            retention=RetentionMetadata.from_dict(_dict(payload.get("retention"))),
        )


def _record_map(value: Any, record_type: type[Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    records: dict[str, Any] = {}
    for key, payload in value.items():
        if isinstance(key, str) and isinstance(payload, dict):
            records[key] = record_type.from_dict(payload)
    return records


def _record_list(value: Any, record_type: type[Any]) -> list[Any]:
    if not isinstance(value, list):
        return []
    return [record_type.from_dict(item) for item in value if isinstance(item, dict)]


def _record_from_dict(record_type: type[Any], payload: dict[str, Any]) -> Any:
    allowed = {field.name for field in fields(record_type)}
    return record_type(**{key: value for key, value in payload.items() if key in allowed})


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int(value: Any, *, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default
