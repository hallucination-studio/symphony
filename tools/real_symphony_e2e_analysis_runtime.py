from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence

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
