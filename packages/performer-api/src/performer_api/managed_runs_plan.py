from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from performer_api.managed_runs_enums import WorkItemSliceType
from performer_api.managed_runs_utils import _dict, _enum, _jsonable_dict, _str_list, _optional_str


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

