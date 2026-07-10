from __future__ import annotations

import json
from typing import Any

from real_symphony_e2e_acceptance import _wait_for_pipeline_linear_issue_tree_finalized
from real_symphony_e2e_artifacts import _archive_managed_run_artifacts
from real_symphony_e2e_linear import fetch_linear_issue_tree
from real_symphony_e2e_podium_evidence import (
    archive_podium_api_snapshots,
    validate_podium_final_managed_run,
    wait_for_podium_managed_run,
)
from real_symphony_e2e_run_state import E2ERunState


async def archive_tree_and_runtime_artifacts(state: E2ERunState) -> None:
    await _archive_final_podium_truth(state)
    tree_path = state.root / "final-issue-tree.json"
    final_states: dict[str, Any] | None = None
    if _must_wait_for_replan_tree(state):
        tree, final_states = await _wait_for_pipeline_linear_issue_tree_finalized(
            token=state.token,
            issue_id=state.linear["issue"]["id"],
            timeout_seconds=min(max(state.args.stage_timeout, 10), 120),
        )
        tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
        state.evidence.artifact("final_issue_tree", tree_path)
    elif not tree_path.exists():
        tree = await fetch_linear_issue_tree(state.token, state.linear["issue"]["id"])
        tree_path.write_text(json.dumps(tree, indent=2, sort_keys=True), encoding="utf-8")
        state.evidence.artifact("final_issue_tree", tree_path)
    if final_states is not None:
        state.evidence.check(
            "stage:managed-run-linear-final-states",
            bool(final_states.get("passed")),
            **{key: value for key, value in final_states.items() if key != "passed"},
        )
    _archive_managed_run_artifacts(
        evidence=state.evidence,
        root=state.root,
        data_root=state.data_root,
        instance_id=state.instance_id,
    )


def _must_wait_for_replan_tree(state: E2ERunState) -> bool:
    return bool(
        state.args.pipeline_gates
        and state.args.expected_failure == "none"
        and not state.permission_approval_probe
        and state.pipeline_scenario == "replan"
    )


async def _archive_final_podium_truth(state: E2ERunState) -> None:
    issue = state.linear.get("issue") if isinstance(state.linear, dict) else {}
    issue_id = str((issue or {}).get("id") or "")
    issue_identifier = str((issue or {}).get("identifier") or "")
    await wait_for_podium_managed_run(
        state.podium_session,
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        timeout_seconds=min(max(state.args.stage_timeout, 10), 120),
    )
    snapshots = await archive_podium_api_snapshots(
        state.podium_session,
        root=state.root,
        evidence=state.evidence,
        prefix="final",
    )
    run = validate_podium_final_managed_run(
        snapshots,
        issue_id=issue_id,
        issue_identifier=issue_identifier,
    )
    state.evidence.check(
        "podium-api:final-managed-run-visible",
        True,
        run_id=run.get("run_id"),
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        state=run.get("state"),
    )
