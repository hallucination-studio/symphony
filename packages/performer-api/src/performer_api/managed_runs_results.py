from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from performer_api.managed_runs_enums import CanonicalAgentEventType, LinearChangeClass, LinearRevisionAction, WorkItemResultStatus
from performer_api.managed_runs_utils import _dict, _enum, _int, _jsonable_dict, _optional_str, _str_list


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
