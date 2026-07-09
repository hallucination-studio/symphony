from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from .pipeline_enums import GateStep, PASS_THRESHOLD
from .pipeline_utils import _dict, _gate_steps, _int, _jsonable_dict, _str_list


@dataclass(frozen=True)
class GateSpecContent:
    acceptance_criteria: list[str]
    verification_procedure: list[GateStep | str | dict[str, Any]]
    rubric: dict[str, str]
    pass_threshold: int = PASS_THRESHOLD
    verifier_credentials: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.pass_threshold != PASS_THRESHOLD:
            raise ValueError(f"pass_threshold must be {PASS_THRESHOLD}")
        object.__setattr__(
            self,
            "verification_procedure",
            [GateStep.from_obj(step) for step in self.verification_procedure if step is not None],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "acceptance_criteria": list(self.acceptance_criteria),
            "verification_procedure": [step.to_dict() for step in self.verification_procedure],
            "rubric": dict(sorted(self.rubric.items())),
            "pass_threshold": self.pass_threshold,
            "verifier_credentials": list(self.verifier_credentials),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecContent:
        return cls(
            acceptance_criteria=_str_list(payload.get("acceptance_criteria")),
            verification_procedure=_gate_steps(payload.get("verification_procedure")),
            rubric={str(key): str(value) for key, value in _dict(payload.get("rubric")).items()},
            pass_threshold=_int(payload.get("pass_threshold"), default=PASS_THRESHOLD),
            verifier_credentials=_str_list(payload.get("verifier_credentials")),
        )


@dataclass(frozen=True)
class GateSpecSnapshot:
    gate_id: str
    task_id: str
    version: int
    created_by: str
    created_at: str
    content: GateSpecContent
    hash: str
    frozen: bool = True

    @classmethod
    def create(
        cls,
        *,
        gate_id: str,
        task_id: str,
        created_by: str,
        created_at: str,
        content: GateSpecContent,
        version: int = 1,
    ) -> GateSpecSnapshot:
        return cls(
            gate_id=gate_id,
            task_id=task_id,
            version=version,
            created_by=created_by,
            created_at=created_at,
            content=content,
            hash=canonical_gate_hash(content),
            frozen=True,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "task_id": self.task_id,
            "version": self.version,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "content": self.content.to_dict(),
            "hash": self.hash,
            "frozen": self.frozen,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GateSpecSnapshot:
        content = GateSpecContent.from_dict(_dict(payload.get("content")))
        gate_hash = str(payload.get("hash") or canonical_gate_hash(content))
        expected = canonical_gate_hash(content)
        if gate_hash != expected:
            raise ValueError("gate hash does not match canonical content")
        return cls(
            gate_id=str(payload.get("gate_id") or ""),
            task_id=str(payload.get("task_id") or ""),
            version=_int(payload.get("version"), default=1),
            created_by=str(payload.get("created_by") or ""),
            created_at=str(payload.get("created_at") or ""),
            content=content,
            hash=gate_hash,
            frozen=bool(payload.get("frozen", True)),
        )


def canonical_gate_hash(content: GateSpecContent | dict[str, Any]) -> str:
    payload = content.to_dict() if isinstance(content, GateSpecContent) else _jsonable_dict(content)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()
