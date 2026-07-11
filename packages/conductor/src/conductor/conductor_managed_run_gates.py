from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any

from performer_api.managed_runs_plan import WorkItem
from performer_api.managed_runs_utils import _int, _jsonable_dict, _str_list


class GateStepSource(StrEnum):
    ISSUE_REQUIREMENT = "issue_requirement"
    ACCEPTANCE_APPENDIX = "acceptance_appendix"
    PLANNER_INFERRED = "planner_inferred"
    SYSTEM_REPAIR = "system_repair"


AUTHORITATIVE_GATE_STEP_SOURCES = {
    GateStepSource.ISSUE_REQUIREMENT,
    GateStepSource.ACCEPTANCE_APPENDIX,
    GateStepSource.SYSTEM_REPAIR,
}


@dataclass(frozen=True)
class GateStep:
    command: str
    source: GateStepSource

    def to_dict(self) -> dict[str, Any]:
        return {"command": self.command, "source": self.source.value}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateStep:
        return cls(
            command=str(payload.get("command") or payload.get("step") or ""),
            source=_gate_step_source(payload.get("source")),
        )


@dataclass(frozen=True)
class GateSnapshot:
    run_id: str
    work_item_id: str
    plan_version: int
    creator_attempt_id: str
    created_at: str
    acceptance_criteria: list[str]
    verification_procedure: list[GateStep]
    rubric_scores: dict[str, int] = field(default_factory=dict)
    pass_threshold: int = 3
    content_hash: str = ""
    frozen: bool = True

    @classmethod
    def from_work_item(
        cls,
        *,
        run_id: str,
        work_item: WorkItem,
        plan_version: int,
        creator_attempt_id: str,
        created_at: str,
    ) -> GateSnapshot:
        steps = [
            GateStep(command=work_item.verification.red_command, source=GateStepSource.ISSUE_REQUIREMENT),
            *[
                GateStep(command=command, source=GateStepSource.ISSUE_REQUIREMENT)
                for command in work_item.verification.green_commands
            ],
            *[
                GateStep(command=command, source=GateStepSource.PLANNER_INFERRED)
                for command in work_item.verification.runtime_checks
            ],
        ]
        snapshot = cls(
            run_id=run_id,
            work_item_id=work_item.id,
            plan_version=plan_version,
            creator_attempt_id=creator_attempt_id,
            created_at=created_at,
            acceptance_criteria=list(work_item.acceptance_criteria),
            verification_procedure=steps,
            rubric_scores={"correctness": 0, "quality": 0, "integration": 0, "documentation": 0, "ship_readiness": 0},
        )
        return replace(snapshot, content_hash=_content_hash(snapshot._canonical_payload()))

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._canonical_payload(),
            "content_hash": self.content_hash,
            "frozen": self.frozen,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSnapshot:
        return cls(
            run_id=str(payload.get("run_id") or ""),
            work_item_id=str(payload.get("work_item_id") or ""),
            plan_version=_int(payload.get("plan_version"), default=0),
            creator_attempt_id=str(payload.get("creator_attempt_id") or ""),
            created_at=str(payload.get("created_at") or ""),
            acceptance_criteria=_str_list(payload.get("acceptance_criteria")),
            verification_procedure=[
                GateStep.from_dict(item)
                for item in payload.get("verification_procedure") or []
                if isinstance(item, dict)
            ],
            rubric_scores={str(key): _int(value, default=0) for key, value in _jsonable_dict(payload.get("rubric_scores")).items()},
            pass_threshold=_int(payload.get("pass_threshold"), default=3),
            content_hash=str(payload.get("content_hash") or ""),
            frozen=bool(payload.get("frozen", True)),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.frozen:
            errors.append("gate_snapshot_not_frozen")
        if self.pass_threshold != 3:
            errors.append("pass_threshold_must_be_3")
        if not self.verification_procedure:
            errors.append("verification_procedure_required")
        if not any(step.source in AUTHORITATIVE_GATE_STEP_SOURCES for step in self.verification_procedure):
            errors.append("authoritative_gate_step_required")
        if any(not step.command.strip() for step in self.verification_procedure):
            errors.append("verification_command_required")
        if any(score < 0 or score > 4 for score in self.rubric_scores.values()):
            errors.append("rubric_score_out_of_range")
        expected_hash = _content_hash(self._canonical_payload())
        if not self.content_hash:
            errors.append("content_hash_required")
        elif self.content_hash != expected_hash:
            errors.append("content_hash_mismatch")
        return errors

    def _canonical_payload(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "work_item_id": self.work_item_id,
            "plan_version": self.plan_version,
            "creator_attempt_id": self.creator_attempt_id,
            "created_at": self.created_at,
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification_procedure": [step.to_dict() for step in self.verification_procedure],
            "rubric_scores": dict(sorted(self.rubric_scores.items())),
            "pass_threshold": self.pass_threshold,
        }


@dataclass(frozen=True)
class VerificationInputSnapshot:
    work_item_id: str
    execute_attempt_id: str
    base_revision: str
    branch_name: str
    commit_sha: str
    no_change: bool
    artifact_hashes: list[dict[str, Any]]
    declared_commands: list[str]
    evidence_uri: str
    gate_snapshot_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "work_item_id": self.work_item_id,
            "execute_attempt_id": self.execute_attempt_id,
            "base_revision": self.base_revision,
            "branch_name": self.branch_name,
            "commit_sha": self.commit_sha,
            "no_change": self.no_change,
            "artifact_hashes": [_jsonable_dict(item) for item in self.artifact_hashes],
            "declared_commands": list(self.declared_commands),
            "evidence_uri": self.evidence_uri,
            "gate_snapshot_hash": self.gate_snapshot_hash,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> VerificationInputSnapshot:
        return cls(
            work_item_id=str(payload.get("work_item_id") or ""),
            execute_attempt_id=str(payload.get("execute_attempt_id") or ""),
            base_revision=str(payload.get("base_revision") or ""),
            branch_name=str(payload.get("branch_name") or ""),
            commit_sha=str(payload.get("commit_sha") or ""),
            no_change=bool(payload.get("no_change")),
            artifact_hashes=[_jsonable_dict(item) for item in payload.get("artifact_hashes") or [] if isinstance(item, dict)],
            declared_commands=_str_list(payload.get("declared_commands")),
            evidence_uri=str(payload.get("evidence_uri") or ""),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
        )


@dataclass(frozen=True)
class TaskOutputManifest:
    work_item_id: str
    verify_attempt_id: str
    plan_version: int
    score: int
    branch_name: str
    commit_sha: str
    artifacts: list[dict[str, Any]]
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "work_item_id": self.work_item_id,
            "verify_attempt_id": self.verify_attempt_id,
            "plan_version": self.plan_version,
            "score": self.score,
            "branch_name": self.branch_name,
            "commit_sha": self.commit_sha,
            "artifacts": [_jsonable_dict(item) for item in self.artifacts],
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> TaskOutputManifest:
        return cls(
            work_item_id=str(payload.get("work_item_id") or ""),
            verify_attempt_id=str(payload.get("verify_attempt_id") or ""),
            plan_version=_int(payload.get("plan_version"), default=0),
            score=_int(payload.get("score"), default=0),
            branch_name=str(payload.get("branch_name") or ""),
            commit_sha=str(payload.get("commit_sha") or ""),
            artifacts=[_jsonable_dict(item) for item in payload.get("artifacts") or [] if isinstance(item, dict)],
            created_at=str(payload.get("created_at") or ""),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if self.score < 3:
            errors.append("score_below_pass_threshold")
        if self.score > 4:
            errors.append("score_above_maximum")
        if not self.verify_attempt_id:
            errors.append("verify_attempt_id_required")
        if not self.commit_sha:
            errors.append("commit_sha_required")
        return errors


def _gate_step_source(value: Any) -> GateStepSource:
    try:
        return GateStepSource(str(value))
    except ValueError:
        return GateStepSource.PLANNER_INFERRED


def _content_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


__all__ = ["GateSnapshot", "GateStep", "GateStepSource", "TaskOutputManifest", "VerificationInputSnapshot"]
