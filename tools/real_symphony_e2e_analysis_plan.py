from __future__ import annotations

import json
from pathlib import Path
from typing import Any

def analyze_plan_artifacts(
    *,
    attempt_request: dict[str, Any] | Path | str | None,
    attempt_result: dict[str, Any] | Path | str | None,
    dispatch_context: dict[str, Any] | Path | str | None = None,
) -> dict[str, Any]:
    request_payload = _read_analysis_payload(attempt_request)
    result_payload = _read_analysis_payload(attempt_result)
    dispatch_payload = _read_analysis_payload(dispatch_context)
    context = _analysis_context(request_payload, dispatch_payload)
    preferred_context = _preferred_intent_context(context)
    report: dict[str, Any] = {
        "status": "no_plan_result",
        "root_cause_codes": [],
        "actionable_root_causes": [],
        "current_intent": {},
        "preferred_intent": {},
        "validator_errors_current": [],
        "validator_errors_preferred_after_repair": [],
        "proposal_shape": {},
    }
    proposal_payload = result_payload.get("proposal") if isinstance(result_payload.get("proposal"), dict) else {}
    if not proposal_payload:
        if result_payload:
            report["status"] = "no_proposal"
            report["attempt_error"] = result_payload.get("error")
            report["attempt_status"] = result_payload.get("status")
        return report
    try:
        from performer_api.pipeline import IntentSpec, PlanProposal, PlanRepair, PlanValidator

        proposal = PlanProposal.from_dict(proposal_payload)
        current_intent = IntentSpec.from_dispatch_context(context)
        preferred_intent = IntentSpec.from_dispatch_context(preferred_context)
        current_errors = sorted(error.value for error in PlanValidator(intent_spec=current_intent).validate(proposal))
        preferred_repaired = PlanRepair(preferred_intent).repair(proposal)
        preferred_errors = sorted(
            error.value for error in PlanValidator(intent_spec=preferred_intent).validate(preferred_repaired)
        )
        report.update(
            {
                "status": "analyzed",
                "current_intent": _intent_spec_summary(current_intent),
                "preferred_intent": _intent_spec_summary(preferred_intent),
                "validator_errors_current": current_errors,
                "validator_errors_preferred_after_repair": preferred_errors,
                "proposal_shape": _plan_proposal_shape(proposal),
                "preferred_repaired_shape": _plan_proposal_shape(preferred_repaired),
            }
        )
        intent_payload = context.get("intent")
        pipeline_intent = context.get("pipeline_intent")
        if (
            isinstance(intent_payload, dict)
            and not intent_payload
            and isinstance(pipeline_intent, dict)
            and pipeline_intent
        ):
            _add_plan_root_cause(
                report,
                "intent_shadowed_by_empty_intent",
                "empty dispatch intent shadowed non-empty pipeline_intent",
                fix="Treat empty intent as absent, or prefer non-empty pipeline_intent when deriving IntentSpec.",
            )
    except Exception as exc:
        report.update(
            {
                "status": "analysis_error",
                "error": exc.__class__.__name__,
                "reason": str(exc),
            }
        )
    return report


def _read_analysis_payload(value: dict[str, Any] | Path | str | None) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    path = Path(value)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _analysis_context(request_payload: dict[str, Any], dispatch_payload: dict[str, Any]) -> dict[str, Any]:
    context = dict(request_payload)
    context.update(dispatch_payload)
    if "pipeline_intent" not in context and isinstance(request_payload.get("pipeline_intent"), dict):
        context["pipeline_intent"] = request_payload["pipeline_intent"]
    return context


def _preferred_intent_context(context: dict[str, Any]) -> dict[str, Any]:
    preferred = dict(context)
    pipeline_intent = preferred.get("pipeline_intent")
    if isinstance(pipeline_intent, dict) and pipeline_intent:
        preferred["intent"] = pipeline_intent
    elif isinstance(preferred.get("intent"), dict):
        preferred["pipeline_intent"] = preferred["intent"]
    return preferred


def _intent_spec_summary(intent: Any) -> dict[str, Any]:
    return {
        "issue_id": getattr(intent, "issue_id", ""),
        "issue_identifier": getattr(intent, "issue_identifier", ""),
        "requires_parent_aggregate": bool(getattr(intent, "requires_parent_aggregate", False)),
        "requires_all_parallel_branches_for_downstream": bool(
            getattr(intent, "requires_all_parallel_branches_for_downstream", False)
        ),
        "parallel_branch_node_ids": list(getattr(intent, "parallel_branch_node_ids", []) or []),
        "downstream_node_ids": list(getattr(intent, "downstream_node_ids", []) or []),
        "required_gate_steps": [
            step.to_dict() if hasattr(step, "to_dict") else {"step": str(step)}
            for step in (getattr(intent, "required_gate_steps", []) or [])
        ],
    }


def _plan_proposal_shape(proposal: Any) -> dict[str, Any]:
    root_node_id = str(getattr(proposal, "root_node_id", "") or "")
    nodes = list(getattr(proposal, "nodes", []) or [])
    gates = list(getattr(proposal, "gates", []) or [])
    blocks = list(getattr(proposal, "blocks", []) or [])
    return {
        "root_node_id": root_node_id,
        "node_count": len(nodes),
        "gate_count": len(gates),
        "block_count": len(blocks),
        "root_has_gate": any(getattr(gate, "task_id", "") == root_node_id for gate in gates),
        "parent_count": sum(1 for node in nodes if getattr(node, "parent_node_id", None)),
        "nodes_without_gate": sorted(
            str(getattr(node, "node_id", ""))
            for node in nodes
            if str(getattr(node, "node_id", "")) not in {str(getattr(gate, "task_id", "")) for gate in gates}
        ),
        "entry_node_ids": list(getattr(proposal, "entry_node_ids", []) or []),
        "exit_node_ids": list(getattr(proposal, "exit_node_ids", []) or []),
    }


def _add_plan_root_cause(report: dict[str, Any], code: str, summary: str, *, fix: str) -> None:
    if code not in report["root_cause_codes"]:
        report["root_cause_codes"].append(code)
    if not any(item.get("code") == code for item in report["actionable_root_causes"]):
        report["actionable_root_causes"].append({"code": code, "summary": summary, "fix": fix})
