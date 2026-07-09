from __future__ import annotations

from typing import Any

from real_symphony_e2e_acceptance_base import _attempt_intervals_overlap, _safe_int
from real_symphony_e2e_analysis import pipeline_has_conflict_escalation_evidence
from real_symphony_e2e_common import Evidence


def _check_pipeline_scenario_acceptance(evidence: Evidence, scenario: str, pipeline_view: dict[str, Any]) -> None:
    if scenario == "basic":
        return
    if scenario == "parallel":
        _check_parallel_acceptance(evidence, pipeline_view)
    elif scenario == "replan":
        _check_replan_acceptance(evidence, pipeline_view)
    elif scenario == "integration-conflict":
        _check_integration_conflict_acceptance(evidence, pipeline_view)
    elif scenario == "runtime-wait":
        _check_runtime_wait_acceptance(evidence, pipeline_view)
    elif scenario == "gate-normalization":
        _check_gate_normalization_acceptance(evidence, pipeline_view)
    elif scenario == "overall-dod":
        for child in ["parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization"]:
            _check_pipeline_scenario_acceptance(evidence, child, pipeline_view)


def _check_parallel_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    execute_attempts = [attempt for attempt in attempts if attempt.get("mode") == "execute"]
    expected_policy = _expected_managed_run_policy(pipeline_view)
    policy_match = _managed_run_policy_matches(pipeline_view, expected_policy)
    evidence.check(
        "scenario:parallel-execute-overlap",
        str(pipeline_view.get("policy_source") or "") == "podium_pushed"
        and bool(str(pipeline_view.get("policy_id") or ""))
        and policy_match
        and len(execute_attempts) >= 2
        and _attempt_intervals_overlap(execute_attempts),
        execute_attempts=[_attempt_window(attempt) for attempt in execute_attempts],
        work_item_limit=((pipeline_view.get("capacity") or {}).get("by_role") or {}).get("work_item"),
        policy_id=str(pipeline_view.get("policy_id") or ""),
        policy_source=str(pipeline_view.get("policy_source") or ""),
        expected_managed_run_policy_id=str(expected_policy.get("policy_id") or ""),
        expected_managed_run_policy_version=_safe_int(expected_policy.get("version")),
        last_managed_run_policy_id=str(pipeline_view.get("last_managed_run_policy_id") or ""),
        last_managed_run_policy_version=_safe_int(pipeline_view.get("last_managed_run_policy_version")),
        last_managed_run_policy_source=str(pipeline_view.get("last_managed_run_policy_source") or ""),
        last_managed_run_tick_at=str(pipeline_view.get("last_managed_run_tick_at") or ""),
    )


def _expected_managed_run_policy(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    runtime_config = pipeline_view.get("runtime_config") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    policy = runtime_config.get("managed_run_policy") if isinstance(runtime_config.get("managed_run_policy"), dict) else {}
    return policy if isinstance(policy, dict) else {}


def _managed_run_policy_matches(pipeline_view: dict[str, Any], expected_policy: dict[str, Any]) -> bool:
    expected_id = str(expected_policy.get("policy_id") or "")
    expected_version = _safe_int(expected_policy.get("version"))
    return (
        bool(expected_id)
        and expected_version > 0
        and str(pipeline_view.get("last_managed_run_policy_source") or "") == "podium_pushed"
        and str(pipeline_view.get("last_managed_run_policy_id") or "") == expected_id
        and _safe_int(pipeline_view.get("last_managed_run_policy_version")) == expected_version
        and bool(str(pipeline_view.get("last_managed_run_tick_at") or ""))
    )


def _attempt_window(attempt: dict[str, Any]) -> dict[str, Any]:
    return {
        "attempt_id": attempt.get("attempt_id"),
        "started_at": attempt.get("started_at"),
        "completed_at": attempt.get("completed_at"),
    }


def _check_replan_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    evidence.check(
        "scenario:replan-replacement-subgraph",
        int(pipeline_view.get("graph_revision") or 0) > 1
        and any(node.get("state") == "superseded" or node.get("superseded_by") for node in nodes),
        graph_revision=pipeline_view.get("graph_revision"),
        nodes=[{"node_id": node.get("node_id"), "state": node.get("state"), "superseded_by": node.get("superseded_by")} for node in nodes],
    )


def _check_integration_conflict_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    evidence.check(
        "scenario:integration-conflict-human-action",
        pipeline_has_conflict_escalation_evidence(pipeline_view),
        human_waits=[wait for wait in pipeline_view.get("human_waits", []) if isinstance(wait, dict)],
        integrations=[item for item in pipeline_view.get("integration_queue", []) if isinstance(item, dict)],
    )


def _check_runtime_wait_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    waits = [wait for wait in pipeline_view.get("runtime_waits", []) if isinstance(wait, dict)]
    projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
    resolved_wait_visible = any(wait.get("wait_kind") and wait.get("child_issue_id") for wait in waits)
    evidence.check(
        "scenario:runtime-wait-projected",
        bool(waits) and (any((projection.get("metadata") or {}).get("operator_wait_kind") for projection in projections) or resolved_wait_visible),
        runtime_waits=waits,
        projections=projections,
    )


def _check_gate_normalization_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    from real_symphony_e2e_acceptance_appendix import _gate_step_provenance_evidence

    gate_evidence = _gate_step_provenance_evidence(pipeline_view)
    evidence.check(
        "scenario:gate-normalization-provenance",
        gate_evidence["all_steps_have_valid_source"] and gate_evidence["all_gates_have_authoritative_step"],
        **gate_evidence,
    )
