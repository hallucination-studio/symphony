from __future__ import annotations

from dataclasses import replace

from .pipeline_enums import GateStepSource
from .pipeline_graph import GateSpecContent, GateSpecSnapshot, GraphNode
from .pipeline_plan_models import IntentSpec, PlanProposal


class PlanRepair:
    def __init__(self, intent_spec: IntentSpec):
        self.intent_spec = intent_spec

    def repair(self, proposal: PlanProposal) -> PlanProposal:
        next_blocks = self._repair_parallel_dependency_shape(proposal)
        return _repair_gate_content(proposal, self.intent_spec, next_blocks)

    def _repair_parallel_dependency_shape(self, proposal: PlanProposal) -> list[tuple[str, str]]:
        if not self.intent_spec.requires_all_parallel_branches_for_downstream:
            return list(proposal.blocks)
        required_edges = required_parallel_dependency_edges(proposal, self.intent_spec)
        if not required_edges:
            return list(proposal.blocks)
        next_blocks = list(dict.fromkeys(proposal.blocks))
        next_block_set = set(next_blocks)
        for edge in required_edges:
            if edge not in next_block_set:
                next_blocks.append(edge)
                next_block_set.add(edge)
        return next_blocks


def _repair_gate_content(
    proposal: PlanProposal,
    intent_spec: IntentSpec,
    next_blocks: list[tuple[str, str]],
) -> PlanProposal:
    normalized_gate_content = _normalized_gate_content(proposal, intent_spec)
    next_gates, changed_hash_by_task = _repaired_gates(proposal, intent_spec, normalized_gate_content)
    blocks_changed = next_blocks != list(proposal.blocks)
    if not changed_hash_by_task and not blocks_changed:
        return proposal
    next_nodes = _nodes_with_repaired_gate_hashes(proposal.nodes, changed_hash_by_task)
    entry_node_ids, exit_node_ids = _repaired_entry_exit_ids(proposal, intent_spec, next_nodes, next_blocks)
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


def _repaired_gates(
    proposal: PlanProposal,
    intent_spec: IntentSpec,
    normalized_gate_content: dict[str, GateSpecContent],
) -> tuple[list[GateSpecSnapshot], dict[str, str]]:
    target_node_ids = set(proposal.exit_node_ids or [node.node_id for node in proposal.nodes])
    next_gates: list[GateSpecSnapshot] = []
    changed_hash_by_task: dict[str, str] = {}
    for gate in proposal.gates:
        existing_content = normalized_gate_content.get(gate.task_id) or gate.content
        missing_steps = _missing_required_gate_steps(intent_spec, gate.task_id, target_node_ids, existing_content)
        if not missing_steps and existing_content is gate.content:
            next_gates.append(gate)
            continue
        updated = _gate_with_required_steps(gate, proposal.plan_attempt_id, existing_content, missing_steps)
        next_gates.append(updated)
        changed_hash_by_task[updated.task_id] = updated.hash
    return next_gates, changed_hash_by_task


def _missing_required_gate_steps(intent_spec, task_id, target_node_ids, existing_content):
    if task_id not in target_node_ids:
        return []
    return [step for step in intent_spec.required_gate_steps if step not in existing_content.verification_procedure]


def _gate_with_required_steps(gate, plan_attempt_id, existing_content, missing_steps):
    content = GateSpecContent(
        acceptance_criteria=[
            *existing_content.acceptance_criteria,
            *[f"Preserve issue requirement verified by `{step.step}`." for step in missing_steps],
        ],
        verification_procedure=[*existing_content.verification_procedure, *missing_steps],
        rubric=dict(existing_content.rubric),
        pass_threshold=existing_content.pass_threshold,
        verifier_credentials=list(existing_content.verifier_credentials),
    )
    return GateSpecSnapshot.create(
        gate_id=gate.gate_id,
        task_id=gate.task_id,
        created_by=gate.created_by or plan_attempt_id,
        created_at=gate.created_at,
        content=content,
        version=gate.version,
    )


def _normalized_gate_content(proposal: PlanProposal, intent_spec: IntentSpec) -> dict[str, GateSpecContent]:
    normalized: dict[str, GateSpecContent] = {}
    required_steps = {step.step for step in intent_spec.required_gate_steps}
    for gate in proposal.gates:
        next_commands, changed = _normalized_gate_commands(gate.content.verification_procedure, required_steps)
        if not changed:
            continue
        normalized[gate.task_id] = GateSpecContent(
            acceptance_criteria=[c for c in gate.content.acceptance_criteria if "exact marker" not in c.lower()],
            verification_procedure=next_commands,
            rubric=dict(gate.content.rubric),
            pass_threshold=gate.content.pass_threshold,
            verifier_credentials=list(gate.content.verifier_credentials),
        )
    return normalized


def _normalized_gate_commands(commands, required_steps):
    next_commands = []
    changed = False
    for command in commands:
        if _should_mark_planner_inferred(command, required_steps):
            next_commands.append(type(command)(command.step, GateStepSource.PLANNER_INFERRED))
            changed = True
        else:
            next_commands.append(command)
    return next_commands, changed


def _should_mark_planner_inferred(command, required_steps) -> bool:
    return (
        looks_like_model_exact_text_gate_step(command)
        and command.step not in required_steps
        and command.source is not GateStepSource.PLANNER_INFERRED
    )


def _nodes_with_repaired_gate_hashes(nodes, changed_hash_by_task):
    return [
        replace(node, gate_snapshot_hash=changed_hash_by_task[node.node_id])
        if node.node_id in changed_hash_by_task
        else node
        for node in nodes
    ]


def _repaired_entry_exit_ids(proposal, intent_spec, next_nodes, next_blocks):
    if next_blocks == list(proposal.blocks):
        return list(proposal.entry_node_ids), list(proposal.exit_node_ids)
    return entry_exit_node_ids_for_blocks(entry_exit_nodes_for_intent(next_nodes, proposal.root_node_id, intent_spec), next_blocks)


def looks_like_model_exact_text_gate_step(command) -> bool:
    lowered = command.step.lower()
    return "grep -q" in lowered or lowered.startswith("git diff --") or " git diff --" in lowered


def required_parallel_dependency_edges(proposal: PlanProposal, intent_spec: IntentSpec) -> list[tuple[str, str]]:
    node_by_id = {node.node_id: node for node in proposal.nodes}
    node_ids = set(node_by_id)
    parallel_node_ids = [node_id for node_id in intent_spec.parallel_branch_node_ids if node_id in node_ids]
    if len(parallel_node_ids) < 2:
        return []
    downstream_node_ids = [
        node_id for node_id in intent_spec.downstream_node_ids if node_id in node_ids and node_id not in parallel_node_ids
    ]
    required_edges = _required_edges_for_downstreams(downstream_node_ids, parallel_node_ids, proposal.blocks)
    return list(dict.fromkeys(required_edges))


def _required_edges_for_downstreams(downstream_node_ids, parallel_node_ids, blocks):
    required_edges: list[tuple[str, str]] = []
    for downstream_node_id in downstream_node_ids:
        for parallel_node_id in parallel_node_ids:
            if not has_block_path(downstream_node_id, parallel_node_id, blocks):
                required_edges.append((parallel_node_id, downstream_node_id))
    return required_edges


def has_block_path(source: str, target: str, blocks: list[tuple[str, str]]) -> bool:
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


def entry_exit_node_ids_for_blocks(nodes: list[GraphNode], blocks: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    node_ids = {node.node_id for node in nodes}
    incoming = {target for source, target in blocks if source in node_ids and target in node_ids}
    outgoing = {source for source, target in blocks if source in node_ids and target in node_ids}
    ordered_node_ids = [node.node_id for node in nodes]
    return (
        [node_id for node_id in ordered_node_ids if node_id not in incoming],
        [node_id for node_id in ordered_node_ids if node_id not in outgoing],
    )


def entry_exit_nodes_for_intent(
    nodes: list[GraphNode],
    root_node_id: str,
    intent_spec: IntentSpec | None,
) -> list[GraphNode]:
    return list(nodes)
