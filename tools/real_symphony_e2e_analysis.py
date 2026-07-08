from __future__ import annotations

import json
import os
import re
import signal
import uuid
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence
from real_symphony_e2e_linear import (
    comment_linear_issue,
    fetch_linear_human_action_issue,
    move_linear_issue_to_state,
    update_linear_issue_description,
)


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
        if (
            "missing_gate" in current_errors
            and "missing_gate" not in preferred_errors
            and not current_intent.requires_parent_aggregate
            and preferred_intent.requires_parent_aggregate
        ):
            _add_plan_root_cause(
                report,
                "root_parent_intent_not_applied",
                "root business issue was validated as an executable node instead of an aggregate parent",
                fix="Apply structured parent aggregate intent before plan repair and validation.",
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


def write_wait_artifacts(
    *,
    evidence: Evidence,
    samples: list[dict[str, Any]],
    result_path: Path,
    final_issue: dict[str, Any],
    state_path: Path,
    last_state: dict[str, Any],
    ops_path: Path,
    last_ops: dict[str, Any],
    log_path: Path,
    stages: dict[str, str],
    stage_timeout_seconds: int,
) -> dict[str, Any]:
    samples_path = evidence.out.parent / "runtime-samples.json"
    samples_path.write_text(json.dumps(samples, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("runtime_samples", samples_path)
    if result_path.exists():
        result_copy = evidence.out.parent / "workspace-result.txt"
        result_copy.write_text(result_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        evidence.artifact("workspace_result", result_copy)
    final_issue_path = evidence.out.parent / "final-issue.json"
    final_issue_path.write_text(json.dumps(final_issue, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("final_issue", final_issue_path)
    stage_snapshot = {
        "observed": stages,
        "stage_timeout_seconds": stage_timeout_seconds,
        "last_sample": samples[-1] if samples else None,
    }
    stage_snapshot_path = evidence.out.parent / "stage-snapshot.json"
    stage_snapshot_path.write_text(json.dumps(stage_snapshot, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("stage_snapshot", stage_snapshot_path)
    return {
        "issue": final_issue,
        "result_path": str(result_path),
        "log_path": str(log_path),
        "samples": samples,
    }


def conductor_human_actions(pipeline_payload: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = {
        str(node.get("node_id") or ""): node
        for node in pipeline_payload.get("nodes", [])
        if isinstance(node, dict) and node.get("node_id")
    }
    actions: list[dict[str, Any]] = []
    waits = pipeline_payload.get("human_waits")
    if isinstance(waits, list):
        for wait in waits:
            if not isinstance(wait, dict) or str(wait.get("status") or "") not in {"waiting", "open"}:
                continue
            node_id = str(wait.get("node_id") or "")
            node = nodes.get(node_id, {})
            actions.append(
                {
                    "wait_id": str(wait.get("wait_id") or ""),
                    "node_id": node_id,
                    "issue_id": str(node.get("issue_id") or "") or None,
                    "issue_identifier": str(node.get("issue_identifier") or "") or None,
                    "state": str(node.get("state") or ""),
                    "status": str(wait.get("status") or ""),
                    "reason": str(wait.get("reason") or "") or None,
                    "child_issue_id": str(wait.get("child_issue_id") or "") or None,
                    "child_identifier": str(wait.get("child_identifier") or "") or None,
                    "child_url": str(wait.get("child_url") or "") or None,
                    "details": wait.get("details") if isinstance(wait.get("details"), dict) else {},
                }
            )
    runtime_waits = pipeline_payload.get("runtime_waits")
    if not isinstance(runtime_waits, list):
        return actions
    for wait in runtime_waits:
        if not isinstance(wait, dict) or str(wait.get("status") or "") not in {"waiting", "open"}:
            continue
        node_id = str(wait.get("node_id") or "")
        node = nodes.get(node_id, {})
        wait_kind = str(wait.get("wait_kind") or "") or None
        actions.append(
            {
                "wait_id": str(wait.get("wait_id") or ""),
                "node_id": node_id,
                "issue_id": str(node.get("issue_id") or "") or None,
                "issue_identifier": str(node.get("issue_identifier") or "") or None,
                "state": str(node.get("state") or ""),
                "status": str(wait.get("status") or ""),
                "reason": wait_kind,
                "child_issue_id": str(wait.get("child_issue_id") or "") or None,
                "child_identifier": str(wait.get("child_identifier") or "") or None,
                "child_url": str(wait.get("child_url") or "") or None,
                "details": {
                    "attempt_id": str(wait.get("attempt_id") or ""),
                    "lease_id": str(wait.get("lease_id") or ""),
                    "wait_kind": wait_kind or "",
                },
            }
        )
    return actions


def conductor_pipeline_nodes(pipeline_payload: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = pipeline_payload.get("nodes")
    if not isinstance(nodes, list):
        return []
    return [node for node in nodes if isinstance(node, dict) and node.get("node_id")]


APPENDIX_EXIT_BAR_ITEMS: tuple[dict[str, Any], ...] = (
    {
        "item": 1,
        "summary": "real business issue decomposed, PlanValidated, committed, and projected as a Linear blocks tree",
        "required_checks": {"stage:pipeline-gates-frozen", "stage:pipeline-linear-projected"},
    },
    {
        "item": 2,
        "summary": "parallel executors run under Podium-pushed per-mode capacity with leases/fencing observed",
        "required_checks": {"scenario:parallel-execute-overlap", "runtime-config:podium-pushed"},
    },
    {
        "item": 3,
        "summary": "isolated canonical verification, tamper failure, expired fencing refusal, and verify-passed gating",
        "required_checks": {
            "stage:pipeline-manifest-published",
            "stage:final-pipeline-verified",
            "appendix:s3-verifier-mutation-detection",
            "appendix:s3-expired-fencing-refused",
        },
    },
    {
        "item": 4,
        "summary": "induced failure replans or structured human escalation resumes through child issue",
        "any_checks": {"scenario:replan-replacement-subgraph", "human-action:managed-push-resume"},
    },
    {
        "item": 5,
        "summary": "parallel conflict integrated or escalated without silent merge",
        "required_checks": {"scenario:integration-conflict-human-action"},
    },
    {
        "item": 6,
        "summary": "Podium pipeline view shows live per-mode detail and conditional predicted order with basis",
        "required_checks": {"conductor-api:GET /api/pipeline", "appendix:pipeline-prediction-conditional"},
    },
    {
        "item": 7,
        "summary": "managed run does not touch operator global ~/.codex",
        "required_checks": {"runtime-config:codex-home-source-staged", "appendix:no-global-codex-home"},
    },
    {
        "item": 8,
        "summary": "reconcile findings clean and evidence scores each feature within Appendix hard caps",
        "required_checks": {"appendix:reconcile-findings-clean", "appendix:evidence-scores-within-hard-caps"},
    },
)


APPENDIX_FEATURE_SCORE_REQUIREMENTS: tuple[dict[str, Any], ...] = (
    {
        "feature": "S0-a",
        "summary": "typed capacity plus versioned Podium-pushed policy",
        "r_checks": {
            "runtime-config:podium-pushed",
            "scenario:parallel-execute-overlap",
            "appendix:s0a-podium-unreachable-local-defaults",
        },
        "h_checks": {
            "appendix:s0a-stale-policy-rejected",
            "appendix:s0a-lowered-limit-no-preempt",
            "appendix:s0a-crashed-worker-lease-reclaimed",
        },
    },
    {
        "feature": "S0-b",
        "summary": "dependency predicate plus pipeline observability",
        "r_checks": {"conductor-api:GET /api/pipeline", "appendix:s0b-pipeline-live-refresh"},
        "h_checks": {
            "appendix:pipeline-prediction-conditional",
            "appendix:s0b-view-refreshes-after-rewrite",
            "appendix:s0b-view-read-only",
        },
    },
    {
        "feature": "S0-c",
        "summary": "runtime profile plus per-mode isolation and backend eligibility",
        "r_checks": {
            "appendix:s0c-distinct-mode-codex-homes",
            "appendix:s0c-non-codex-backend-selected",
        },
        "h_checks": {
            "appendix:no-global-codex-home",
            "appendix:s0c-ineligible-backend-refused-before-dispatch",
            "appendix:s0c-concurrent-runs-do-not-share-mode-homes",
        },
    },
    {
        "feature": "S1",
        "summary": "three-layer state model plus graph store and artifacts",
        "r_checks": {"appendix:s1-parent-aggregate-real", "stage:final-pipeline-verified"},
        "h_checks": {
            "appendix:s1-superseded-revision-refused",
            "appendix:s1-terminal-attempt-immutable",
            "appendix:s1-parent-failed-child-not-passing",
        },
    },
    {
        "feature": "S2",
        "summary": "planner mode, PlanValidator, and Linear projection",
        "r_checks": {"stage:pipeline-gates-frozen", "stage:pipeline-linear-projected"},
        "h_checks": {
            "appendix:s2-malformed-proposal-refused",
            "appendix:s2-linear-idempotent-rerun",
            "appendix:s2-gate-post-freeze-immutable",
        },
    },
    {
        "feature": "S3",
        "summary": "isolated verifier plus verify-passed dependency gating",
        "r_checks": {
            "stage:pipeline-manifest-published",
            "stage:final-pipeline-verified",
            "appendix:s3-downstream-gated-on-verify-passed",
        },
        "h_checks": {
            "appendix:s3-verifier-mutation-detection",
            "appendix:s3-applied-tree-mismatch-rejected",
            "appendix:s3-expired-fencing-refused",
        },
    },
    {
        "feature": "S4",
        "summary": "failure-driven re-decomposition",
        "r_checks": {
            "scenario:replan-replacement-subgraph",
            "appendix:overall-downstream-depends-on-both-parallel-subtasks",
        },
        "h_checks": {
            "appendix:s4-superseded-revision-fenced",
            "appendix:s4-no-old-node-dependent-dispatch",
            "appendix:s4-invalid-replan-escalates",
        },
    },
    {
        "feature": "Patch Integration",
        "summary": "patch integration and conflict model",
        "r_checks": {"scenario:integration-conflict-human-action"},
        "h_checks": {
            "appendix:patch-conflict-reproducible-under-real-concurrency",
            "appendix:patch-downstream-never-consumes-unintegrated-output",
        },
    },
    {
        "feature": "Human Escalation",
        "summary": "structured human escalation through child issue",
        "r_checks": {"human-action:linear-child-complete", "human-action:managed-push-resume"},
        "h_checks": {
            "human-action:parent-comment-does-not-resume",
            "appendix:reconcile-findings-clean",
        },
    },
    {
        "feature": "Linear Projection",
        "summary": "operator-visible Linear projection",
        "r_checks": {"scenario:runtime-wait-projected", "human-action:child-type-label-visible"},
        "h_checks": {
            "appendix:s2-gate-post-freeze-immutable",
            "appendix:linear-legitimate-blocks-edits-ingested",
        },
    },
)


def appendix_feature_score_audit(reports: list[dict[str, Any]]) -> dict[str, Any]:
    passed_checks: set[str] = set()
    for report in reports:
        if not isinstance(report, dict):
            continue
        for check in report.get("checks", []):
            if isinstance(check, dict) and check.get("passed") is True:
                name = str(check.get("name") or "")
                if name:
                    passed_checks.add(name)
    scores: list[dict[str, Any]] = []
    for spec in APPENDIX_FEATURE_SCORE_REQUIREMENTS:
        r_checks = {str(name) for name in spec.get("r_checks", set())}
        h_checks = {str(name) for name in spec.get("h_checks", set())}
        missing_r = sorted(name for name in r_checks if name not in passed_checks)
        missing_h = sorted(name for name in h_checks if name not in passed_checks)
        has_r = not missing_r
        has_h = has_r and not missing_h
        score = 4 if has_h else 3 if has_r else 2
        hard_cap = 4 if has_r else 2
        scores.append(
            {
                "feature": str(spec["feature"]),
                "summary": str(spec["summary"]),
                "score": score,
                "hard_cap": hard_cap,
                "r_done": has_r,
                "h_done": has_h,
                "missing_r_checks": missing_r,
                "missing_h_checks": missing_h,
            }
        )
    return {
        "pass": all(score["r_done"] and score["h_done"] and score["score"] == 4 for score in scores),
        "within_hard_caps": all(int(score["score"]) <= int(score["hard_cap"]) for score in scores),
        "scores": scores,
    }


def appendix_exit_bar_audit(reports: list[dict[str, Any]]) -> dict[str, Any]:
    passed_checks: set[str] = set()
    report_failures: list[Any] = []
    for report in reports:
        if not isinstance(report, dict):
            continue
        failures = report.get("failures")
        if isinstance(failures, list):
            report_failures.extend(failures)
        for check in report.get("checks", []):
            if isinstance(check, dict) and check.get("passed") is True:
                name = str(check.get("name") or "")
                if name:
                    passed_checks.add(name)
    items: list[dict[str, Any]] = []
    for spec in APPENDIX_EXIT_BAR_ITEMS:
        required = {str(name) for name in spec.get("required_checks", set())}
        any_checks = {str(name) for name in spec.get("any_checks", set())}
        missing = sorted(name for name in required if name not in passed_checks)
        any_satisfied = True
        if any_checks:
            any_satisfied = bool(passed_checks & any_checks)
        passed = not missing and any_satisfied
        items.append(
            {
                "item": int(spec["item"]),
                "summary": str(spec["summary"]),
                "pass": passed,
                "required_checks": sorted(required),
                "any_checks": sorted(any_checks),
                "missing_checks": missing,
                "observed_any_checks": sorted(passed_checks & any_checks),
            }
        )
    return {
        "pass": not report_failures and all(item["pass"] for item in items),
        "items": items,
        "report_failures": report_failures,
    }


def pipeline_node_effective_state(node: dict[str, Any]) -> str:
    aggregate_state = str(node.get("aggregate_state") or "").strip().lower()
    if aggregate_state:
        return aggregate_state
    return str(node.get("state") or "").strip().lower()


def pipeline_nodes_terminal(
    nodes: list[dict[str, Any]],
    *,
    terminal_states: set[str],
) -> bool:
    if not nodes:
        return False
    normalized = {state.lower() for state in terminal_states}
    return all(pipeline_node_effective_state(node) in normalized for node in nodes)


def pipeline_integrations_terminal(pipeline_payload: dict[str, Any]) -> bool:
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    return bool(integrations) and all(item.get("status") in {"integrated", "resolved"} for item in integrations)


def pipeline_has_conflict_escalation_evidence(pipeline_payload: dict[str, Any]) -> bool:
    waits = [wait for wait in pipeline_payload.get("human_waits", []) if isinstance(wait, dict)]
    has_conflict_wait = any(wait.get("reason") == "LINEAR_SYNC_CONFLICT" for wait in waits)
    if has_conflict_wait:
        return True
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    return any(item.get("status") == "conflict" and item.get("error") for item in integrations)


def audit_expected_failure_run(run_result: dict[str, Any], tree: dict[str, Any], *, expected: str) -> dict[str, Any]:
    pipeline_nodes = [
        node
        for sample in run_result.get("samples", [])
        if isinstance(sample, dict)
        for node in sample.get("pipeline_nodes", [])
        if isinstance(node, dict)
    ]
    max_overload_count = max([_int_value(node.get("overload_count")) for node in pipeline_nodes] or [0])
    max_retry_count = max([_int_value(node.get("retry_count")) for node in pipeline_nodes] or [0])
    max_crash_count = max([_int_value(node.get("crash_count")) for node in pipeline_nodes] or [0])
    reasons = [str(node.get("last_reason") or "") for node in pipeline_nodes]
    failed_terminal = any(node.get("state") == "failed" for node in pipeline_nodes)
    human_actions = _human_action_children(tree)
    descriptions = "\n\n".join(str(child.get("description") or "") for child in human_actions)
    if max_overload_count == 0:
        max_overload_count = _max_counter_from_text(descriptions, "overload_count")
    if max_retry_count == 0:
        max_retry_count = _max_counter_from_text(descriptions, "retry_count")
    if max_crash_count == 0:
        max_crash_count = _max_counter_from_text(descriptions, "crash_count")
    http_status_in_linear = "Upstream HTTP status:" in descriptions
    raw_error_in_linear = "Last error:" in descriptions and (
        "JSON-RPC error" in descriptions or "server overloaded" in descriptions or "invalid request" in descriptions
    )
    terminal_bad_request = any("codex_bad_request" in reason for reason in reasons) or "invalid request" in descriptions.lower()
    overload_exhausted = any("upstream_overloaded_exhausted" in reason for reason in reasons) or max_overload_count > 0
    if expected == "overload":
        passed = (
            failed_terminal
            and overload_exhausted
            and max_overload_count > 0
            and max_retry_count == 0
            and max_crash_count == 0
            and raw_error_in_linear
            and http_status_in_linear
        )
    elif expected == "terminal_bad_request":
        passed = failed_terminal and terminal_bad_request and max_overload_count == 0 and raw_error_in_linear and http_status_in_linear
    else:
        raise ValueError(f"Unsupported expected failure: {expected}")
    return {
        "pass": passed,
        "expected": expected,
        "failed_terminal": failed_terminal,
        "max_overload_count": max_overload_count,
        "max_retry_count": max_retry_count,
        "max_crash_count": max_crash_count,
        "last_reasons": reasons[-10:],
        "human_action_count": len(human_actions),
        "raw_error_in_linear": raw_error_in_linear,
        "http_status_in_linear": http_status_in_linear,
        "terminal_bad_request": terminal_bad_request,
        "overload_exhausted": overload_exhausted,
    }


def _human_action_children(tree: dict[str, Any]) -> list[dict[str, Any]]:
    children = ((tree.get("children") or {}).get("nodes") or []) if isinstance(tree.get("children"), dict) else []
    result: list[dict[str, Any]] = []
    for child in children:
        if not isinstance(child, dict):
            continue
        labels = ((child.get("labels") or {}).get("nodes") or []) if isinstance(child.get("labels"), dict) else []
        if str(child.get("title") or "").startswith("[Human Action]") or any(
            isinstance(label, dict) and label.get("name") == "performer:type/human-action" for label in labels
        ):
            result.append(child)
    return result


def _int_value(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _max_counter_from_text(text: str, key: str) -> int:
    values = [int(match.group(1)) for match in re.finditer(rf"{re.escape(key)}:\s*(\d+)", text)]
    return max(values or [0])


def crash_probe_candidate(pipeline_attempts: list[dict[str, Any]], leases: list[dict[str, Any]]) -> dict[str, Any] | None:
    active_attempt_ids = {str(lease.get("attempt_id") or "") for lease in leases if isinstance(lease, dict)}
    for attempt in pipeline_attempts:
        if str(attempt.get("attempt_id") or "") not in active_attempt_ids:
            continue
        if attempt.get("mode") != "execute":
            continue
        if attempt.get("state") != "running":
            continue
        pid = attempt.get("process_pid")
        if isinstance(pid, int) and pid > 0:
            return attempt
    return None


def kill_performer_for_crash_probe(pid: int) -> tuple[bool, str | None]:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return False, "process_not_found"
    except PermissionError:
        return False, "permission_denied"
    except OSError as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return True, None


def human_action_description_with_response(description: str, response: str) -> str:
    marker = "Human response:"
    response = response.strip()
    if marker.lower() not in description.lower():
        return f"{description.rstrip()}\n\n{marker}\n{response}\n"
    lower = description.lower()
    start = lower.find(marker.lower()) + len(marker)
    stop = len(description)
    for candidate in ["When finished,", "完成后", "Move this child issue"]:
        index = lower.find(candidate.lower(), start)
        if index >= 0:
            stop = min(stop, index)
    prefix = description[:start].rstrip()
    suffix = description[stop:].lstrip("\n")
    if suffix:
        return f"{prefix}\n{response}\n\n{suffix}"
    return f"{prefix}\n{response}\n"


def parent_comment_negative_control_body(wait_id: str) -> str:
    normalized_wait_id = str(wait_id or "unknown").strip() or "unknown"
    return (
        "Symphony E2E negative control for human-action routing.\n\n"
        f"wait_id={normalized_wait_id}\n"
        "No action is required. This is not a Symphony human-action resume command; "
        "the waiting pipeline task must remain blocked until its [Human Action] child issue is completed."
    )


def e2e_human_action_resume_response(action: dict[str, Any]) -> str:
    wait_id = str(action.get("wait_id") or "unknown").strip() or "unknown"
    child_identifier = str(action.get("child_identifier") or action.get("child_issue_id") or "unknown").strip() or "unknown"
    reason = str(action.get("reason") or "unknown").strip() or "unknown"
    return (
        f"Symphony E2E resume approval for human wait {wait_id} on child {child_identifier}.\n"
        f"This is the explicit human-action resume signal; reason={reason}; retry the managed run."
    )


def should_complete_conductor_human_action(action: dict[str, Any], completed_wait_ids: set[str]) -> bool:
    wait_id = str(action.get("wait_id") or "")
    child_issue_id = str(action.get("child_issue_id") or "")
    return bool(wait_id and child_issue_id and wait_id not in completed_wait_ids)


def done_state_id_for_human_action(issue: dict[str, Any]) -> str | None:
    team = issue.get("team") if isinstance(issue.get("team"), dict) else {}
    states = ((team.get("states") or {}).get("nodes") or []) if isinstance(team, dict) else []
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("type") or "") == "completed" and state.get("id"):
            return str(state["id"])
    for state in states:
        if not isinstance(state, dict):
            continue
        if str(state.get("name") or "").strip().lower() == "done" and state.get("id"):
            return str(state["id"])
    return None


async def complete_conductor_human_action(
    token: str,
    action: dict[str, Any],
    *,
    response: str,
) -> dict[str, Any]:
    child_issue_id = str(action.get("child_issue_id") or "").strip()
    if not child_issue_id:
        return {"status": "skipped", "reason": "missing_child_issue_id", "action": action}
    issue = await fetch_linear_human_action_issue(token, child_issue_id)
    state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
    if str(state.get("type") or "") == "completed" or str(state.get("name") or "").strip().lower() == "done":
        return {"status": "already_done", "child_issue_id": child_issue_id, "child_identifier": issue.get("identifier")}
    description = human_action_description_with_response(str(issue.get("description") or ""), response)
    updated = await update_linear_issue_description(token, child_issue_id, description)
    done_state_id = done_state_id_for_human_action(issue)
    if not done_state_id:
        return {
            "status": "failed",
            "reason": "done_state_not_found",
            "child_issue_id": child_issue_id,
            "description_updated": bool(updated.get("success")),
        }
    moved = await move_linear_issue_to_state(token, child_issue_id, done_state_id)
    moved_issue = moved.get("issue") if isinstance(moved, dict) and isinstance(moved.get("issue"), dict) else {}
    return {
        "status": "completed" if moved.get("success") else "failed",
        "child_issue_id": child_issue_id,
        "child_identifier": moved_issue.get("identifier") or issue.get("identifier"),
        "description_updated": bool(updated.get("success")),
        "state": moved_issue.get("state"),
    }


def linear_webhook_signature(secret: str, payload: bytes) -> str:
    import hashlib
    import hmac

    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def build_instance_payload(
    *,
    run_id: str,
    fixture: Path,
    project_slug: str,
    agent_app_user_id: str,
    pipeline_gates: bool,
    simulate_agent_webhook: bool,
) -> dict[str, Any]:
    linear_filters: dict[str, Any] = {}
    if not simulate_agent_webhook:
        linear_filters["linear_agent_app_user_id"] = agent_app_user_id
    return {
        "name": f"Matrix {run_id}",
        "repo_source_type": "local_path",
        "repo_source_value": str(fixture),
        "linear_project": project_slug,
        "linear_filters": linear_filters,
        "pipeline_profile": "gated-task" if pipeline_gates else "default",
    }


def build_agent_session_webhook_payload(
    *,
    linear: dict[str, Any],
    workspace_id: str,
    agent_app_user_id: str,
    simulate_agent_webhook: bool,
) -> dict[str, Any]:
    issue = linear["issue"]
    linear_agent_sessions = ((issue.get("agentSessions") or {}).get("nodes") or [])
    linear_agent_session = linear_agent_sessions[0] if linear_agent_sessions else {}
    delegate = issue.get("delegate")
    if simulate_agent_webhook:
        delegate = {"id": agent_app_user_id}
    return {
        "type": "AgentSessionEvent",
        "action": "created",
        "workspace": {"id": workspace_id},
        "agentSession": {
            "id": linear_agent_session.get("id") or f"session-{uuid.uuid4().hex}",
            "appUserId": agent_app_user_id,
            "appUser": {"id": agent_app_user_id},
            "issue": {
                "id": issue["id"],
                "identifier": issue["identifier"],
                "title": issue.get("title") or issue["identifier"],
                "description": issue.get("description") or "",
                "project": {"slugId": linear["project"]["slugId"]},
                "assignee": issue.get("assignee"),
                "delegate": delegate,
            },
        },
    }
