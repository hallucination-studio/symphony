from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence
from runtime_claims_audit import copy_sanitized_file, sanitize_evidence_value


def write_wait_artifacts(
    *,
    evidence: Evidence,
    samples: list[dict[str, Any]],
    result_path: Path,
    final_issue: dict[str, Any],
    log_path: Path,
    stages: dict[str, str],
    stage_timeout_seconds: int,
) -> dict[str, Any]:
    safe_samples = sanitize_evidence_value(samples)
    safe_final_issue = sanitize_evidence_value(final_issue)
    samples_path = evidence.out.parent / "runtime-samples.json"
    samples_path.write_text(json.dumps(safe_samples, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("runtime_samples", samples_path)
    if result_path.exists():
        result_copy = evidence.out.parent / "workspace-result.txt"
        copy_sanitized_file(result_path, result_copy)
        evidence.artifact("workspace_result", result_copy)
    final_issue_path = evidence.out.parent / "final-issue.json"
    final_issue_path.write_text(json.dumps(safe_final_issue, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("final_issue", final_issue_path)
    stage_snapshot = {
        "observed": stages,
        "stage_timeout_seconds": stage_timeout_seconds,
        "last_sample": safe_samples[-1] if safe_samples else None,
    }
    stage_snapshot_path = evidence.out.parent / "stage-snapshot.json"
    stage_snapshot_path.write_text(json.dumps(stage_snapshot, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("stage_snapshot", stage_snapshot_path)
    return {
        "issue": safe_final_issue,
        "result_path": str(result_path),
        "log_path": str(log_path),
        "samples": safe_samples,
    }


def conductor_human_actions(pipeline_payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs = pipeline_payload.get("runs")
    if isinstance(runs, list):
        actions = _managed_run_human_actions(runs)
        runtime_waits = pipeline_payload.get("runtime_waits")
        if isinstance(runtime_waits, list):
            actions.extend(_managed_run_runtime_wait_actions(runs, runtime_waits))
        return actions
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
    runs = pipeline_payload.get("runs")
    if isinstance(runs, list):
        return _managed_run_work_items(runs)
    nodes = pipeline_payload.get("nodes")
    if not isinstance(nodes, list):
        return []
    return [node for node in nodes if isinstance(node, dict) and node.get("node_id")]


def _managed_run_work_items(runs: list[Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        for item in run.get("work_items") or []:
            if not isinstance(item, dict):
                continue
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            items.append(
                {
                    "run_id": run.get("run_id"),
                    "node_id": item.get("work_item_id"),
                    "work_item_id": item.get("work_item_id"),
                    "title": payload.get("title") or item.get("work_item_id"),
                    "state": _managed_run_terminal_state(str(item.get("state") or "")),
                    "gate_status": item.get("gate_status"),
                    "issue_id": _projection_issue_id(run, str(item.get("work_item_id") or "")),
                    "issue_identifier": run.get("issue_identifier"),
                    "last_reason": run.get("latest_reason") or item.get("gate_status"),
                }
            )
    return items


def _managed_run_human_actions(runs: list[Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        for item in run.get("work_items") or []:
            if not isinstance(item, dict):
                continue
            gate_status = str(item.get("gate_status") or "")
            if str(item.get("state") or "") != "blocked" or gate_status != "human_approval_required":
                continue
            work_item_id = str(item.get("work_item_id") or "")
            wait_id = f"{run.get('run_id')}:{work_item_id}:human_approval_required"
            actions.append(
                {
                    "wait_id": wait_id,
                    "node_id": work_item_id,
                    "work_item_id": work_item_id,
                    "issue_id": _projection_issue_id(run, work_item_id),
                    "issue_identifier": run.get("issue_identifier"),
                    "state": "blocked",
                    "status": "waiting",
                    "reason": "human_approval_required",
                    "child_issue_id": _projection_issue_id(run, work_item_id),
                    "child_identifier": None,
                    "child_url": None,
                    "details": {"wait_kind": "human_approval_required", "run_id": str(run.get("run_id") or "")},
                }
            )
    return actions


def _managed_run_runtime_wait_actions(runs: list[Any], waits: list[Any]) -> list[dict[str, Any]]:
    runs_by_id = {
        str(run.get("run_id") or ""): run
        for run in runs
        if isinstance(run, dict) and run.get("run_id")
    }
    actions: list[dict[str, Any]] = []
    for wait in waits:
        if not isinstance(wait, dict) or str(wait.get("status") or "") not in {"waiting", "open"}:
            continue
        work_item_id = str(wait.get("work_item_id") or "")
        run = runs_by_id.get(str(wait.get("run_id") or ""), {})
        wait_kind = str(wait.get("wait_kind") or "") or None
        actions.append(
            {
                "wait_id": str(wait.get("wait_id") or ""),
                "node_id": work_item_id,
                "work_item_id": work_item_id,
                "issue_id": _projection_issue_id(run, work_item_id),
                "issue_identifier": str(run.get("issue_identifier") or "") or None,
                "state": "blocked",
                "status": str(wait.get("status") or ""),
                "reason": wait_kind,
                "child_issue_id": str(wait.get("child_issue_id") or "") or None,
                "child_identifier": str(wait.get("child_issue_identifier") or wait.get("child_identifier") or "") or None,
                "child_url": str(wait.get("child_url") or "") or None,
                "details": {
                    "attempt_id": str(wait.get("attempt_id") or ""),
                    "lease_id": str(wait.get("lease_id") or ""),
                    "wait_kind": wait_kind or "",
                },
            }
        )
    return actions


def _managed_run_terminal_state(state: str) -> str:
    return {
        "done": "verify_passed",
        "cancelled": "superseded",
        "blocked": "need_human",
    }.get(state, state)


def _projection_issue_id(run: dict[str, Any], work_item_id: str) -> str | None:
    for projection in run.get("linear_projections") or []:
        if isinstance(projection, dict) and str(projection.get("work_item_id") or "") == work_item_id:
            issue_id = str(projection.get("linear_issue_id") or "")
            return issue_id or None
    return None
