from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any, Literal


class RunPhase(StrEnum):
    QUEUED = "queued"
    IMPLEMENTING = "implementing"
    AWAITING_HUMAN = "awaiting_human"
    REVIEWING = "reviewing"
    REWORKING = "reworking"
    DONE = "done"
    FAILED = "failed"


PhaseStatus = Literal[
    "accepted",
    "completed",
    "failed",
    "awaiting_human",
    "init_failed",
    "retry",
    "reviewing",
    "reworking",
    "skipped",
]


@dataclass(frozen=True)
class PhaseAdvanceRequest:
    run_id: str
    instance_id: str
    issue_id: str
    issue_identifier: str | None
    current_phase: RunPhase
    attempt: int
    human_response: str | None = None
    workflow_profile: str | None = None
    workspace_context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["current_phase"] = self.current_phase.value
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PhaseAdvanceRequest:
        return cls(
            run_id=str(payload.get("run_id") or ""),
            instance_id=str(payload.get("instance_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            current_phase=RunPhase(str(payload.get("current_phase") or RunPhase.QUEUED.value)),
            attempt=_int(payload.get("attempt"), default=1),
            human_response=_optional_str(payload.get("human_response")),
            workflow_profile=_optional_str(payload.get("workflow_profile")),
            workspace_context=_dict(payload.get("workspace_context")),
        )


@dataclass(frozen=True)
class PhaseAdvanceResult:
    run_id: str
    issue_id: str
    next_phase: RunPhase
    status: PhaseStatus | str
    reason: str | None = None
    retry_delay_seconds: int | None = None
    human_action: dict[str, Any] | None = None
    workspace_path: str | None = None
    ops_snapshot_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["next_phase"] = self.next_phase.value
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PhaseAdvanceResult:
        return cls(
            run_id=str(payload.get("run_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            next_phase=RunPhase(str(payload.get("next_phase") or RunPhase.FAILED.value)),
            status=str(payload.get("status") or "failed"),
            reason=_optional_str(payload.get("reason")),
            retry_delay_seconds=_optional_int(payload.get("retry_delay_seconds")),
            human_action=_optional_dict(payload.get("human_action")),
            workspace_path=_optional_str(payload.get("workspace_path")),
            ops_snapshot_path=_optional_str(payload.get("ops_snapshot_path")),
        )


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


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


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _optional_dict(value: Any) -> dict[str, Any] | None:
    return dict(value) if isinstance(value, dict) else None
