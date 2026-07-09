from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .pipeline_enums import AttemptState, GateStep, RuntimeMode
from .pipeline_graph import FencedAttemptResult, GateSpecSnapshot, GraphNode
from .pipeline_utils import _dict, _int, _merged_intent_payload, _optional_str, _str_list


@dataclass(frozen=True)
class IntentSpec:
    issue_id: str
    issue_identifier: str
    issue_description: str
    required_gate_steps: list[GateStep] = field(default_factory=list)
    requires_all_parallel_branches_for_downstream: bool = False
    parallel_branch_node_ids: list[str] = field(default_factory=list)
    downstream_node_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_issue(
        cls,
        *,
        issue_id: str,
        issue_identifier: str,
        issue_description: str,
    ) -> IntentSpec:
        return cls(
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            issue_description=issue_description,
        )

    @classmethod
    def from_dispatch_context(cls, payload: dict[str, Any]) -> IntentSpec:
        intent = _merged_intent_payload(payload)
        shape = intent.get("parallel_dependency_shape")
        if not isinstance(shape, dict):
            shape = intent
        parallel_branch_node_ids = _str_list(shape.get("parallel_branch_node_ids"))
        downstream_node_ids = _str_list(shape.get("downstream_node_ids"))
        required_gate_steps = [
            GateStep.from_obj(step)
            for step in intent.get("required_gate_steps") or []
            if isinstance(step, (dict, str, GateStep))
        ]
        return cls(
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=str(payload.get("issue_identifier") or payload.get("issue_id") or ""),
            issue_description=str(payload.get("description") or payload.get("issue_description") or ""),
            required_gate_steps=required_gate_steps,
            requires_all_parallel_branches_for_downstream=bool(parallel_branch_node_ids and downstream_node_ids),
            parallel_branch_node_ids=parallel_branch_node_ids,
            downstream_node_ids=downstream_node_ids,
        )


@dataclass(frozen=True)
class PlanAttemptRequest:
    attempt_id: str
    graph_id: str
    root_node_id: str
    node_id: str
    issue_id: str
    issue_identifier: str | None
    title: str
    graph_revision: int
    policy_revision: int
    lease_id: str
    fencing_token: str
    workspace_path: str
    thread_state_workspace_path: str | None = None
    issue_description: str = ""
    pipeline_intent: dict[str, Any] = field(default_factory=dict)
    failure_context: dict[str, Any] = field(default_factory=dict)
    expected_thread_id: str | None = None
    kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanAttemptRequest:
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            graph_id=str(payload.get("graph_id") or ""),
            root_node_id=str(payload.get("root_node_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=_optional_str(payload.get("issue_identifier")),
            title=str(payload.get("title") or ""),
            issue_description=str(payload.get("issue_description") or ""),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            workspace_path=str(payload.get("workspace_path") or ""),
            thread_state_workspace_path=_optional_str(payload.get("thread_state_workspace_path")),
            pipeline_intent=_dict(payload.get("pipeline_intent")),
            failure_context=_dict(payload.get("failure_context")),
            expected_thread_id=_optional_str(payload.get("expected_thread_id")),
            kind=_optional_str(payload.get("kind")),
        )


@dataclass(frozen=True)
class PlanProposal:
    graph_id: str
    plan_attempt_id: str
    root_node_id: str
    nodes: list[GraphNode]
    blocks: list[tuple[str, str]]
    gates: list[GateSpecSnapshot]
    entry_node_ids: list[str]
    exit_node_ids: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "graph_id": self.graph_id,
            "plan_attempt_id": self.plan_attempt_id,
            "root_node_id": self.root_node_id,
            "nodes": [node.to_dict() for node in self.nodes],
            "blocks": [[source, target] for source, target in self.blocks],
            "gates": [gate.to_dict() for gate in self.gates],
            "entry_node_ids": list(self.entry_node_ids),
            "exit_node_ids": list(self.exit_node_ids),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanProposal:
        blocks: list[tuple[str, str]] = []
        for edge in payload.get("blocks") or []:
            if isinstance(edge, (list, tuple)) and len(edge) == 2:
                blocks.append((str(edge[0]), str(edge[1])))
        return cls(
            graph_id=str(payload.get("graph_id") or ""),
            plan_attempt_id=str(payload.get("plan_attempt_id") or ""),
            root_node_id=str(payload.get("root_node_id") or ""),
            nodes=[GraphNode.from_dict(item) for item in payload.get("nodes") or [] if isinstance(item, dict)],
            blocks=blocks,
            gates=[GateSpecSnapshot.from_dict(item) for item in payload.get("gates") or [] if isinstance(item, dict)],
            entry_node_ids=_str_list(payload.get("entry_node_ids")),
            exit_node_ids=_str_list(payload.get("exit_node_ids")),
        )


@dataclass(frozen=True)
class PlanAttemptResult(FencedAttemptResult):
    proposal: PlanProposal | None = None
    mode: RuntimeMode = RuntimeMode.PLAN

    def to_dict(self) -> dict[str, Any]:
        payload = self._base_dict()
        payload["proposal"] = self.proposal.to_dict() if self.proposal is not None else None
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PlanAttemptResult:
        proposal_payload = payload.get("proposal")
        return cls(
            attempt_id=str(payload.get("attempt_id") or ""),
            node_id=str(payload.get("node_id") or ""),
            status=AttemptState(str(payload.get("status") or AttemptState.PENDING.value)),
            graph_revision=_int(payload.get("graph_revision"), default=0),
            policy_revision=_int(payload.get("policy_revision"), default=0),
            gate_snapshot_hash=str(payload.get("gate_snapshot_hash") or ""),
            lease_id=str(payload.get("lease_id") or ""),
            fencing_token=str(payload.get("fencing_token") or ""),
            error=_optional_str(payload.get("error")),
            thread_id=_optional_str(payload.get("thread_id")),
            kind=_optional_str(payload.get("kind")),
            proposal=PlanProposal.from_dict(proposal_payload) if isinstance(proposal_payload, dict) else None,
        )
