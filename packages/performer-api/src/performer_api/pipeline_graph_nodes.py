from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .pipeline_enums import GraphNodeState, HumanEscalationReason
from .pipeline_utils import _int, _optional_int, _optional_str, _str_list


@dataclass(frozen=True)
class GraphNode:
    node_id: str
    title: str
    state: GraphNodeState
    issue_id: str | None = None
    issue_identifier: str | None = None
    parent_node_id: str | None = None
    gate_snapshot_hash: str | None = None
    verify_score: int | None = None
    rework_count: int = 0
    replan_depth: int = 0
    superseded_by: list[str] = field(default_factory=list)
    human_reason: HumanEscalationReason | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "title": self.title,
            "state": self.state.value,
            "issue_id": self.issue_id,
            "issue_identifier": self.issue_identifier,
            "parent_node_id": self.parent_node_id,
            "gate_snapshot_hash": self.gate_snapshot_hash,
            "verify_score": self.verify_score,
            "rework_count": self.rework_count,
            "replan_depth": self.replan_depth,
            "superseded_by": list(self.superseded_by),
            "human_reason": self.human_reason.value if self.human_reason is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GraphNode:
        reason = payload.get("human_reason")
        return cls(
            node_id=str(payload.get("node_id") or ""),
            title=str(payload.get("title") or ""),
            state=GraphNodeState.from_value(payload.get("state") or GraphNodeState.PLANNED.value),
            issue_id=_optional_str(payload.get("issue_id")),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            parent_node_id=_optional_str(payload.get("parent_node_id")),
            gate_snapshot_hash=_optional_str(payload.get("gate_snapshot_hash")),
            verify_score=_optional_int(payload.get("verify_score")),
            rework_count=_int(payload.get("rework_count"), default=0),
            replan_depth=_int(payload.get("replan_depth"), default=0),
            superseded_by=_str_list(payload.get("superseded_by")),
            human_reason=HumanEscalationReason(str(reason)) if reason else None,
        )
