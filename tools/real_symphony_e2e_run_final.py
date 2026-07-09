from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from real_symphony_e2e_acceptance import (
    _check_appendix_overall_acceptance,
    _check_pipeline_scenario_acceptance,
    _permission_probe_block_cleared,
    _pipeline_linear_issue_tree_finalized,
    _pipeline_live_refresh_evidence,
    _pipeline_node_requires_gate,
    _pipeline_projection_matches_current_revision,
    _should_run_final_pipeline_stage_checks,
    _wait_for_final_pipeline_view,
    _wait_for_pipeline_linear_issue_tree_finalized,
)
from real_symphony_e2e_analysis import (
    audit_expected_failure_run,
    pipeline_integrations_terminal,
    pipeline_nodes_terminal,
)
from real_symphony_e2e_artifacts import _archive_pipeline_artifacts
from real_symphony_e2e_common import api_url, http_json, make_fixture_repo, start_process, wait_for_http_ready
from real_symphony_e2e_linear import fetch_linear_issue_tree
from real_symphony_e2e_run_state import E2ERunState


async def run_post_wait_checks(state: E2ERunState) -> None:
    await _probe_coverage_checks(state)
    issue = state.run_result["issue"]
    result_path = Path(state.run_result["result_path"])
    last_sample = (state.run_result.get("samples") or [{}])[-1]
    leases = [lease for lease in last_sample.get("pipeline_leases", []) if isinstance(lease, dict)] if isinstance(last_sample, dict) else []
    nodes = [node for node in last_sample.get("pipeline_nodes", []) if isinstance(node, dict)] if isinstance(last_sample, dict) else []
    if state.pipeline_scenario == "overall-dod":
        _record_live_refresh(state)
    if state.permission_approval_probe:
        _record_permission_probe_cleared(state, last_sample, leases)
    elif state.args.expected_failure != "none":
        await _record_expected_failure_audit(state)
    else:
        _record_success_outcome(state, issue, result_path, leases, nodes)
    if state.args.pipeline_gates and state.args.expected_failure == "none":
        await run_final_pipeline_checks(state)


async def _probe_coverage_checks(state: E2ERunState) -> None:
    check_names = {check.get("name") for check in state.evidence.data.get("checks", []) if check.get("passed")}
    if state.permission_approval_probe:
        required = {
            "human-action:conductor-pipeline-awaiting-human",
            "human-action:parent-comment-does-not-resume",
            "human-action:linear-child-complete",
            "human-action:managed-push-resume",
            "human-action:resume-observed-after-push",
        }
        state.evidence.check(
            "runtime-error:permission-approval-covered",
            required.issubset(check_names),
            covered=sorted(name for name in check_names if str(name).startswith("human-action:")),
            human_resume_covered=required.issubset(check_names),
        )
    if state.pipeline_scenario == "overall-dod" or state.args.crash_recovery_probe:
        state.evidence.check(
            "appendix:s0a-crashed-worker-lease-reclaimed",
            "crash-recovery:covered" in check_names,
            covered=sorted(name for name in check_names if str(name).startswith("crash-recovery:")),
        )
    if state.lowered_policy_task is not None:
        lowered_policy = await state.lowered_policy_task
        state.evidence.check(
            "appendix:s0a-lowered-limit-no-preempt",
            bool(lowered_policy.get("passed")),
            **{key: value for key, value in lowered_policy.items() if key != "passed"},
        )


def _record_live_refresh(state: E2ERunState) -> None:
    live_refresh = _pipeline_live_refresh_evidence(state.run_result.get("samples") or [])
    state.evidence.check(
        "appendix:s0b-pipeline-live-refresh",
        bool(live_refresh.get("passed")),
        **{key: value for key, value in live_refresh.items() if key != "passed"},
    )


def _record_permission_probe_cleared(state: E2ERunState, last_sample: dict[str, Any], leases: list[dict[str, Any]]) -> None:
    state.evidence.check(
        "runtime-error:blocked-cleared-after-approval",
        _permission_probe_block_cleared(last_sample),
        pipeline_human_actions=last_sample.get("pipeline_human_actions") if isinstance(last_sample, dict) else [],
        pipeline_leases=leases,
    )


async def _record_expected_failure_audit(state: E2ERunState) -> None:
    tree = await fetch_linear_issue_tree(state.token, state.linear["issue"]["id"])
    tree_path = state.root / "final-issue-tree.json"
    tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("final_issue_tree", tree_path)
    audit = audit_expected_failure_run(state.run_result, tree, expected=state.args.expected_failure)
    audit_path = state.root / "expected-failure-audit.json"
    audit_path.write_text(json.dumps(audit, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("expected_failure_audit", audit_path)
    state.evidence.check(f"expected-failure:{state.args.expected_failure}", bool(audit.get("pass")), audit=audit)


def _record_success_outcome(
    state: E2ERunState,
    issue: dict[str, Any],
    result_path: Path,
    leases: list[dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> None:
    if state.args.pipeline_gates:
        state.evidence.check("real-flow:linear-pipeline-projected", True, identifier=issue["identifier"], state=issue["state"])
    else:
        state.evidence.check("real-flow:linear-done", issue["state"]["type"] in {"completed", "canceled"}, identifier=issue["identifier"], state=issue["state"])
    state.evidence.check("real-flow:linear-agent-app-user-dispatched", ((issue.get("delegate") or {}).get("id") == state.agent_app_user_id), expected_agent_app_user_id=state.agent_app_user_id, actual_delegate=issue.get("delegate"), actual_assignee=issue.get("assignee"))
    state.evidence.check("real-flow:workspace-result", result_path.exists(), path=str(result_path))
    state.evidence.check("real-flow:no-active-pipeline-leases", not leases, pipeline_leases=leases)
    state.evidence.check(
        "real-flow:pipeline-finalized",
        pipeline_nodes_terminal(nodes, terminal_states={"verify_passed", "failed", "superseded"}),
        pipeline_nodes=nodes[-5:],
    )


async def run_final_pipeline_checks(state: E2ERunState) -> None:
    view = await _wait_for_final_pipeline_view(
        state.conductor_port,
        timeout_seconds=min(max(state.args.stage_timeout, 5), 120),
        allow_human_wait=state.pipeline_scenario == "integration-conflict",
    )
    path = state.root / "final-pipeline-view.json"
    path.write_text(json.dumps(view, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("final_pipeline_view", path)
    if state.permission_approval_probe:
        await _record_human_action_tree(state)
        _check_pipeline_scenario_acceptance(state.evidence, state.pipeline_scenario, view)
    if _should_run_final_pipeline_stage_checks(
        permission_approval_probe=state.permission_approval_probe,
        pipeline_scenario=state.pipeline_scenario,
    ):
        _record_pipeline_stage_checks(state, view)


async def _record_human_action_tree(state: E2ERunState) -> None:
    tree = await fetch_linear_issue_tree(state.token, state.linear["issue"]["id"])
    tree_path = state.root / "final-issue-tree.json"
    tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("final_issue_tree", tree_path)
    human_actions = [
        child
        for child in tree["children"]["nodes"]
        if child["title"].startswith("[Human Action]")
        or any(label["name"] == "performer:type/human-action" for label in child["labels"]["nodes"])
    ]
    state.evidence.check(
        "human-action:child-type-label-visible",
        bool(human_actions)
        and all(any(label["name"] == "performer:type/human-action" for label in child["labels"]["nodes"]) for child in human_actions)
        and any(child["state"]["type"] in {"completed", "canceled"} for child in human_actions),
        human_actions=[_human_action_summary(child) for child in human_actions],
    )


def _human_action_summary(child: dict[str, Any]) -> dict[str, Any]:
    return {
        "identifier": child["identifier"],
        "title": child["title"],
        "state": child["state"],
        "labels": [label["name"] for label in child["labels"]["nodes"]],
    }


def _record_pipeline_stage_checks(state: E2ERunState, view: dict[str, Any]) -> None:
    nodes = [node for node in view.get("nodes", []) if isinstance(node, dict)]
    manifests = [manifest for manifest in view.get("manifests", []) if isinstance(manifest, dict)]
    integrations = [item for item in view.get("integration_queue", []) if isinstance(item, dict)]
    projections = [projection for projection in view.get("linear_projections", []) if isinstance(projection, dict)]
    executable_nodes = [node for node in nodes if _pipeline_node_requires_gate(node, nodes)]
    executable_node_ids = {str(node.get("node_id") or "") for node in executable_nodes}
    state.evidence.check("stage:pipeline-gates-frozen", bool(executable_nodes) and all(node.get("gate_snapshot_hash") for node in executable_nodes), nodes=[_node_gate_summary(node, executable_node_ids) for node in nodes])
    state.evidence.check("stage:pipeline-manifest-published", bool(manifests) and all(int(manifest.get("score") or 0) >= 3 for manifest in manifests), manifests=manifests)
    state.evidence.check("stage:pipeline-integration-completed", pipeline_integrations_terminal(view), integrations=integrations)
    state.evidence.check("stage:pipeline-linear-projected", _linear_projection_passed(view, projections, executable_node_ids), projections=projections, graph_revision=view.get("graph_revision"))
    _check_pipeline_scenario_acceptance(state.evidence, state.pipeline_scenario, view)
    terminal_states = {"verify_passed", "superseded", "need_human"} if state.pipeline_scenario == "integration-conflict" else {"verify_passed", "superseded"}
    state.evidence.check("stage:final-pipeline-verified", pipeline_nodes_terminal(nodes, terminal_states=terminal_states), nodes=[{"node_id": node.get("node_id"), "state": node.get("state")} for node in nodes])
    if state.pipeline_scenario == "overall-dod":
        _check_appendix_overall_acceptance(state.evidence, view, data_root=state.data_root, instance_id=state.instance_id)


def _node_gate_summary(node: dict[str, Any], executable_node_ids: set[str]) -> dict[str, Any]:
    return {
        "node_id": node.get("node_id"),
        "state": node.get("state"),
        "requires_gate": str(node.get("node_id") or "") in executable_node_ids,
        "gate_snapshot_hash": bool(node.get("gate_snapshot_hash")),
    }


def _linear_projection_passed(view: dict[str, Any], projections: list[dict[str, Any]], executable_ids: set[str]) -> bool:
    return bool(projections) and _pipeline_projection_matches_current_revision(view) and all(
        isinstance(projection.get("metadata"), dict)
        and projection["metadata"].get("graph_id")
        and projection["metadata"].get("node_id")
        and (projection["metadata"].get("gate_snapshot_hash") or str(projection.get("node_id") or projection["metadata"].get("node_id") or "") not in executable_ids)
        and projection["metadata"].get("conductor_revision")
        and projection["metadata"].get("operator_status")
        for projection in projections
    )


async def archive_tree_and_runtime_artifacts(state: E2ERunState) -> None:
    tree_path = state.root / "final-issue-tree.json"
    final_states: dict[str, Any] | None = None
    if state.args.pipeline_gates and state.args.expected_failure == "none" and not state.permission_approval_probe and state.pipeline_scenario == "replan":
        tree, final_states = await _wait_for_pipeline_linear_issue_tree_finalized(token=state.token, issue_id=state.linear["issue"]["id"], timeout_seconds=min(max(state.args.stage_timeout, 10), 120))
        tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
        state.evidence.artifact("final_issue_tree", tree_path)
    elif not tree_path.exists():
        tree = await fetch_linear_issue_tree(state.token, state.linear["issue"]["id"])
        tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
        state.evidence.artifact("final_issue_tree", tree_path)
    if final_states is not None:
        state.evidence.check("stage:pipeline-linear-final-states", bool(final_states.get("passed")), **{key: value for key, value in final_states.items() if key != "passed"})
    _archive_pipeline_artifacts(evidence=state.evidence, root=state.root, data_root=state.data_root, instance_id=state.instance_id)


async def run_service_recovery_and_cleanup_checks(state: E2ERunState) -> None:
    _check_remaining_and_removed_conductor_routes(state)
    if state.pipeline_scenario == "overall-dod":
        _check_local_defaults_without_podium(state)
    if not state.permission_approval_probe:
        await _check_restart_recovers_completed_one_shot(state)
    status, _body = http_json("POST", api_url(state.conductor_port, f"/api/instances/{state.instance_id}/stop"), {})
    state.evidence.check("conductor-api:POST /api/instances/{id}/stop", status == 200, status=status)
    _check_disposable_instance_delete(state)


def _check_remaining_and_removed_conductor_routes(state: E2ERunState) -> None:
    status, _body = http_json("GET", api_url(state.conductor_port, "/api/pipeline"), None)
    state.evidence.check("conductor-api:GET /api/pipeline", status == 200, status=status)
    for method, path, payload in [
        ("GET", "/api/dashboard", None), ("GET", "/api/issues", None), ("GET", "/api/issues/legacy-issue", None),
        ("POST", "/api/issues/legacy-issue/pin", {}), ("DELETE", "/api/issues/legacy-issue/pin", None),
        ("GET", "/api/traces", None), ("GET", "/api/retention", None), ("POST", "/api/retention/collect", {}),
    ]:
        status, body = http_json(method, api_url(state.conductor_port, path), payload)
        state.evidence.check(f"conductor-api-removed:{method} {path}", status == 404, status=status, body=body)


def _check_local_defaults_without_podium(state: E2ERunState) -> None:
    podium = state.processes[0]
    podium.stop()
    state.processes.remove(podium)
    status, body = http_json("GET", api_url(state.conductor_port, "/api/pipeline"))
    pipeline = body.get("pipeline") if status == 200 and isinstance(body, dict) else {}
    state.evidence.check(
        "appendix:s0a-podium-unreachable-local-defaults",
        status == 200 and isinstance(pipeline, dict) and int(pipeline.get("policy_revision") or 0) >= 1,
        status=status,
        policy_revision=pipeline.get("policy_revision") if isinstance(pipeline, dict) else None,
    )


async def _check_restart_recovers_completed_one_shot(state: E2ERunState) -> None:
    conductor = state.processes[-1]
    conductor.stop()
    state.processes.remove(conductor)
    conductor = start_process("conductor", [str(state.bin_dir / "conductor"), "--port", str(state.conductor_port), "--data-root", str(state.data_root)], env=state.env, stdout_path=state.root / "conductor-live-recovered.log")
    state.processes.append(conductor)
    await wait_for_http_ready(api_url(state.conductor_port, "/"))
    status, body = http_json("GET", api_url(state.conductor_port, f"/api/instances/{state.instance_id}"))
    recovered = body.get("instance", {}) if isinstance(body, dict) else {}
    state.evidence.check("conductor-daemon:restart-recovers-completed-one-shot", status == 200 and recovered.get("process_status") in {"exited", "stopped"}, status=status, process_status=recovered.get("process_status"), pid=recovered.get("pid"))


def _check_disposable_instance_delete(state: E2ERunState) -> None:
    disposable_fixture = make_fixture_repo(state.root / "fixture-repo-disposable")
    payload = {"name": f"Disposable {state.run_id}", "repo_source_type": "local_path", "repo_source_value": str(disposable_fixture), "linear_project": state.linear["project"]["slugId"], "linear_filters": {"linear_agent_app_user_id": state.agent_app_user_id}, "pipeline_profile": "default"}
    status, body = http_json("POST", api_url(state.conductor_port, "/api/instances"), payload)
    disposable_id = body.get("instance", {}).get("id") if status == 201 else None
    state.evidence.check("conductor-api:POST /api/instances disposable", status == 201, status=status)
    if disposable_id:
        status, _body = http_json("DELETE", api_url(state.conductor_port, f"/api/instances/{disposable_id}"))
        state.evidence.check("conductor-api:DELETE /api/instances/{id}", status == 200, status=status)
