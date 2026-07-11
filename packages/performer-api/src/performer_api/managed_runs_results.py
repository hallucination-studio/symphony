from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from performer_api.managed_runs_enums import WorkItemResultStatus
from performer_api.managed_runs_utils import _dict, _enum, _jsonable_dict, _optional_str, _str_list


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
