from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from real_symphony_e2e_acceptance_base import (
    _managed_run_avoids_global_codex_home,
    _parse_e2e_time,
    _pipeline_prediction_is_conditional,
)
from real_symphony_e2e_analysis import (
    appendix_exit_bar_audit,
    appendix_feature_score_audit,
    pipeline_has_conflict_escalation_evidence,
    pipeline_integrations_terminal,
)
from real_symphony_e2e_common import Evidence


def _check_appendix_overall_acceptance(
    evidence: Evidence,
    pipeline_view: dict[str, Any],
    *,
    data_root: Path | None = None,
    instance_id: str | None = None,
) -> None:
    _check_runtime_home_acceptance(evidence, pipeline_view, data_root=data_root, instance_id=instance_id)
    _check_prediction_acceptance(evidence, pipeline_view)
    _check_downstream_acceptance(evidence, pipeline_view)
    _check_conflict_and_score_acceptance(evidence, pipeline_view)


def _check_runtime_home_acceptance(
    evidence: Evidence,
    pipeline_view: dict[str, Any],
    *,
    data_root: Path | None,
    instance_id: str | None,
) -> None:
    home_evidence = _runtime_home_evidence(data_root=data_root, instance_id=instance_id, pipeline_view=pipeline_view)
    profiles = (pipeline_view.get("runtime_config") or {}).get("profiles") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    evidence.check("appendix:s0c-distinct-mode-codex-homes", home_evidence["distinct_mode_homes"], runtime_homes=home_evidence)
    evidence.check("appendix:s0c-concurrent-runs-do-not-share-mode-homes", home_evidence["concurrent_execute_homes_distinct"], runtime_homes=home_evidence)
    evidence.check(
        "appendix:s0c-non-codex-backend-selected",
        any(isinstance(profile, dict) and profile.get("backend") and profile.get("backend") != "codex" for profile in (profiles or {}).values()),
        profiles=profiles,
    )


def _check_prediction_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    evidence.check(
        "appendix:pipeline-prediction-conditional",
        _pipeline_prediction_is_conditional(pipeline_view),
        prediction_basis=pipeline_view.get("prediction_basis"),
        predicted_call_order=pipeline_view.get("predicted_call_order"),
    )
    evidence.check(
        "appendix:s0b-view-refreshes-after-rewrite",
        int(pipeline_view.get("graph_revision") or 0) > 1
        and int(basis.get("graph_revision") or 0) == int(pipeline_view.get("graph_revision") or 0),
        graph_revision=pipeline_view.get("graph_revision"),
        prediction_basis=basis,
    )


def _check_downstream_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    downstream_evidence = _downstream_verify_gate_evidence(pipeline_view)
    evidence.check("appendix:s3-downstream-gated-on-verify-passed", downstream_evidence["gate_observed"], **downstream_evidence)
    overall_shape_evidence = _overall_downstream_depends_on_both_parallel_evidence(pipeline_view)
    evidence.check(
        "appendix:overall-downstream-depends-on-both-parallel-subtasks",
        overall_shape_evidence["has_downstream_with_both_parallel_blockers"],
        **overall_shape_evidence,
    )
    gate_evidence = _gate_step_provenance_evidence(pipeline_view)
    evidence.check(
        "appendix:gate-step-provenance-checkpoint",
        gate_evidence["all_steps_have_valid_source"] and gate_evidence["all_gates_have_authoritative_step"],
        **gate_evidence,
    )
    superseded = _superseded_node_evidence(pipeline_view)
    evidence.check("appendix:s4-no-old-node-dependent-dispatch", superseded["no_superseded_dispatch"], **superseded)


def _check_conflict_and_score_acceptance(evidence: Evidence, pipeline_view: dict[str, Any]) -> None:
    evidence.check("appendix:no-global-codex-home", _managed_run_avoids_global_codex_home(pipeline_view), runtime_config=pipeline_view.get("runtime_config"))
    overlap_seen = any(check.get("name") == "scenario:parallel-execute-overlap" and check.get("passed") for check in evidence.data.get("checks", []))
    evidence.check("appendix:patch-conflict-reproducible-under-real-concurrency", pipeline_has_conflict_escalation_evidence(pipeline_view) and overlap_seen, integration_queue=pipeline_view.get("integration_queue"))
    evidence.check("appendix:patch-downstream-never-consumes-unintegrated-output", pipeline_integrations_terminal(pipeline_view), integration_queue=pipeline_view.get("integration_queue"))
    evidence.check("appendix:reconcile-findings-clean", not evidence.data.get("failures"))
    score_audit = appendix_feature_score_audit([evidence.data])
    evidence.check("appendix:evidence-scores-within-hard-caps", bool(score_audit["within_hard_caps"]), audit=score_audit)
    audit = appendix_exit_bar_audit([evidence.data])
    evidence.check("appendix:feature-scores-r-plus-h", audit["pass"], audit=audit)


def _runtime_home_evidence(*, data_root: Path | None, instance_id: str | None, pipeline_view: dict[str, Any]) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    homes_root = data_root / "instances" / instance_id / "runtime-homes" if data_root is not None and instance_id else None
    homes: dict[str, list[str]] = {mode: [] for mode in ("plan", "execute", "verify")}
    if homes_root is not None and homes_root.is_dir():
        _collect_runtime_homes(homes_root, homes)
    execute_attempt_count = sum(1 for attempt in attempts if attempt.get("mode") == "execute")
    execute_homes = homes.get("execute", [])
    mode_home_sets = [set(paths) for paths in homes.values() if paths]
    flattened = [path for paths in homes.values() for path in paths]
    return {
        "homes_root": str(homes_root) if homes_root is not None else None,
        "homes": homes,
        "execute_attempt_count": execute_attempt_count,
        "distinct_mode_homes": bool(flattened) and len(flattened) == len(set(flattened)) and not any(left & right for index, left in enumerate(mode_home_sets) for right in mode_home_sets[index + 1 :]),
        "concurrent_execute_homes_distinct": execute_attempt_count < 2 or (len(execute_homes) >= execute_attempt_count and len(execute_homes) == len(set(execute_homes))),
    }


def _collect_runtime_homes(homes_root: Path, homes: dict[str, list[str]]) -> None:
    for mode in homes:
        mode_root = homes_root / mode
        if not mode_root.is_dir():
            continue
        for path in sorted(mode_root.glob("*/*")):
            if path.is_dir():
                homes[mode].append(str(path))
        for path in sorted(mode_root.iterdir()):
            if path.is_dir() and not any(Path(existing).parent == path for existing in homes[mode]):
                if path.name in {"codex", "local-verifier"}:
                    homes[mode].append(str(path))


def _downstream_verify_gate_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    blocks = [(str(edge[0]), str(edge[1])) for edge in pipeline_view.get("blocks", []) if isinstance(edge, list) and len(edge) == 2]
    if not blocks:
        return {"gate_observed": False, "verify_passed_attempts": _verify_attempt_ids(attempts), "downstream_execute_attempts": [], "reason": "no_block_edges"}
    verifies_by_node = _passed_verifies_by_node(attempts)
    downstream_execute_ids: list[str] = []
    upstream_verify_ids: set[str] = set()
    for attempt in [item for item in attempts if item.get("mode") == "execute"]:
        result = _downstream_attempt_gate_result(attempt, blocks, verifies_by_node)
        if result:
            downstream_execute_ids.append(str(attempt.get("attempt_id") or ""))
            upstream_verify_ids.update(result)
    return {"gate_observed": bool(verifies_by_node) and bool(downstream_execute_ids), "verify_passed_attempts": sorted(upstream_verify_ids) if upstream_verify_ids else _verify_attempt_ids(attempts), "downstream_execute_attempts": downstream_execute_ids}


def _passed_verifies_by_node(attempts: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    verifies: dict[str, list[dict[str, Any]]] = {}
    for attempt in attempts:
        if attempt.get("mode") == "verify" and int(attempt.get("score") or 0) >= 3 and str(attempt.get("node_id") or ""):
            verifies.setdefault(str(attempt.get("node_id") or ""), []).append(attempt)
    return verifies


def _downstream_attempt_gate_result(
    attempt: dict[str, Any],
    blocks: list[tuple[str, str]],
    verifies_by_node: dict[str, list[dict[str, Any]]],
) -> list[str]:
    node_id = str(attempt.get("node_id") or "")
    blockers = {blocker for blocker, blocked in blocks if blocked == node_id}
    started = _parse_e2e_time(attempt.get("started_at"))
    if not blockers or started is None:
        return []
    latest_verifies = [_latest_verify_for_node(blocker, verifies_by_node) for blocker in blockers]
    if not all(latest_verifies):
        return []
    completed = [item[0] for item in latest_verifies if item is not None]
    return [item[1] for item in latest_verifies if item is not None] if started > max(completed) else []


def _latest_verify_for_node(
    node_id: str,
    verifies_by_node: dict[str, list[dict[str, Any]]],
) -> tuple[datetime, str] | None:
    return max(
        ((_parse_e2e_time(verify.get("completed_at")), str(verify.get("attempt_id") or "")) for verify in verifies_by_node.get(node_id, []) if _parse_e2e_time(verify.get("completed_at")) is not None),
        default=None,
        key=lambda item: item[0],
    )


def _verify_attempt_ids(attempts: list[dict[str, Any]]) -> list[Any]:
    return [attempt.get("attempt_id") for attempt in attempts if attempt.get("mode") == "verify" and int(attempt.get("score") or 0) >= 3]


def _overall_downstream_depends_on_both_parallel_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    blocks = [(str(edge[0]), str(edge[1])) for edge in pipeline_view.get("blocks", []) if isinstance(edge, list) and len(edge) == 2]
    labels = {str(node.get("node_id") or ""): f"{node.get('node_id') or ''} {node.get('title') or ''}".lower() for node in nodes}
    parallel_ids = sorted(node_id for node_id, label in labels.items() if "parallel" in label)
    downstream_ids = sorted(node_id for node_id, label in labels.items() if node_id not in parallel_ids and ("downstream" in label or "integration" in label))
    blockers_by_node: dict[str, set[str]] = {}
    for blocker, blocked in blocks:
        blockers_by_node.setdefault(blocked, set()).add(blocker)
    matching = [node_id for node_id in downstream_ids if len(blockers_by_node.get(node_id, set()).intersection(parallel_ids)) >= 2]
    return {"has_downstream_with_both_parallel_blockers": bool(matching), "parallel_node_ids": parallel_ids, "downstream_node_ids": downstream_ids, "matching_downstream_node_ids": matching, "blocks": [[source, target] for source, target in blocks]}


def _gate_step_provenance_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    valid_sources = {"issue_requirement", "appendix_harness", "planner_inferred", "system_repair"}
    authoritative_sources = {"issue_requirement", "appendix_harness", "system_repair"}
    missing: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    gates_without_authoritative: list[str] = []
    gates = [gate for gate in pipeline_view.get("gates", []) if isinstance(gate, dict)]
    for gate in gates:
        _audit_gate_steps(gate, valid_sources, authoritative_sources, missing, invalid, gates_without_authoritative)
    return {"gate_count": len(gates), "all_steps_have_valid_source": bool(gates) and not missing and not invalid, "all_gates_have_authoritative_step": bool(gates) and not gates_without_authoritative, "missing_source_steps": missing, "invalid_source_steps": invalid, "gates_without_authoritative_step": gates_without_authoritative}


def _audit_gate_steps(
    gate: dict[str, Any],
    valid_sources: set[str],
    authoritative_sources: set[str],
    missing: list[dict[str, Any]],
    invalid: list[dict[str, Any]],
    gates_without_authoritative: list[str],
) -> None:
    gate_id = str(gate.get("gate_id") or gate.get("task_id") or "")
    content = gate.get("content") if isinstance(gate.get("content"), dict) else {}
    steps = content.get("verification_procedure") if isinstance(content, dict) else []
    authoritative = False
    for index, step in enumerate(steps if isinstance(steps, list) else []):
        source = _audit_gate_step(gate_id, index, step, valid_sources, authoritative_sources, missing, invalid)
        authoritative = authoritative or source in authoritative_sources
    if not authoritative:
        gates_without_authoritative.append(gate_id)


def _audit_gate_step(
    gate_id: str,
    index: int,
    step: Any,
    valid_sources: set[str],
    authoritative_sources: set[str],
    missing: list[dict[str, Any]],
    invalid: list[dict[str, Any]],
) -> str:
    if not isinstance(step, dict):
        missing.append({"gate_id": gate_id, "index": index, "step": step})
        return ""
    source = str(step.get("source") or "")
    if not source:
        missing.append({"gate_id": gate_id, "index": index, "step": step.get("step")})
    elif source not in valid_sources:
        invalid.append({"gate_id": gate_id, "index": index, "source": source})
    return source if source in authoritative_sources else ""


def _superseded_node_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    superseded_ids = {str(node.get("node_id") or "") for node in nodes if node.get("state") == "superseded" or node.get("superseded_by")}
    live_attempts = [attempt.get("attempt_id") for attempt in attempts if str(attempt.get("node_id") or "") in superseded_ids and attempt.get("state") in {"pending", "running"}]
    return {"no_superseded_dispatch": bool(superseded_ids) and not live_attempts, "superseded_node_ids": sorted(superseded_ids), "live_superseded_attempts": live_attempts}
