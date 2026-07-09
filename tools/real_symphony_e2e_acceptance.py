from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import (
    appendix_exit_bar_audit,
    appendix_feature_score_audit,
    pipeline_has_conflict_escalation_evidence,
    pipeline_integrations_terminal,
    pipeline_nodes_terminal,
)
from real_symphony_e2e_common import Evidence, api_url, http_json
from real_symphony_e2e_linear import fetch_linear_issue_tree


APPENDIX_PYTEST_HARDENING_PROBES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "appendix:s1-terminal-attempt-immutable",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s1-superseded-revision-refused",
        ("tests/conductor_pipeline/test_replanning.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s2-malformed-proposal-refused",
        (
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_cycles_missing_gates_and_incomplete_rubrics",
            "tests/test_pipeline_contracts.py::test_plan_validator_rejects_bad_or_unfrozen_gate_hashes",
        ),
    ),
    (
        "appendix:s2-gate-post-freeze-immutable",
        (
            "tests/conductor_pipeline/test_store_and_runtime_env.py::test_execute_attempt_cannot_start_without_frozen_gate_snapshot",
            "tests/conductor_pipeline/test_store_and_runtime_env.py::test_verify_attempt_cannot_start_without_frozen_gate_snapshot",
        ),
    ),
    (
        "appendix:s2-linear-idempotent-rerun",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_pipeline_coordinator_resumes_existing_root_planning_node_for_duplicate_dispatch",),
    ),
    (
        "appendix:s3-verifier-mutation-detection",
        (
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_verification_worktree",
            "tests/test_performer_modes.py::test_verify_mode_rejects_gate_commands_that_mutate_tracked_state",
        ),
    ),
    (
        "appendix:s3-applied-tree-mismatch-rejected",
        ("tests/test_performer_modes.py::test_verify_mode_rejects_expected_result_tree_mismatch",),
    ),
    (
        "appendix:s3-expired-fencing-refused",
        ("tests/conductor_pipeline/test_scheduler_views_and_requests.py::test_attempt_lifecycle_rejects_stale_fenced_results_and_publishes_verified_manifest",),
    ),
    (
        "appendix:s4-superseded-revision-fenced",
        ("tests/conductor_pipeline/test_replanning.py::test_replan_rejects_replacement_subgraph_that_reuses_superseded_node_id",),
    ),
    (
        "appendix:s4-invalid-replan-escalates",
        ("tests/conductor_pipeline/test_replanning.py::test_replanning_validation_failure_escalates_to_human_without_failed_node",),
    ),
    (
        "appendix:linear-legitimate-blocks-edits-ingested",
        ("tests/conductor_pipeline/test_linear_projection.py::test_pipeline_linear_projector_ingests_human_added_blocks_as_new_graph_revision",),
    ),
)


def _run_appendix_pytest_hardening_probes(evidence: Evidence, *, env: dict[str, str]) -> None:
    python = str(Path.cwd() / ".venv" / "bin" / "python")
    for check_name, nodeids in APPENDIX_PYTEST_HARDENING_PROBES:
        command = [python, "-m", "pytest", *nodeids, "-q"]
        completed = subprocess.run(
            command,
            cwd=Path.cwd(),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        evidence.check(
            check_name,
            completed.returncode == 0,
            command=command,
            returncode=completed.returncode,
            output_tail=(completed.stdout or "")[-4000:],
        )


def _pipeline_live_refresh_evidence(samples: list[dict[str, Any]]) -> dict[str, Any]:
    node_state_signatures: list[tuple[tuple[str, str], ...]] = []
    active_lease_counts: list[int] = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        nodes = [node for node in sample.get("pipeline_nodes", []) if isinstance(node, dict)]
        leases = [lease for lease in sample.get("pipeline_leases", []) if isinstance(lease, dict)]
        if nodes:
            node_state_signatures.append(
                tuple(sorted((str(node.get("node_id") or ""), str(node.get("state") or "")) for node in nodes))
            )
        active_lease_counts.append(len(leases))
    distinct_node_states = len(set(node_state_signatures))
    distinct_lease_counts = len(set(active_lease_counts))
    return {
        "passed": len(samples) >= 2 and (distinct_node_states >= 2 or distinct_lease_counts >= 2),
        "sample_count": len(samples),
        "distinct_node_state_snapshots": distinct_node_states,
        "distinct_active_lease_counts": distinct_lease_counts,
    }


async def _lower_policy_during_parallel_execute_probe(
    *,
    podium_port: int,
    conductor_port: int,
    runtime_token: str,
    runtime_config: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    observed_leases: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        status, body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=5)
        pipeline = body.get("pipeline") if status == 200 and isinstance(body, dict) else {}
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        execute_leases = [lease for lease in leases if lease.get("mode") == "execute"]
        if len(execute_leases) >= 2:
            observed_leases = execute_leases
            break
        await asyncio.sleep(1)
    if len(observed_leases) < 2:
        return {"passed": False, "reason": "parallel_execute_leases_not_observed", "observed_leases": observed_leases}
    lowered = json.loads(json.dumps(runtime_config))
    lowered["version"] = int(runtime_config.get("version") or 1) + 1
    lowered["scheduler_policy"]["version"] = lowered["version"]
    lowered["scheduler_policy"]["capacity"]["by_mode"]["execute"] = 1
    status, body = http_json(
        "POST",
        api_url(podium_port, "/api/v1/runtime/config"),
        lowered,
        headers={"Authorization": f"Bearer {runtime_token}"},
        timeout=5,
    )
    if status != 200:
        return {"passed": False, "reason": "lowered_policy_push_failed", "status": status, "body": body}
    observed_ids = {str(lease.get("lease_id") or "") for lease in observed_leases}
    latest_policy_revision = 0
    latest_execute_ids: set[str] = set()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        pipeline_status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"), timeout=5)
        pipeline = pipeline_body.get("pipeline") if pipeline_status == 200 and isinstance(pipeline_body, dict) else {}
        latest_policy_revision = int(pipeline.get("policy_revision") or 0) if isinstance(pipeline, dict) else 0
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        latest_execute_ids = {str(lease.get("lease_id") or "") for lease in leases if lease.get("mode") == "execute"}
        if latest_policy_revision >= lowered["version"]:
            break
        await asyncio.sleep(1)
    return {
        "passed": latest_policy_revision >= lowered["version"] and observed_ids.issubset(latest_execute_ids),
        "lowered_version": lowered["version"],
        "latest_policy_revision": latest_policy_revision,
        "observed_execute_lease_ids": sorted(observed_ids),
        "latest_execute_lease_ids": sorted(latest_execute_ids),
    }


def _pipeline_scenario(args: argparse.Namespace) -> str:
    scenario = str(getattr(args, "pipeline_scenario", "basic") or "basic")
    allowed = {"basic", "parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization", "overall-dod"}
    return scenario if scenario in allowed else "basic"


def _effective_permission_approval_probe(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "permission_approval_probe", False) or _pipeline_scenario(args) in {"runtime-wait", "overall-dod"})


def _should_run_final_pipeline_stage_checks(*, permission_approval_probe: bool, pipeline_scenario: str) -> bool:
    return not permission_approval_probe or pipeline_scenario == "overall-dod"


def _pipeline_scenario_issue_description(scenario: str, run_id: str) -> str:
    base = (
        f"Real Symphony e2e task for run {run_id}. "
        "Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, include this Linear issue identifier, "
        "say Podium, Conductor, and Performer reached Codex, and run pytest tests/test_smoke.py -q."
    )
    if scenario == "parallel":
        return (
            f"Real Symphony parallel pipeline e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Create two independent deliverables with no dependency between them: SYMPHONY_PARALLEL_A.md and "
            "SYMPHONY_PARALLEL_B.md. Each file must include this Linear issue identifier and the words "
            "parallel execute. Also create SYMPHONY_REAL_E2E_RESULT.md and run pytest tests/test_smoke.py -q."
        )
    if scenario == "replan":
        return (
            f"Real Symphony replan pipeline e2e task for run {run_id}. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words replan recovery. "
            "If verification reports a missing or incorrect result, decompose the replacement work into a fresh "
            "subtask graph and run pytest tests/test_smoke.py -q."
        )
    if scenario == "integration-conflict":
        return (
            f"Real Symphony integration conflict e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Planner must create two independent parallel subtasks and must not add a blocks dependency between them. "
            "Each subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different content, "
            "so their verified patches overlap and the integration queue must surface the conflict through a "
            "[Human Action] child issue. At least one subtask must create SYMPHONY_REAL_E2E_RESULT.md with the Linear "
            "issue identifier and the words integration conflict. Run pytest tests/test_smoke.py -q."
        )
    if scenario == "runtime-wait":
        return (
            f"Real Symphony runtime wait e2e task for run {run_id}. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words runtime wait. "
            "If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait "
            "to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q."
        )
    if scenario == "overall-dod":
        return (
            f"Real Symphony Appendix overall DoD e2e task for run {run_id}. "
            "Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. "
            "Planner must create two independent parallel subtasks and must not add a blocks dependency between them. "
            "Each parallel subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different "
            "content so their verified patches overlap and Symphony must surface the integration result without a "
            "silent last-writer-wins merge. At least one downstream subtask must depend on both parallel subtasks' "
            "verified upstream output. "
            "Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words overall dod. "
            "If verification fails, replan with a replacement subgraph that preserves the requested files and smoke "
            "test. If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait "
            "to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q."
        )
    return base


def _pipeline_scenario_intent(scenario: str) -> dict[str, Any]:
    if scenario not in {"parallel", "integration-conflict", "overall-dod", "gate-normalization"}:
        return {}
    intent: dict[str, Any] = {
        "required_gate_steps": [
            {"step": "pytest tests/test_smoke.py -q", "source": "appendix_harness"}
        ]
    }
    if scenario in {"parallel", "integration-conflict", "overall-dod"}:
        intent["parallel_dependency_shape"] = {
            "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
            "downstream_node_ids": ["hell-downstream-integration"],
        }
    if scenario in {"integration-conflict", "overall-dod", "gate-normalization"}:
        intent["required_gate_steps"].append(
            {"step": "test -f SYMPHONY_CONFLICT_SHARED.md", "source": "appendix_harness"}
        )
    return intent


def _prepare_pipeline_scenario_fixture(fixture: Path, scenario: str) -> None:
    if scenario not in {"integration-conflict", "overall-dod"}:
        return
    conflict_path = fixture / "SYMPHONY_CONFLICT_SHARED.md"
    conflict_path.write_text("base integration conflict fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", conflict_path.name], cwd=fixture, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "add integration conflict fixture"], cwd=fixture, check=True)


async def _wait_for_final_pipeline_view(
    conductor_port: int,
    *,
    timeout_seconds: int,
    allow_human_wait: bool = False,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_view: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, pipeline_body = http_json("GET", api_url(conductor_port, "/api/pipeline"))
        pipeline_view = (
            pipeline_body.get("pipeline")
            if status == 200 and isinstance(pipeline_body, dict) and isinstance(pipeline_body.get("pipeline"), dict)
            else {}
        )
        if isinstance(pipeline_view, dict):
            last_view = pipeline_view
            if _pipeline_final_view_converged(pipeline_view, allow_human_wait=allow_human_wait):
                return pipeline_view
        await asyncio.sleep(2)
    return last_view


def _pipeline_final_view_converged(pipeline_view: dict[str, Any], *, allow_human_wait: bool = False) -> bool:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    terminal_states = {"verify_passed", "superseded"}
    if allow_human_wait:
        terminal_states.add("need_human")
    return pipeline_nodes_terminal(nodes, terminal_states=terminal_states) and _pipeline_projection_matches_current_revision(
        pipeline_view
    )


def _permission_probe_block_cleared(sample: dict[str, Any]) -> bool:
    actions = sample.get("pipeline_human_actions") if isinstance(sample, dict) else []
    if not isinstance(actions, list):
        return False
    return not [
        action
        for action in actions
        if isinstance(action, dict) and str(action.get("status") or "").lower() in {"waiting", "open"}
    ]


def _pipeline_prediction_is_conditional(pipeline_view: dict[str, Any]) -> bool:
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    if not basis.get("graph_revision") or not basis.get("policy_revision") or not basis.get("generated_at"):
        return False
    if str(basis.get("assumption") or "") != "unknown verifies pass":
        return False
    order = pipeline_view.get("predicted_call_order")
    if not isinstance(order, list):
        return False
    return all(
        isinstance(item, dict) and str(item.get("confidence") or "") == "conditional"
        for item in order
    )


def _managed_run_avoids_global_codex_home(pipeline_view: dict[str, Any]) -> bool:
    home_codex = str(Path.home().resolve() / ".codex")
    text = json.dumps(pipeline_view, sort_keys=True, default=str)
    if home_codex in text or str(Path("~/.codex").expanduser()) in text:
        return False
    runtime_config = pipeline_view.get("runtime_config") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    profiles = runtime_config.get("profiles") if isinstance(runtime_config.get("profiles"), dict) else {}
    for profile in profiles.values():
        if not isinstance(profile, dict):
            continue
        settings = profile.get("settings") if isinstance(profile.get("settings"), dict) else {}
        source = str(settings.get("codex_home_source") or "")
        if source and not source.startswith("$"):
            return False
    return True


def _pipeline_projection_matches_current_revision(pipeline_view: dict[str, Any]) -> bool:
    try:
        graph_revision = int(pipeline_view.get("graph_revision") or 0)
    except (TypeError, ValueError):
        return False
    nodes = {
        str(node.get("node_id") or ""): node
        for node in pipeline_view.get("nodes", [])
        if isinstance(node, dict) and str(node.get("node_id") or "")
    }
    projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
    if graph_revision <= 0 or not nodes or not projections:
        return False
    for projection in projections:
        metadata = projection.get("metadata") if isinstance(projection.get("metadata"), dict) else {}
        node_id = str(projection.get("node_id") or metadata.get("node_id") or "")
        if node_id not in nodes:
            return False
        if str(metadata.get("node_id") or "") != node_id:
            return False
        try:
            projection_revision = int(metadata.get("conductor_revision") or 0)
        except (TypeError, ValueError):
            return False
        if projection_revision != graph_revision:
            return False
        if not metadata.get("graph_id") or not metadata.get("operator_status"):
            return False
        gate_hash = str(nodes[node_id].get("gate_snapshot_hash") or "")
        if gate_hash and metadata.get("gate_snapshot_hash") != gate_hash:
            return False
    return True


def _pipeline_node_requires_gate(node: dict[str, Any], nodes: list[dict[str, Any]]) -> bool:
    node_id = str(node.get("node_id") or "")
    if not node_id:
        return False
    if node.get("gate_snapshot_hash"):
        return True
    return not any(str(candidate.get("parent_node_id") or "") == node_id for candidate in nodes)


def _check_pipeline_scenario_acceptance(evidence: Evidence, scenario: str, pipeline_view: dict[str, Any]) -> None:
    if scenario == "basic":
        return
    if scenario == "parallel":
        attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
        execute_attempts = [attempt for attempt in attempts if attempt.get("mode") == "execute"]
        execute_limit = ((pipeline_view.get("capacity") or {}).get("by_mode") or {}).get("execute")
        policy_id = str(pipeline_view.get("policy_id") or "")
        policy_source = str(pipeline_view.get("policy_source") or "")
        runtime_config = pipeline_view.get("runtime_config") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
        expected_policy = runtime_config.get("scheduler_policy") if isinstance(runtime_config.get("scheduler_policy"), dict) else {}
        expected_scheduler_policy_id = str(expected_policy.get("policy_id") or "")
        expected_scheduler_policy_version = _safe_int(expected_policy.get("version"))
        last_scheduler_policy_id = str(pipeline_view.get("last_scheduler_policy_id") or "")
        last_scheduler_policy_version = _safe_int(pipeline_view.get("last_scheduler_policy_version"))
        last_scheduler_policy_source = str(pipeline_view.get("last_scheduler_policy_source") or "")
        last_scheduler_tick_at = str(pipeline_view.get("last_scheduler_tick_at") or "")
        scheduler_policy_matches = (
            bool(expected_scheduler_policy_id)
            and expected_scheduler_policy_version > 0
            and last_scheduler_policy_source == "podium_pushed"
            and last_scheduler_policy_id == expected_scheduler_policy_id
            and last_scheduler_policy_version == expected_scheduler_policy_version
            and bool(last_scheduler_tick_at)
        )
        evidence.check(
            "scenario:parallel-execute-overlap",
            policy_source == "podium_pushed"
            and bool(policy_id)
            and scheduler_policy_matches
            and len(execute_attempts) >= 2
            and _attempt_intervals_overlap(execute_attempts),
            execute_attempts=[
                {
                    "attempt_id": attempt.get("attempt_id"),
                    "started_at": attempt.get("started_at"),
                    "completed_at": attempt.get("completed_at"),
                }
                for attempt in execute_attempts
            ],
            execute_limit=execute_limit,
            policy_id=policy_id,
            policy_source=policy_source,
            expected_scheduler_policy_id=expected_scheduler_policy_id,
            expected_scheduler_policy_version=expected_scheduler_policy_version,
            last_scheduler_policy_id=last_scheduler_policy_id,
            last_scheduler_policy_version=last_scheduler_policy_version,
            last_scheduler_policy_source=last_scheduler_policy_source,
            last_scheduler_tick_at=last_scheduler_tick_at,
        )
    elif scenario == "replan":
        nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
        evidence.check(
            "scenario:replan-replacement-subgraph",
            int(pipeline_view.get("graph_revision") or 0) > 1
            and any(node.get("state") == "superseded" or node.get("superseded_by") for node in nodes),
            graph_revision=pipeline_view.get("graph_revision"),
            nodes=[{"node_id": node.get("node_id"), "state": node.get("state"), "superseded_by": node.get("superseded_by")} for node in nodes],
        )
    elif scenario == "integration-conflict":
        waits = [wait for wait in pipeline_view.get("human_waits", []) if isinstance(wait, dict)]
        integrations = [item for item in pipeline_view.get("integration_queue", []) if isinstance(item, dict)]
        evidence.check(
            "scenario:integration-conflict-human-action",
            pipeline_has_conflict_escalation_evidence(pipeline_view),
            human_waits=waits,
            integrations=integrations,
        )
    elif scenario == "runtime-wait":
        waits = [wait for wait in pipeline_view.get("runtime_waits", []) if isinstance(wait, dict)]
        projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
        resolved_wait_visible = any(wait.get("wait_kind") and wait.get("child_issue_id") for wait in waits)
        evidence.check(
            "scenario:runtime-wait-projected",
            bool(waits)
            and (
                any((projection.get("metadata") or {}).get("operator_wait_kind") for projection in projections)
                or resolved_wait_visible
            ),
            runtime_waits=waits,
            projections=projections,
        )
    elif scenario == "gate-normalization":
        gate_provenance_evidence = _gate_step_provenance_evidence(pipeline_view)
        evidence.check(
            "scenario:gate-normalization-provenance",
            gate_provenance_evidence["all_steps_have_valid_source"]
            and gate_provenance_evidence["all_gates_have_authoritative_step"],
            **gate_provenance_evidence,
        )
    elif scenario == "overall-dod":
        _check_pipeline_scenario_acceptance(evidence, "parallel", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "replan", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "integration-conflict", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "runtime-wait", pipeline_view)
        _check_pipeline_scenario_acceptance(evidence, "gate-normalization", pipeline_view)


def _pipeline_linear_issue_tree_finalized(tree: dict[str, Any]) -> dict[str, Any]:
    children = (tree.get("children") or {}).get("nodes")
    if not isinstance(children, list):
        children = []
    pipeline_children = [
        child
        for child in children
        if isinstance(child, dict)
        and any(
            isinstance(label, dict) and label.get("name") == "performer:type/pipeline-node"
            for label in ((child.get("labels") or {}).get("nodes") or [])
        )
    ]
    child_states = [
        {
            "identifier": child.get("identifier"),
            "title": child.get("title"),
            "state": (child.get("state") or {}).get("name") if isinstance(child.get("state"), dict) else None,
            "state_type": (child.get("state") or {}).get("type") if isinstance(child.get("state"), dict) else None,
        }
        for child in pipeline_children
    ]
    root_state = tree.get("state") if isinstance(tree.get("state"), dict) else {}
    root_state_type = str(root_state.get("type") or "")
    children_final = bool(pipeline_children) and all(
        str(item.get("state_type") or "") in {"completed", "canceled"} for item in child_states
    )
    return {
        "passed": root_state_type == "completed" and children_final,
        "root_identifier": tree.get("identifier"),
        "root_state": root_state.get("name"),
        "root_state_type": root_state_type,
        "pipeline_children": child_states,
    }


async def _wait_for_pipeline_linear_issue_tree_finalized(
    *,
    token: str,
    issue_id: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + max(timeout_seconds, 1)
    last_tree: dict[str, Any] = {}
    last_result: dict[str, Any] = {"passed": False, "reason": "not_checked"}
    while True:
        last_tree = await fetch_linear_issue_tree(token, issue_id)
        last_result = _pipeline_linear_issue_tree_finalized(last_tree)
        if bool(last_result.get("passed")) or time.monotonic() >= deadline:
            return last_tree, last_result
        await asyncio.sleep(2)


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _check_appendix_overall_acceptance(
    evidence: Evidence,
    pipeline_view: dict[str, Any],
    *,
    data_root: Path | None = None,
    instance_id: str | None = None,
) -> None:
    home_evidence = _runtime_home_evidence(data_root=data_root, instance_id=instance_id, pipeline_view=pipeline_view)
    evidence.check(
        "appendix:s0c-distinct-mode-codex-homes",
        home_evidence["distinct_mode_homes"],
        runtime_homes=home_evidence,
    )
    evidence.check(
        "appendix:s0c-concurrent-runs-do-not-share-mode-homes",
        home_evidence["concurrent_execute_homes_distinct"],
        runtime_homes=home_evidence,
    )
    profiles = (pipeline_view.get("runtime_config") or {}).get("profiles") if isinstance(pipeline_view.get("runtime_config"), dict) else {}
    evidence.check(
        "appendix:s0c-non-codex-backend-selected",
        any(
            isinstance(profile, dict) and profile.get("backend") and profile.get("backend") != "codex"
            for profile in (profiles or {}).values()
        ),
        profiles=profiles,
    )
    evidence.check(
        "appendix:pipeline-prediction-conditional",
        _pipeline_prediction_is_conditional(pipeline_view),
        prediction_basis=pipeline_view.get("prediction_basis"),
        predicted_call_order=pipeline_view.get("predicted_call_order"),
    )
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    evidence.check(
        "appendix:s0b-view-refreshes-after-rewrite",
        int(pipeline_view.get("graph_revision") or 0) > 1
        and int(basis.get("graph_revision") or 0) == int(pipeline_view.get("graph_revision") or 0),
        graph_revision=pipeline_view.get("graph_revision"),
        prediction_basis=basis,
    )
    downstream_evidence = _downstream_verify_gate_evidence(pipeline_view)
    evidence.check(
        "appendix:s3-downstream-gated-on-verify-passed",
        downstream_evidence["gate_observed"],
        **downstream_evidence,
    )
    overall_shape_evidence = _overall_downstream_depends_on_both_parallel_evidence(pipeline_view)
    evidence.check(
        "appendix:overall-downstream-depends-on-both-parallel-subtasks",
        overall_shape_evidence["has_downstream_with_both_parallel_blockers"],
        **overall_shape_evidence,
    )
    gate_provenance_evidence = _gate_step_provenance_evidence(pipeline_view)
    evidence.check(
        "appendix:gate-step-provenance-checkpoint",
        gate_provenance_evidence["all_steps_have_valid_source"]
        and gate_provenance_evidence["all_gates_have_authoritative_step"],
        **gate_provenance_evidence,
    )
    s4_evidence = _superseded_node_evidence(pipeline_view)
    evidence.check("appendix:s4-no-old-node-dependent-dispatch", s4_evidence["no_superseded_dispatch"], **s4_evidence)
    evidence.check(
        "appendix:no-global-codex-home",
        _managed_run_avoids_global_codex_home(pipeline_view),
        runtime_config=pipeline_view.get("runtime_config"),
    )
    evidence.check(
        "appendix:patch-conflict-reproducible-under-real-concurrency",
        pipeline_has_conflict_escalation_evidence(pipeline_view)
        and any(check.get("name") == "scenario:parallel-execute-overlap" and check.get("passed") for check in evidence.data.get("checks", [])),
        integration_queue=pipeline_view.get("integration_queue"),
    )
    evidence.check(
        "appendix:patch-downstream-never-consumes-unintegrated-output",
        pipeline_integrations_terminal(pipeline_view),
        integration_queue=pipeline_view.get("integration_queue"),
    )
    evidence.check("appendix:reconcile-findings-clean", not evidence.data.get("failures"))
    score_audit = appendix_feature_score_audit([evidence.data])
    evidence.check(
        "appendix:evidence-scores-within-hard-caps",
        bool(score_audit["within_hard_caps"]),
        audit=score_audit,
    )
    audit = appendix_exit_bar_audit([evidence.data])
    evidence.check("appendix:feature-scores-r-plus-h", audit["pass"], audit=audit)


def _runtime_home_evidence(
    *,
    data_root: Path | None,
    instance_id: str | None,
    pipeline_view: dict[str, Any],
) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    homes_root = data_root / "instances" / instance_id / "runtime-homes" if data_root is not None and instance_id else None
    homes: dict[str, list[str]] = {mode: [] for mode in ("plan", "execute", "verify")}
    if homes_root is not None and homes_root.is_dir():
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
    execute_attempt_count = sum(1 for attempt in attempts if attempt.get("mode") == "execute")
    execute_homes = homes.get("execute", [])
    mode_home_sets = [set(paths) for paths in homes.values() if paths]
    flattened = [path for paths in homes.values() for path in paths]
    return {
        "homes_root": str(homes_root) if homes_root is not None else None,
        "homes": homes,
        "execute_attempt_count": execute_attempt_count,
        "distinct_mode_homes": bool(flattened)
        and len(flattened) == len(set(flattened))
        and not any(left & right for index, left in enumerate(mode_home_sets) for right in mode_home_sets[index + 1 :]),
        "concurrent_execute_homes_distinct": execute_attempt_count < 2
        or (len(execute_homes) >= execute_attempt_count and len(execute_homes) == len(set(execute_homes))),
    }


def _downstream_verify_gate_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    execute_attempts = [attempt for attempt in attempts if attempt.get("mode") == "execute"]
    verify_attempts = [attempt for attempt in attempts if attempt.get("mode") == "verify" and int(attempt.get("score") or 0) >= 3]
    blocks = [
        (str(edge[0]), str(edge[1]))
        for edge in pipeline_view.get("blocks", [])
        if isinstance(edge, list) and len(edge) == 2
    ]
    blockers_by_node: dict[str, set[str]] = {}
    for blocker, blocked in blocks:
        blockers_by_node.setdefault(blocked, set()).add(blocker)
    verifies_by_node: dict[str, list[dict[str, Any]]] = {}
    for attempt in verify_attempts:
        node_id = str(attempt.get("node_id") or "")
        if node_id:
            verifies_by_node.setdefault(node_id, []).append(attempt)
    downstream_execute_ids: list[str] = []
    upstream_verify_ids: set[str] = set()
    if blockers_by_node:
        for attempt in execute_attempts:
            node_id = str(attempt.get("node_id") or "")
            blockers = blockers_by_node.get(node_id, set())
            if not blockers:
                continue
            started = _parse_e2e_time(attempt.get("started_at"))
            blocker_completions: list[datetime] = []
            blocker_verify_ids: list[str] = []
            for blocker in blockers:
                blocker_verifies = verifies_by_node.get(blocker, [])
                if not blocker_verifies:
                    blocker_completions = []
                    break
                latest = max(
                    (
                        (_parse_e2e_time(verify.get("completed_at")), str(verify.get("attempt_id") or ""))
                        for verify in blocker_verifies
                        if _parse_e2e_time(verify.get("completed_at")) is not None
                    ),
                    default=None,
                    key=lambda item: item[0],
                )
                if latest is None:
                    blocker_completions = []
                    break
                blocker_completions.append(latest[0])
                blocker_verify_ids.append(latest[1])
            if started is not None and blocker_completions and started > max(blocker_completions):
                downstream_execute_ids.append(str(attempt.get("attempt_id") or ""))
                upstream_verify_ids.update(blocker_verify_ids)
    else:
        return {
            "gate_observed": False,
            "verify_passed_attempts": [attempt.get("attempt_id") for attempt in verify_attempts],
            "downstream_execute_attempts": [],
            "reason": "no_block_edges",
        }
    return {
        "gate_observed": bool(verify_attempts) and bool(downstream_execute_ids),
        "verify_passed_attempts": sorted(upstream_verify_ids)
        if upstream_verify_ids
        else [attempt.get("attempt_id") for attempt in verify_attempts],
        "downstream_execute_attempts": downstream_execute_ids,
    }


def _overall_downstream_depends_on_both_parallel_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    blocks = [
        (str(edge[0]), str(edge[1]))
        for edge in pipeline_view.get("blocks", [])
        if isinstance(edge, list) and len(edge) == 2
    ]
    labels = {
        str(node.get("node_id") or ""): f"{node.get('node_id') or ''} {node.get('title') or ''}".lower()
        for node in nodes
    }
    parallel_node_ids = sorted(node_id for node_id, label in labels.items() if "parallel" in label)
    downstream_node_ids = sorted(
        node_id
        for node_id, label in labels.items()
        if node_id not in parallel_node_ids and ("downstream" in label or "integration" in label)
    )
    blockers_by_node: dict[str, set[str]] = {}
    for blocker, blocked in blocks:
        blockers_by_node.setdefault(blocked, set()).add(blocker)
    matching_downstream = [
        node_id
        for node_id in downstream_node_ids
        if len(blockers_by_node.get(node_id, set()).intersection(parallel_node_ids)) >= 2
    ]
    return {
        "has_downstream_with_both_parallel_blockers": bool(matching_downstream),
        "parallel_node_ids": parallel_node_ids,
        "downstream_node_ids": downstream_node_ids,
        "matching_downstream_node_ids": matching_downstream,
        "blocks": [[source, target] for source, target in blocks],
    }


def _gate_step_provenance_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    valid_sources = {"issue_requirement", "appendix_harness", "planner_inferred", "system_repair"}
    authoritative_sources = {"issue_requirement", "appendix_harness", "system_repair"}
    gates = [gate for gate in pipeline_view.get("gates", []) if isinstance(gate, dict)]
    missing_source_steps: list[dict[str, Any]] = []
    invalid_source_steps: list[dict[str, Any]] = []
    gates_without_authoritative_step: list[str] = []
    for gate in gates:
        gate_id = str(gate.get("gate_id") or gate.get("task_id") or "")
        content = gate.get("content") if isinstance(gate.get("content"), dict) else {}
        steps = content.get("verification_procedure") if isinstance(content, dict) else []
        authoritative = False
        for index, step in enumerate(steps if isinstance(steps, list) else []):
            if not isinstance(step, dict):
                missing_source_steps.append({"gate_id": gate_id, "index": index, "step": step})
                continue
            source = str(step.get("source") or "")
            if not source:
                missing_source_steps.append({"gate_id": gate_id, "index": index, "step": step.get("step")})
                continue
            if source not in valid_sources:
                invalid_source_steps.append({"gate_id": gate_id, "index": index, "source": source})
                continue
            if source in authoritative_sources:
                authoritative = True
        if not authoritative:
            gates_without_authoritative_step.append(gate_id)
    return {
        "gate_count": len(gates),
        "all_steps_have_valid_source": bool(gates) and not missing_source_steps and not invalid_source_steps,
        "all_gates_have_authoritative_step": bool(gates) and not gates_without_authoritative_step,
        "missing_source_steps": missing_source_steps,
        "invalid_source_steps": invalid_source_steps,
        "gates_without_authoritative_step": gates_without_authoritative_step,
    }


def _superseded_node_evidence(pipeline_view: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in pipeline_view.get("nodes", []) if isinstance(node, dict)]
    attempts = [attempt for attempt in pipeline_view.get("attempts", []) if isinstance(attempt, dict)]
    superseded_ids = {
        str(node.get("node_id") or "")
        for node in nodes
        if node.get("state") == "superseded" or node.get("superseded_by")
    }
    live_superseded_attempts = [
        attempt.get("attempt_id")
        for attempt in attempts
        if str(attempt.get("node_id") or "") in superseded_ids and attempt.get("state") in {"pending", "running"}
    ]
    return {
        "no_superseded_dispatch": bool(superseded_ids) and not live_superseded_attempts,
        "superseded_node_ids": sorted(superseded_ids),
        "live_superseded_attempts": live_superseded_attempts,
    }


def _attempt_intervals_overlap(attempts: list[dict[str, Any]]) -> bool:
    intervals: list[tuple[datetime, datetime]] = []
    for attempt in attempts:
        started_at = _parse_e2e_time(attempt.get("started_at"))
        completed_at = _parse_e2e_time(attempt.get("completed_at"))
        if started_at is not None and completed_at is not None:
            intervals.append((started_at, completed_at))
    for index, first in enumerate(intervals):
        for second in intervals[index + 1 :]:
            if first[0] <= second[1] and second[0] <= first[1]:
                return True
    return False


def _parse_e2e_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None
