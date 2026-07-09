from __future__ import annotations

from .pipeline_enums import PASS_THRESHOLD, PlanValidatorError, RUBRIC_SCORES
from .pipeline_graph import GateSpecSnapshot, canonical_gate_hash
from .pipeline_plan_models import IntentSpec, PlanProposal
from .pipeline_plan_repair import entry_exit_nodes_for_intent, required_parallel_dependency_edges
from .pipeline_utils import _has_cycle


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
        context = _validation_context(proposal, self.intent_spec)
        _validate_node_and_gate_shape(proposal, context, self.max_subtasks, errors)
        _validate_gate_contents(proposal.gates, self.verifier_credentials, errors)
        _validate_edges(proposal, context, errors)
        _validate_parallel_shape(proposal, self.intent_spec, errors)
        return errors


def _validation_context(proposal: PlanProposal, intent_spec: IntentSpec | None) -> dict[str, object]:
    node_id_list = [node.node_id for node in proposal.nodes]
    node_ids = set(node_id_list)
    executable_nodes = entry_exit_nodes_for_intent(proposal.nodes, proposal.root_node_id, intent_spec)
    executable_node_ids = {node.node_id for node in executable_nodes}
    legal_edges = [(s, t) for s, t in proposal.blocks if s in node_ids and t in node_ids and s != t]
    executable_edges = [(s, t) for s, t in legal_edges if s in executable_node_ids and t in executable_node_ids]
    return {
        "node_id_list": node_id_list,
        "node_ids": node_ids,
        "executable_node_ids": executable_node_ids,
        "executable_edges": executable_edges,
        "gate_by_task": {gate.task_id: gate for gate in proposal.gates},
    }


def _validate_node_and_gate_shape(proposal, context, max_subtasks, errors) -> None:
    node_ids = context["node_ids"]
    executable_node_ids = context["executable_node_ids"]
    gate_task_list = [gate.task_id for gate in proposal.gates]
    gate_id_list = [gate.gate_id for gate in proposal.gates]
    if not node_ids:
        errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
    if len(context["node_id_list"]) != len(node_ids):
        errors.add(PlanValidatorError.ILLEGAL_EDGE)
    if len(gate_task_list) != len(set(gate_task_list)) or len(gate_id_list) != len(set(gate_id_list)):
        errors.add(PlanValidatorError.ILLEGAL_EDGE)
    if len(proposal.nodes) > max_subtasks:
        errors.add(PlanValidatorError.POLICY_LIMIT_EXCEEDED)
    _validate_entry_exit(proposal, context, executable_node_ids, errors)
    _validate_nodes_have_gates(proposal, context["gate_by_task"], errors)


def _validate_entry_exit(proposal, context, executable_node_ids, errors) -> None:
    if not proposal.entry_node_ids or not proposal.exit_node_ids:
        errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
    if not set(proposal.entry_node_ids).issubset(executable_node_ids):
        errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
    if not set(proposal.exit_node_ids).issubset(executable_node_ids):
        errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)
    computed_entries = executable_node_ids - {target for _source, target in context["executable_edges"]}
    computed_exits = executable_node_ids - {source for source, _target in context["executable_edges"]}
    if set(proposal.entry_node_ids) != computed_entries or set(proposal.exit_node_ids) != computed_exits:
        errors.add(PlanValidatorError.MISSING_ENTRY_EXIT)


def _validate_nodes_have_gates(proposal, gate_by_task, errors) -> None:
    for node in proposal.nodes:
        gate = gate_by_task.get(node.node_id)
        if gate is None or not node.gate_snapshot_hash:
            errors.add(PlanValidatorError.MISSING_GATE)
            continue
        if node.gate_snapshot_hash != gate.hash:
            errors.add(PlanValidatorError.MISSING_GATE)


def _validate_gate_contents(gates: list[GateSpecSnapshot], verifier_credentials: set[str], errors) -> None:
    for gate in gates:
        content = gate.content
        if not gate.frozen or gate.hash != canonical_gate_hash(content):
            errors.add(PlanValidatorError.MISSING_GATE)
        if not content.verification_procedure or not all(step.strip() for step in content.verification_procedure):
            errors.add(PlanValidatorError.GATE_UNEXECUTABLE)
        if any(not step.has_valid_source for step in content.verification_procedure):
            errors.add(PlanValidatorError.INVALID_GATE_STEP_SOURCE)
        if content.verification_procedure and not any(step.is_authoritative for step in content.verification_procedure):
            errors.add(PlanValidatorError.NO_AUTHORITATIVE_GATE_STEP)
        _validate_gate_rubric(content, verifier_credentials, errors)
        _validate_gate_steps(content.verification_procedure, errors)


def _validate_gate_rubric(content, verifier_credentials, errors) -> None:
    if set(content.rubric) != RUBRIC_SCORES or any(not str(value).strip() for value in content.rubric.values()):
        errors.add(PlanValidatorError.INCOMPLETE_RUBRIC)
    if content.pass_threshold != PASS_THRESHOLD:
        errors.add(PlanValidatorError.LOWERED_THRESHOLD)
    if set(content.verifier_credentials) - verifier_credentials:
        errors.add(PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE)


def _validate_gate_steps(steps, errors) -> None:
    for step in steps:
        lowered = step.lower()
        if "executor workspace" in lowered or "$executor_" in lowered:
            errors.add(PlanValidatorError.EXECUTOR_ONLY_GATE_DEPENDENCY)
        if not looks_like_executable_gate_command(step):
            errors.add(PlanValidatorError.GATE_UNEXECUTABLE)


def _validate_edges(proposal, context, errors) -> None:
    node_ids = context["node_ids"]
    for source, target in proposal.blocks:
        if source not in node_ids or target not in node_ids or source == target:
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
    parent_by_child = {node.node_id: node.parent_node_id for node in proposal.nodes if node.parent_node_id}
    for source, target in proposal.blocks:
        if parent_by_child.get(target) == source:
            errors.add(PlanValidatorError.ILLEGAL_EDGE)
    if _has_cycle(node_ids, proposal.blocks):
        errors.add(PlanValidatorError.CYCLE_DETECTED)


def _validate_parallel_shape(proposal, intent_spec, errors) -> None:
    if intent_spec is None or not intent_spec.requires_all_parallel_branches_for_downstream:
        return
    required_edges = set(required_parallel_dependency_edges(proposal, intent_spec))
    if not required_edges.issubset(set(proposal.blocks)):
        errors.add(PlanValidatorError.REQUIRED_PARALLEL_SHAPE_MISSING)


def looks_like_executable_gate_command(step: str) -> bool:
    candidate = step.strip()
    if not candidate:
        return False
    lowered = candidate.lower()
    prose_prefixes = ("check ", "confirm ", "ensure ", "from ", "read ", "run ", "verify ", "validate ")
    if lowered.startswith(prose_prefixes):
        return False
    return "`" not in candidate
