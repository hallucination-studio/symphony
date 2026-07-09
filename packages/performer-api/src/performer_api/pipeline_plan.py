from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any

from .pipeline_enums import (
    AttemptState,
    GateStep,
    GateStepSource,
    PASS_THRESHOLD,
    PlanValidatorError,
    RUBRIC_SCORES,
    RuntimeMode,
)
from .pipeline_graph import FencedAttemptResult, GateSpecContent, GateSpecSnapshot, GraphNode, canonical_gate_hash
from .pipeline_utils import (
    _dict,
    _has_cycle,
    _int,
    _merged_intent_payload,
    _optional_str,
    _str_list,
)


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
        requires_all_parallel_branches_for_downstream = bool(parallel_branch_node_ids and downstream_node_ids)
        return cls(
            issue_id=str(payload.get("issue_id") or ""),
            issue_identifier=str(payload.get("issue_identifier") or payload.get("issue_id") or ""),
            issue_description=str(payload.get("description") or payload.get("issue_description") or ""),
            required_gate_steps=required_gate_steps,
            requires_all_parallel_branches_for_downstream=requires_all_parallel_branches_for_downstream,
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


class PlanRepair:
    def __init__(self, intent_spec: IntentSpec):
        self.intent_spec = intent_spec

    def repair(self, proposal: PlanProposal) -> PlanProposal:
        next_blocks = self._repair_parallel_dependency_shape(proposal)
        normalized_gate_content = self._normalized_gate_content(proposal)
        target_node_ids = set(proposal.exit_node_ids or [node.node_id for node in proposal.nodes])
        next_gates: list[GateSpecSnapshot] = []
        changed_hash_by_task: dict[str, str] = {}
        for gate in proposal.gates:
            existing_content = normalized_gate_content.get(gate.task_id) or gate.content
            missing_required_steps = (
                [step for step in self.intent_spec.required_gate_steps if step not in existing_content.verification_procedure]
                if gate.task_id in target_node_ids
                else []
            )
            if not missing_required_steps and existing_content is gate.content:
                next_gates.append(gate)
                continue
            content = GateSpecContent(
                acceptance_criteria=[
                    *existing_content.acceptance_criteria,
                    *[
                        f"Preserve issue requirement verified by `{step.step}`."
                        for step in missing_required_steps
                    ],
                ],
                verification_procedure=[*existing_content.verification_procedure, *missing_required_steps],
                rubric=dict(existing_content.rubric),
                pass_threshold=existing_content.pass_threshold,
                verifier_credentials=list(existing_content.verifier_credentials),
            )
            updated = GateSpecSnapshot.create(
                gate_id=gate.gate_id,
                task_id=gate.task_id,
                created_by=gate.created_by or proposal.plan_attempt_id,
                created_at=gate.created_at,
                content=content,
                version=gate.version,
            )
            next_gates.append(updated)
            changed_hash_by_task[updated.task_id] = updated.hash
        blocks_changed = next_blocks != list(proposal.blocks)
        if not changed_hash_by_task and not blocks_changed:
            return proposal
        next_nodes = [
            replace(node, gate_snapshot_hash=changed_hash_by_task[node.node_id])
            if node.node_id in changed_hash_by_task
            else node
            for node in proposal.nodes
        ]
        entry_node_ids, exit_node_ids = (
            _entry_exit_node_ids_for_blocks(
                _entry_exit_nodes_for_intent(next_nodes, proposal.root_node_id, self.intent_spec),
                next_blocks,
            )
            if blocks_changed
            else (list(proposal.entry_node_ids), list(proposal.exit_node_ids))
        )
        return PlanProposal(
            graph_id=proposal.graph_id,
            plan_attempt_id=proposal.plan_attempt_id,
            root_node_id=proposal.root_node_id,
            nodes=next_nodes,
            blocks=next_blocks,
            gates=next_gates,
            entry_node_ids=entry_node_ids,
            exit_node_ids=exit_node_ids,
        )

    def _repair_parallel_dependency_shape(self, proposal: PlanProposal) -> list[tuple[str, str]]:
        if not self.intent_spec.requires_all_parallel_branches_for_downstream:
            return list(proposal.blocks)
        required_edges = _required_parallel_dependency_edges(proposal, self.intent_spec)
        if not required_edges:
            return list(proposal.blocks)
        next_blocks = list(dict.fromkeys(proposal.blocks))
        next_block_set = set(next_blocks)
        for edge in required_edges:
            if edge not in next_block_set:
                next_blocks.append(edge)
                next_block_set.add(edge)
        return next_blocks

    def _normalized_gate_content(self, proposal: PlanProposal) -> dict[str, GateSpecContent]:
        normalized: dict[str, GateSpecContent] = {}
        required_steps = {step.step for step in self.intent_spec.required_gate_steps}
        for gate in proposal.gates:
            commands = list(gate.content.verification_procedure)
            next_commands: list[GateStep] = []
            changed = False
            for command in commands:
                if (
                    _looks_like_model_exact_text_gate_step(command)
                    and command.step not in required_steps
                    and command.source is not GateStepSource.PLANNER_INFERRED
                ):
                    next_commands.append(GateStep(command.step, GateStepSource.PLANNER_INFERRED))
                    changed = True
                else:
                    next_commands.append(command)
            if not changed:
                continue
            normalized[gate.task_id] = GateSpecContent(
                acceptance_criteria=[
                    criterion
                    for criterion in gate.content.acceptance_criteria
                    if "exact marker" not in criterion.lower()
                ],
                verification_procedure=next_commands,
                rubric=dict(gate.content.rubric),
                pass_threshold=gate.content.pass_threshold,
                verifier_credentials=list(gate.content.verifier_credentials),
            )
        return normalized

class PlanValidator:
    def __init__(
        self,
        *,
        max_subtasks: int = 50,
        verifier_credentials: set[str] | None = None,
        intent_spec: IntentSpec | None = None,
    ):
        self.max_subtasks = max_subtasks
        self.verifier_credentials = set(verifier_credentials or set())
        self.intent_spec = intent_spec

    def validate(self, proposal: PlanProposal) -> set[PlanValidatorError]:
        errors: set[PlanValidatorError] = set()
        node_id_list = [node.node_id for node in proposal.nodes]
        node_ids = set(node_id_list)
        executable_nodes = _entry_exit_nodes_for_intent(proposal.nodes, proposal.root_node_id, self.intent_spec)
        executable_node_ids = {node.node_id for node in executable_nodes}
        gate_task_list = [gate.task_id for gate in proposal.gates]
        gate_id_list = [gate.gate_id for gate in proposal.gates]
        gate_by_task = {gate.task_id: gate for gate in proposal.gates}
        if not node_ids:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        if len(node_id_list) != len(node_ids):
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if len(gate_task_list) != len(set(gate_task_list)) or len(gate_id_list) != len(set(gate_id_list)):
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if len(proposal.nodes) > self.max_subtasks:
            errors.add(PlanValidatorError.POLICY_LIMIT_EXCEEDED)
        if not proposal.entry_node_ids or not proposal.exit_node_ids:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        if not set(proposal.entry_node_ids).issubset(executable_node_ids) or not set(proposal.exit_node_ids).issubset(executable_node_ids):
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        legal_edges = [(source, target) for source, target in proposal.blocks if source in node_ids and target in node_ids and source != target]
        executable_edges = [
            (source, target)
            for source, target in legal_edges
            if source in executable_node_ids and target in executable_node_ids
        ]
        computed_entries = executable_node_ids - {target for _source, target in executable_edges}
        computed_exits = executable_node_ids - {source for source, _target in executable_edges}
        if set(proposal.entry_node_ids) != computed_entries or set(proposal.exit_node_ids) != computed_exits:
            errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
        for node in proposal.nodes:
            gate = gate_by_task.get(node.node_id)
            if gate is None or not node.gate_snapshot_hash:
                errors.add(PlanValidatorError.MISSING_GATE)
                continue
            if node.gate_snapshot_hash != gate.hash:
                errors.add(PlanValidatorError.MISSING_GATE)
            self._validate_gate(gate, errors)
        for source, target in proposal.blocks:
            if source not in node_ids or target not in node_ids or source == target:
                errors.add(PlanValidatorError.ILLEGAL_EDGE)
        parent_by_child = {node.node_id: node.parent_node_id for node in proposal.nodes if node.parent_node_id}
        for source, target in proposal.blocks:
            if parent_by_child.get(target) == source:
                errors.add(PlanValidatorError.ILLEGAL_EDGE)
        if _has_cycle(node_ids, proposal.blocks):
            errors.add(PlanValidatorError.CYCLE_DETECTED)
        if self.intent_spec is not None and self.intent_spec.requires_all_parallel_branches_for_downstream:
            required_edges = set(_required_parallel_dependency_edges(proposal, self.intent_spec))
            if not required_edges.issubset(set(proposal.blocks)):
                errors.add(PlanValidatorError.REQUIRED_PARALLEL_SHAPE_MISSING)
        return errors

    def _validate_gate(self, gate: GateSpecSnapshot, errors: set[PlanValidatorError]) -> None:
        content = gate.content
        if not gate.frozen or gate.hash != canonical_gate_hash(content):
            errors.add(PlanValidatorError.MISSING_GATE)
        if not content.verification_procedure or not all(step.strip() for step in content.verification_procedure):
            errors.add(PlanValidatorError.GATE_UNEXECUTABLE)
        if any(not step.has_valid_source for step in content.verification_procedure):
            errors.add(PlanValidatorError.INVALID_GATE_STEP_SOURCE)
        if content.verification_procedure and not any(step.is_authoritative for step in content.verification_procedure):
            errors.add(PlanValidatorError.NO_AUTHORITATIVE_GATE_STEP)
        if set(content.rubric) != RUBRIC_SCORES or any(not str(value).strip() for value in content.rubric.values()):
            errors.add(PlanValidatorError.INCOMPLETE_RUBRIC)
        if content.pass_threshold != PASS_THRESHOLD:
            errors.add(PlanValidatorError.LOWERED_THRESHOLD)
        unavailable_credentials = set(content.verifier_credentials) - self.verifier_credentials
        if unavailable_credentials:
            errors.add(PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE)
        for step in content.verification_procedure:
            lowered = step.lower()
            if "executor workspace" in lowered or "$executor_" in lowered:
                errors.add(PlanValidatorError.EXECUTOR_ONLY_GATE_DEPENDENCY)
            if not _looks_like_executable_gate_command(step):
                errors.add(PlanValidatorError.GATE_UNEXECUTABLE)

def _looks_like_model_exact_text_gate_step(command: GateStep) -> bool:
    lowered = command.step.lower()
    return "grep -q" in lowered or lowered.startswith("git diff --") or " git diff --" in lowered


def _required_parallel_dependency_edges(proposal: PlanProposal, intent_spec: IntentSpec) -> list[tuple[str, str]]:
    node_by_id = {node.node_id: node for node in proposal.nodes}
    node_ids = set(node_by_id)
    parallel_node_ids = [node_id for node_id in intent_spec.parallel_branch_node_ids if node_id in node_ids]
    if len(parallel_node_ids) < 2:
        return []
    downstream_node_ids = [
        node_id
        for node_id in intent_spec.downstream_node_ids
        if node_id in node_ids and node_id not in parallel_node_ids
    ]
    if not downstream_node_ids:
        return []
    required_edges: list[tuple[str, str]] = []
    for downstream_node_id in downstream_node_ids:
        for parallel_node_id in parallel_node_ids:
            edge = (parallel_node_id, downstream_node_id)
            if _has_block_path(downstream_node_id, parallel_node_id, proposal.blocks):
                continue
            required_edges.append(edge)
    return list(dict.fromkeys(required_edges))


def _has_block_path(source: str, target: str, blocks: list[tuple[str, str]]) -> bool:
    pending = [source]
    seen: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target:
            return True
        if current in seen:
            continue
        seen.add(current)
        pending.extend(next_node for from_node, next_node in blocks if from_node == current and next_node not in seen)
    return False


def _entry_exit_node_ids_for_blocks(
    nodes: list[GraphNode],
    blocks: list[tuple[str, str]],
) -> tuple[list[str], list[str]]:
    node_ids = {node.node_id for node in nodes}
    incoming = {target for source, target in blocks if source in node_ids and target in node_ids}
    outgoing = {source for source, target in blocks if source in node_ids and target in node_ids}
    ordered_node_ids = [node.node_id for node in nodes]
    return (
        [node_id for node_id in ordered_node_ids if node_id not in incoming],
        [node_id for node_id in ordered_node_ids if node_id not in outgoing],
    )


def _entry_exit_nodes_for_intent(
    nodes: list[GraphNode],
    root_node_id: str,
    intent_spec: IntentSpec | None,
) -> list[GraphNode]:
    return list(nodes)


def _looks_like_executable_gate_command(step: str) -> bool:
    candidate = step.strip()
    if not candidate:
        return False
    lowered = candidate.lower()
    prose_prefixes = (
        "check ",
        "confirm ",
        "ensure ",
        "from ",
        "read ",
        "run ",
        "verify ",
        "validate ",
    )
    if lowered.startswith(prose_prefixes):
        return False
    if "`" in candidate:
        return False
    return True
