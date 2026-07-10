from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import pipeline_nodes_terminal
from real_symphony_e2e_common import Evidence, api_url, http_json
from real_symphony_e2e_linear import fetch_linear_issue_tree

APPENDIX_PYTEST_HARDENING_PROBES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("appendix:s1-terminal-attempt-immutable", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_rejects_unapproved_replacement_plan_after_acceptance",)),
    ("appendix:s1-superseded-revision-refused", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_cancels_removed_work_items_on_approved_revision",)),
    (
        "appendix:s2-malformed-proposal-refused",
        (
            "tests/test_managed_run_contracts.py::test_managed_run_plan_validator_rejects_invalid_work_items",
            "tests/test_managed_run_contracts.py::test_managed_run_plan_validator_rejects_dependency_cycles",
            "tests/test_managed_run_contracts.py::test_managed_run_plan_validator_requires_full_definition_of_done_rubric",
        ),
    ),
    (
        "appendix:s2-gate-post-freeze-immutable",
        (
            "tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_waits_for_checkpoint_before_next_work_item",
            "tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_requires_final_checkpoint_before_done",
        ),
    ),
    ("appendix:s2-linear-idempotent-rerun", ("tests/test_conductor_managed_run_store.py::test_managed_run_store_records_linear_projection_idempotently",)),
    (
        "appendix:s3-verifier-mutation-detection",
        (
            "tests/test_performer_managed_run_backend.py::test_codex_managed_run_backend_rejects_plan_turn_file_changes",
            "tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_blocks_unplanned_file_changes_before_review",
        ),
    ),
    ("appendix:s3-applied-tree-mismatch-rejected", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_blocks_unplanned_file_changes_before_review",)),
    ("appendix:s3-expired-fencing-refused", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_keeps_failed_verification_out_of_done",)),
    ("appendix:s4-superseded-revision-fenced", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_approves_plan_revision_as_new_version",)),
    ("appendix:s4-invalid-replan-escalates", ("tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_exhausts_bounded_plan_validation_retries",)),
    ("appendix:linear-legitimate-blocks-edits-ingested", ("tests/test_real_run_tools_part1.py::test_linear_tree_audit_summarizes_children_and_blocks_relations",)),
)
def _run_appendix_pytest_hardening_probes(evidence: Evidence, *, env: dict[str, str]) -> None:
    python = str(Path.cwd() / ".venv" / "bin" / "python")
    for check_name, nodeids in APPENDIX_PYTEST_HARDENING_PROBES:
        completed = subprocess.run(
            [python, "-m", "pytest", *nodeids, "-q"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        evidence.check(check_name, completed.returncode == 0, command=[python, "-m", "pytest", *nodeids, "-q"], returncode=completed.returncode, output_tail=(completed.stdout or "")[-4000:])


def _pipeline_live_refresh_evidence(samples: list[dict[str, Any]]) -> dict[str, Any]:
    node_state_signatures: list[tuple[tuple[str, str], ...]] = []
    active_lease_counts: list[int] = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        nodes = [node for node in sample.get("managed_run_work_items", []) if isinstance(node, dict)]
        leases = [lease for lease in sample.get("managed_run_turns", []) if isinstance(lease, dict)]
        if nodes:
            node_state_signatures.append(tuple(sorted((str(node.get("node_id") or ""), str(node.get("state") or "")) for node in nodes)))
        active_lease_counts.append(len(leases))
    distinct_node_states = len(set(node_state_signatures))
    distinct_lease_counts = len(set(active_lease_counts))
    return {"passed": len(samples) >= 2 and (distinct_node_states >= 2 or distinct_lease_counts >= 2), "sample_count": len(samples), "distinct_node_state_snapshots": distinct_node_states, "distinct_active_lease_counts": distinct_lease_counts}
async def _lower_policy_during_parallel_execute_probe(
    *,
    podium_port: int,
    conductor_port: int,
    runtime_token: str,
    runtime_config: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    observed_leases = await _wait_for_parallel_execute_leases(conductor_port, timeout_seconds)
    if len(observed_leases) < 2:
        return {"passed": False, "reason": "parallel_execute_leases_not_observed", "observed_leases": observed_leases}
    lowered = json.loads(json.dumps(runtime_config))
    lowered["version"] = int(runtime_config.get("version") or 1) + 1
    lowered["managed_run_policy"]["version"] = lowered["version"]
    lowered["managed_run_policy"]["capacity"]["by_role"]["work_item"] = 1
    status, body = http_json("POST", api_url(podium_port, "/api/v1/runtime/config"), lowered, headers={"Authorization": f"Bearer {runtime_token}"}, timeout=5)
    if status != 200:
        return {"passed": False, "reason": "lowered_policy_push_failed", "status": status, "body": body}
    return await _observe_lowered_policy_no_preempt(conductor_port, lowered["version"], observed_leases)


async def _wait_for_parallel_execute_leases(conductor_port: int, timeout_seconds: int) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status, body = http_json("GET", api_url(conductor_port, "/api/managed-runs"), timeout=5)
        pipeline = body.get("managed_runs") if status == 200 and isinstance(body, dict) else {}
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        execute_leases = [lease for lease in leases if lease.get("mode") == "execute"]
        if len(execute_leases) >= 2:
            return execute_leases
        await asyncio.sleep(1)
    return []
async def _observe_lowered_policy_no_preempt(conductor_port: int, lowered_version: int, observed_leases: list[dict[str, Any]]) -> dict[str, Any]:
    observed_ids = {str(lease.get("lease_id") or "") for lease in observed_leases}
    latest_policy_revision = 0
    latest_execute_ids: set[str] = set()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, body = http_json("GET", api_url(conductor_port, "/api/managed-runs"), timeout=5)
        pipeline = body.get("managed_runs") if status == 200 and isinstance(body, dict) else {}
        latest_policy_revision = int(pipeline.get("policy_revision") or 0) if isinstance(pipeline, dict) else 0
        leases = [lease for lease in pipeline.get("leases", []) if isinstance(lease, dict)]
        latest_execute_ids = {str(lease.get("lease_id") or "") for lease in leases if lease.get("mode") == "execute"}
        if latest_policy_revision >= lowered_version:
            break
        await asyncio.sleep(1)
    return {"passed": latest_policy_revision >= lowered_version and observed_ids.issubset(latest_execute_ids), "lowered_version": lowered_version, "latest_policy_revision": latest_policy_revision, "observed_execute_lease_ids": sorted(observed_ids), "latest_execute_lease_ids": sorted(latest_execute_ids)}


def _pipeline_scenario(args: argparse.Namespace) -> str:
    scenario = str(getattr(args, "pipeline_scenario", "basic") or "basic")
    allowed = {"basic", "parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization", "overall-dod"}
    return scenario if scenario in allowed else "basic"


def _effective_permission_approval_probe(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "permission_approval_probe", False) or _pipeline_scenario(args) in {"runtime-wait", "overall-dod"})


def _should_run_final_pipeline_stage_checks(*, permission_approval_probe: bool, pipeline_scenario: str) -> bool:
    return not permission_approval_probe or pipeline_scenario == "overall-dod"


def _pipeline_scenario_issue_description(scenario: str, run_id: str) -> str:
    descriptions = {
        "parallel": f"Real Symphony parallel pipeline e2e task for run {run_id}. Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. Create two independent deliverables with no dependency between them: SYMPHONY_PARALLEL_A.md and SYMPHONY_PARALLEL_B.md. Each file must include this Linear issue identifier and the words parallel execute. Also create SYMPHONY_REAL_E2E_RESULT.md and run pytest tests/test_smoke.py -q.",
        "replan": f"Real Symphony replan pipeline e2e task for run {run_id}. Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words replan recovery. If verification reports a missing or incorrect result, decompose the replacement work into a fresh subtask graph and run pytest tests/test_smoke.py -q.",
        "integration-conflict": f"Real Symphony integration conflict e2e task for run {run_id}. Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. Planner must create two independent parallel subtasks and must not add a blocks dependency between them. Each subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different content, so their verified patches overlap and the integration queue must surface the conflict through a [Human Action] child issue. At least one subtask must create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words integration conflict. Run pytest tests/test_smoke.py -q.",
        "runtime-wait": f"Real Symphony runtime wait e2e task for run {run_id}. Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words runtime wait. If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q.",
        "gate-normalization": f"Real Symphony gate normalization e2e task for run {run_id}. Create SYMPHONY_CONFLICT_SHARED.md and SYMPHONY_REAL_E2E_RESULT.md with this Linear issue identifier and the words gate provenance. Preserve the requested smoke verification and ensure the plan keeps authoritative gate provenance for the required checks. Run pytest tests/test_smoke.py -q.",
        "overall-dod": f"Real Symphony Appendix overall DoD e2e task for run {run_id}. Use node_ids hell-parallel-a, hell-parallel-b, and hell-downstream-integration. Planner must create two independent parallel subtasks and must not add a blocks dependency between them. Each parallel subtask must modify the already tracked file SYMPHONY_CONFLICT_SHARED.md with different content so their verified patches overlap and Symphony must surface the integration result without a silent last-writer-wins merge. At least one downstream subtask must depend on both parallel subtasks' verified upstream output. Create SYMPHONY_REAL_E2E_RESULT.md with the Linear issue identifier and the words overall dod. If verification fails, replan with a replacement subgraph that preserves the requested files and smoke test. If the runtime asks for tool approval or operator input, Symphony must project that Runtime Wait to a [Human Action] child issue before resuming. Run pytest tests/test_smoke.py -q.",
    }
    return descriptions.get(scenario, f"Real Symphony e2e task for run {run_id}. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, include this Linear issue identifier, say Podium, Conductor, and Performer reached Codex, and run pytest tests/test_smoke.py -q.")


def _pipeline_scenario_intent(scenario: str) -> dict[str, Any]:
    if scenario not in {"parallel", "integration-conflict", "overall-dod", "gate-normalization"}:
        return {}
    intent: dict[str, Any] = {"required_gate_steps": [{"step": "pytest tests/test_smoke.py -q", "source": "acceptance_appendix"}]}
    if scenario in {"parallel", "integration-conflict", "overall-dod"}:
        intent["parallel_dependency_shape"] = {"parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"], "downstream_node_ids": ["hell-downstream-integration"]}
    if scenario in {"integration-conflict", "overall-dod", "gate-normalization"}:
        intent["required_gate_steps"].append({"step": "test -f SYMPHONY_CONFLICT_SHARED.md", "source": "acceptance_appendix"})
    return intent


def _prepare_pipeline_scenario_fixture(fixture: Path, scenario: str) -> None:
    if scenario not in {"integration-conflict", "overall-dod"}:
        return
    conflict_path = fixture / "SYMPHONY_CONFLICT_SHARED.md"
    conflict_path.write_text("base integration conflict fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", conflict_path.name], cwd=fixture, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "add integration conflict fixture"], cwd=fixture, check=True)


async def _wait_for_final_pipeline_view(conductor_port: int, *, timeout_seconds: int, allow_human_wait: bool = False) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_view: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, body = http_json("GET", api_url(conductor_port, "/api/managed-runs"))
        pipeline_view = body.get("managed_runs") if status == 200 and isinstance(body, dict) and isinstance(body.get("managed_runs"), dict) else {}
        if isinstance(pipeline_view, dict):
            last_view = pipeline_view
            if _pipeline_final_view_converged(pipeline_view, allow_human_wait=allow_human_wait):
                return pipeline_view
        await asyncio.sleep(2)
    return last_view


def _pipeline_final_view_converged(pipeline_view: dict[str, Any], *, allow_human_wait: bool = False) -> bool:
    nodes = _managed_run_nodes(pipeline_view)
    terminal_states = {"verify_passed", "superseded"}
    if allow_human_wait:
        terminal_states.add("need_human")
    return pipeline_nodes_terminal(nodes, terminal_states=terminal_states) and _pipeline_projection_matches_current_revision(pipeline_view)


def _permission_probe_block_cleared(sample: dict[str, Any]) -> bool:
    actions = sample.get("managed_run_human_actions") if isinstance(sample, dict) else []
    if not isinstance(actions, list):
        return False
    return not [action for action in actions if isinstance(action, dict) and str(action.get("status") or "").lower() in {"waiting", "open"}]


def _pipeline_prediction_is_conditional(pipeline_view: dict[str, Any]) -> bool:
    basis = pipeline_view.get("prediction_basis") if isinstance(pipeline_view.get("prediction_basis"), dict) else {}
    order = pipeline_view.get("predicted_call_order")
    return bool(basis.get("graph_revision") and basis.get("policy_revision") and basis.get("generated_at")) and str(basis.get("assumption") or "") == "unknown verifies pass" and isinstance(order, list) and all(isinstance(item, dict) and str(item.get("confidence") or "") == "conditional" for item in order)


def _managed_run_avoids_global_codex_home(pipeline_view: dict[str, Any]) -> bool:
    text = json.dumps(pipeline_view, sort_keys=True, default=str)
    if str(Path.home().resolve() / ".codex") in text or str(Path("~/.codex").expanduser()) in text:
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
    if isinstance(pipeline_view.get("runs"), list):
        return _managed_run_projection_matches_current_version(pipeline_view)
    try:
        graph_revision = int(pipeline_view.get("graph_revision") or 0)
    except (TypeError, ValueError):
        return False
    nodes = {str(node.get("node_id") or ""): node for node in pipeline_view.get("nodes", []) if isinstance(node, dict) and str(node.get("node_id") or "")}
    projections = [projection for projection in pipeline_view.get("linear_projections", []) if isinstance(projection, dict)]
    if graph_revision <= 0 or not nodes or not projections:
        return False
    return all(_projection_matches_node(projection, nodes, graph_revision) for projection in projections)


def _projection_matches_node(projection: dict[str, Any], nodes: dict[str, dict[str, Any]], graph_revision: int) -> bool:
    metadata = projection.get("metadata") if isinstance(projection.get("metadata"), dict) else {}
    node_id = str(projection.get("node_id") or metadata.get("node_id") or "")
    try:
        projection_revision = int(metadata.get("conductor_revision") or 0)
    except (TypeError, ValueError):
        return False
    gate_hash = str(nodes.get(node_id, {}).get("gate_snapshot_hash") or "")
    return node_id in nodes and str(metadata.get("node_id") or "") == node_id and projection_revision == graph_revision and bool(metadata.get("graph_id") and metadata.get("operator_status")) and (not gate_hash or metadata.get("gate_snapshot_hash") == gate_hash)


def _pipeline_node_requires_gate(node: dict[str, Any], nodes: list[dict[str, Any]]) -> bool:
    node_id = str(node.get("node_id") or "")
    return bool(node_id and (node.get("gate_snapshot_hash") or not any(str(candidate.get("parent_node_id") or "") == node_id for candidate in nodes)))


def _pipeline_linear_issue_tree_finalized(tree: dict[str, Any]) -> dict[str, Any]:
    children = (tree.get("children") or {}).get("nodes")
    pipeline_children = [child for child in children if isinstance(child, dict) and _is_pipeline_work_item_child(child)] if isinstance(children, list) else []
    child_states = [{"identifier": child.get("identifier"), "title": child.get("title"), "state": (child.get("state") or {}).get("name") if isinstance(child.get("state"), dict) else None, "state_type": (child.get("state") or {}).get("type") if isinstance(child.get("state"), dict) else None} for child in pipeline_children]
    root_state = tree.get("state") if isinstance(tree.get("state"), dict) else {}
    root_state_type = str(root_state.get("type") or "")
    children_final = bool(pipeline_children) and all(str(item.get("state_type") or "") in {"completed", "canceled"} for item in child_states)
    return {"passed": root_state_type == "completed" and children_final, "root_identifier": tree.get("identifier"), "root_state": root_state.get("name"), "root_state_type": root_state_type, "managed_run_children": child_states}


def _is_pipeline_work_item_child(child: dict[str, Any]) -> bool:
    labels = (child.get("labels") or {}).get("nodes") if isinstance(child.get("labels"), dict) else []
    description = str(child.get("description") or "")
    return any(isinstance(label, dict) and label.get("name") == "symphony:type/work-item" for label in labels) or all(heading in description for heading in ["Objective:", "Acceptance Criteria:", "Verification:", "Managed Run State:"])


def _managed_run_nodes(view: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(view.get("runs"), list):
        return [node for node in view.get("nodes", []) if isinstance(node, dict)]
    nodes: list[dict[str, Any]] = []
    for run in view.get("runs") or []:
        if not isinstance(run, dict):
            continue
        for item in run.get("work_items") or []:
            if not isinstance(item, dict):
                continue
            state = str(item.get("state") or "")
            nodes.append(
                {
                    "node_id": item.get("work_item_id"),
                    "work_item_id": item.get("work_item_id"),
                    "state": {"done": "verify_passed", "cancelled": "superseded", "blocked": "need_human"}.get(state, state),
                    "gate_status": item.get("gate_status"),
                }
            )
    return nodes


def _managed_run_projection_matches_current_version(view: dict[str, Any]) -> bool:
    for run in view.get("runs") or []:
        if not isinstance(run, dict):
            continue
        try:
            plan_version = int(run.get("plan_version") or 0)
        except (TypeError, ValueError):
            return False
        work_items = {str(item.get("work_item_id") or ""): item for item in run.get("work_items") or [] if isinstance(item, dict)}
        projections = [projection for projection in run.get("linear_projections") or [] if isinstance(projection, dict)]
        if plan_version <= 0 or not work_items or not projections:
            return False
        for projection in projections:
            work_item_id = str(projection.get("work_item_id") or "")
            metadata = projection.get("metadata") if isinstance(projection.get("metadata"), dict) else {}
            if work_item_id and (
                work_item_id not in work_items
                or metadata.get("run_id") != run.get("run_id")
                or metadata.get("work_item_id") != work_item_id
                or metadata.get("state") != work_items[work_item_id].get("state")
            ):
                return False
    return True


async def _wait_for_pipeline_linear_issue_tree_finalized(*, token: str, issue_id: str, timeout_seconds: int) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + max(timeout_seconds, 1)
    while True:
        tree = await fetch_linear_issue_tree(token, issue_id)
        result = _pipeline_linear_issue_tree_finalized(tree)
        if bool(result.get("passed")) or time.monotonic() >= deadline:
            return tree, result
        await asyncio.sleep(2)


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _attempt_intervals_overlap(attempts: list[dict[str, Any]]) -> bool:
    intervals = [(_parse_e2e_time(attempt.get("started_at")), _parse_e2e_time(attempt.get("completed_at"))) for attempt in attempts]
    complete = [(start, end) for start, end in intervals if start is not None and end is not None]
    return any(first[0] <= second[1] and second[0] <= first[1] for index, first in enumerate(complete) for second in complete[index + 1 :])


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
