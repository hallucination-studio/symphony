from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _strings(values: list[str] | None) -> list[str]:
    return [str(value) for value in values or []]


@dataclass(frozen=True)
class Task:
    id: str
    title: str
    objective: str
    acceptance_criteria: list[str]
    verification_commands: list[str]
    files_likely_touched: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "objective": self.objective,
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification_commands": list(self.verification_commands),
            "files_likely_touched": list(self.files_likely_touched),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Task:
        return cls(
            id=str(payload.get("id") or ""),
            title=str(payload.get("title") or ""),
            objective=str(payload.get("objective") or ""),
            acceptance_criteria=_strings(payload.get("acceptance_criteria")),
            verification_commands=_strings(payload.get("verification_commands")),
            files_likely_touched=_strings(payload.get("files_likely_touched")),
        )


@dataclass(frozen=True)
class AcceptanceCatalog:
    id: str
    rubric: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "rubric": dict(self.rubric)}

    @classmethod
    def from_dict(cls, payload: dict[str, Any] | None) -> AcceptanceCatalog | None:
        if not isinstance(payload, dict):
            return None
        rubric = payload.get("rubric")
        return cls(
            id=str(payload.get("id") or ""),
            rubric={str(key): dict(value) for key, value in (rubric or {}).items() if isinstance(value, dict)},
        )


@dataclass(frozen=True)
class Plan:
    summary: str
    tasks: list[Task]
    risks: list[str] = field(default_factory=list)
    architecture_decisions: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    acceptance_catalog: AcceptanceCatalog | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "summary": self.summary,
            "tasks": [task.to_dict() for task in self.tasks],
            "risks": list(self.risks),
            "architecture_decisions": list(self.architecture_decisions),
            "open_questions": list(self.open_questions),
        }
        if self.acceptance_catalog is not None:
            payload["acceptance_catalog"] = self.acceptance_catalog.to_dict()
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Plan:
        return cls(
            summary=str(payload.get("summary") or ""),
            tasks=[Task.from_dict(item) for item in payload.get("tasks") or [] if isinstance(item, dict)],
            risks=_strings(payload.get("risks")),
            architecture_decisions=_strings(payload.get("architecture_decisions")),
            open_questions=_strings(payload.get("open_questions")),
            acceptance_catalog=AcceptanceCatalog.from_dict(payload.get("acceptance_catalog")),
        )


@dataclass(frozen=True)
class PlanRevision:
    version: int
    reason: str
    status: str
    policy_revision: int
    plan: Plan
    approval_id: str = ""
    manifest_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "reason": self.reason,
            "status": self.status,
            "policy_revision": self.policy_revision,
            "plan": self.plan.to_dict(),
            "approval_id": self.approval_id,
            "manifest_refs": list(self.manifest_refs),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanRevision:
        return cls(
            version=int(payload.get("version") or 0),
            reason=str(payload.get("reason") or ""),
            status=str(payload.get("status") or "draft"),
            policy_revision=int(payload.get("policy_revision") or 0),
            plan=Plan.from_dict(payload.get("plan") or {}),
            approval_id=str(payload.get("approval_id") or ""),
            manifest_refs=_strings(payload.get("manifest_refs")),
        )
