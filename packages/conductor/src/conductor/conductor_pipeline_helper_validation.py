from __future__ import annotations

from .conductor_pipeline_helper_common import *


def _node_verify_passed(node: GraphNode) -> bool:
    return node.state is GraphNodeState.VERIFY_PASSED and int(node.verify_score or 0) >= PASS_THRESHOLD

def _plan_validation_human_reason(errors: set[PlanValidatorError]) -> HumanEscalationReason:
    if PlanValidatorError.VERIFIER_CREDENTIAL_UNAVAILABLE in errors:
        return HumanEscalationReason.CREDENTIAL_REQUIRED
    if PlanValidatorError.GATE_UNEXECUTABLE in errors:
        return HumanEscalationReason.GATE_UNEXECUTABLE
    return HumanEscalationReason.PLAN_INVALID

def _plan_failure_human_reason(error: str) -> HumanEscalationReason:
    if error == HumanEscalationReason.THREAD_LOST.value or "thread_lost" in error.lower():
        return HumanEscalationReason.THREAD_LOST
    if not error.startswith("invalid_plan_proposal"):
        return HumanEscalationReason.BACKEND_UNAVAILABLE
    return _plan_validation_human_reason(_plan_validator_errors_from_error(error))

def _plan_validator_errors_from_error(error: str) -> set[PlanValidatorError]:
    if ":" not in error:
        return set()
    errors: set[PlanValidatorError] = set()
    for token in error.split(":", 1)[1].replace(",", " ").split():
        try:
            errors.add(PlanValidatorError(token.strip()))
        except ValueError:
            continue
    return errors

def _plan_validation_error_summary(errors: set[PlanValidatorError]) -> str:
    names = ", ".join(sorted(error.value for error in errors))
    return f"invalid plan proposal: {names}"
