from __future__ import annotations

from typing import Any

APPENDIX_EXIT_BAR_ITEMS: tuple[dict[str, Any], ...] = (
    {
        "item": 1,
        "summary": "real business issue decomposed, PlanValidated, committed, and projected as a Linear blocks tree",
        "required_checks": {"stage:managed-run-gates-frozen", "stage:managed-run-linear-projected"},
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
            "stage:managed-run-manifest-published",
            "stage:final-managed-run-verified",
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
        "summary": "Managed Runs view shows live work-item detail and conditional predicted order with basis",
        "required_checks": {"conductor-api:GET /api/managed-runs", "appendix:managed-run-prediction-conditional"},
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
        "summary": "dependency predicate plus Managed Runs observability",
        "r_checks": {"conductor-api:GET /api/managed-runs", "appendix:s0b-managed-run-live-refresh"},
        "h_checks": {
            "appendix:managed-run-prediction-conditional",
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
        "r_checks": {"stage:final-managed-run-verified"},
        "h_checks": {
            "appendix:s1-superseded-revision-refused",
            "appendix:s1-terminal-attempt-immutable",
        },
    },
    {
        "feature": "S2",
        "summary": "planner mode, PlanValidator, and Linear projection",
        "r_checks": {"stage:managed-run-gates-frozen", "stage:managed-run-linear-projected"},
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
            "stage:managed-run-manifest-published",
            "stage:final-managed-run-verified",
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
    runs = pipeline_payload.get("runs")
    if isinstance(runs, list):
        items = [
            item
            for run in runs
            if isinstance(run, dict)
            for item in run.get("work_items") or []
            if isinstance(item, dict)
        ]
        checkpoints = [
            result
            for run in runs
            if isinstance(run, dict)
            for result in run.get("checkpoint_results") or []
            if isinstance(result, dict)
        ]
        return bool(items) and all(item.get("state") in {"done", "cancelled"} for item in items) and all(result.get("passed") for result in checkpoints)
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    return bool(integrations) and all(item.get("status") in {"integrated", "resolved"} for item in integrations)


def pipeline_has_conflict_escalation_evidence(pipeline_payload: dict[str, Any]) -> bool:
    waits = [wait for wait in pipeline_payload.get("human_waits", []) if isinstance(wait, dict)]
    has_conflict_wait = any(wait.get("reason") == "LINEAR_SYNC_CONFLICT" for wait in waits)
    if has_conflict_wait:
        return True
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    return any(item.get("status") == "conflict" and item.get("error") for item in integrations)
