from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import analyze_plan_artifacts
from real_symphony_e2e_common import Evidence


E2E_STAGE_ORDER = (
    "00-archive-old-issues",
    "01-preflight",
    "02-connectivity",
    "03-services-and-runtime",
    "04-dispatch-and-plan",
    "05-plan-offline-analysis",
    "06-graph-shape",
    "07-scheduler-capacity",
    "08-execute-verify",
    "09-replan-recovery",
    "10-integration",
    "11-final-acceptance",
)
DEPENDENT_RUNTIME_STAGES_AFTER_PLAN = (
    "06-graph-shape",
    "07-scheduler-capacity",
    "08-execute-verify",
    "09-replan-recovery",
    "10-integration",
    "11-final-acceptance",
)

def _archive_managed_run_artifacts(*, evidence: Evidence, root: Path, data_root: Path, instance_id: str) -> None:
    for name, path in {
        "podium_log": root / "podium.log",
        "conductor_log": root / "conductor.log",
        "conductor_restarted_log": root / "conductor-restarted.log",
        "managed_run_db": data_root / "managed_run.db",
        "instance_state": data_root / "instances" / instance_id / "state" / "performer.json",
        "instance_ops": data_root / "instances" / instance_id / "state" / "ops.json",
        "instance_log": data_root / "instances" / instance_id / "logs" / "performer.log",
        "final_managed_runs_view": root / "final-managed-runs-view.json",
        "final_linear_tree_audit": root / "final-linear-tree-audit.json",
        "final_issue_tree": root / "final-issue-tree.json",
    }.items():
        if path.exists():
            evidence.artifact(name, path)
    attempt_root = data_root / "instances" / instance_id / "state" / "managed_run"
    if not attempt_root.exists():
        return
    for attempt_dir in sorted(path for path in attempt_root.iterdir() if path.is_dir()):
        safe_attempt = attempt_dir.name.replace("/", "_")
        for filename, suffix in [
            ("turn-request.json", "request"),
            ("turn-result.json", "result"),
            ("attempt.log", "log"),
        ]:
            path = attempt_dir / filename
            if path.exists():
                evidence.artifact(f"attempt_{safe_attempt}_{suffix}", path)


def _handle_managed_run_runtime_blocker(
    *,
    evidence: Evidence,
    root: Path,
    data_root: Path,
    instance_id: str,
    run_result: dict[str, Any],
) -> bool:
    failure = _latest_managed_run_runtime_failure(evidence)
    if failure is None:
        return False
    _archive_managed_run_artifacts(evidence=evidence, root=root, data_root=data_root, instance_id=instance_id)
    if "checkpoint:04-dispatch-and-plan" not in evidence.data.get("artifacts", {}):
        evidence.checkpoint(
            "04-dispatch-and-plan",
            {
                "status": "failed",
                "failure": failure,
                "samples": (run_result.get("samples") or [])[-3:],
                "failures": [failure],
            },
        )
    plan_paths = _failed_plan_attempt_paths(data_root=data_root, instance_id=instance_id, failure=failure)
    analysis_report = analyze_plan_artifacts(
        attempt_request=plan_paths.get("request"),
        attempt_result=plan_paths.get("result"),
        dispatch_context=_dispatch_context_for_plan_attempt(data_root=data_root, plan_paths=plan_paths),
    )
    analysis_path = root / "plan-offline-analysis.json"
    analysis_path.write_text(json.dumps(analysis_report, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("plan_offline_analysis", analysis_path)
    evidence.checkpoint(
        "05-plan-offline-analysis",
        {
            "status": "completed" if analysis_report.get("status") == "analyzed" else "limited",
            "analysis": analysis_report,
        },
    )
    root_causes = [
        item
        for item in analysis_report.get("actionable_root_causes", [])
        if isinstance(item, dict) and item.get("code")
    ]
    if root_causes:
        existing_codes = {
            str(item.get("code") or "")
            for item in evidence.data.setdefault("actionable_root_causes", [])
            if isinstance(item, dict)
        }
        for item in root_causes:
            if str(item.get("code") or "") not in existing_codes:
                evidence.data["actionable_root_causes"].append(item)
                existing_codes.add(str(item.get("code") or ""))
    for stage in DEPENDENT_RUNTIME_STAGES_AFTER_PLAN:
        evidence.blocked(
            stage,
            blocked_by="04-dispatch-and-plan",
            reason=str(failure.get("reason") or "managed_run_runtime_error"),
            upstream_check=str(failure.get("name") or "managed-run-runtime-error:visible"),
        )
    evidence.write()
    return True


def _checkpoint_and_block_after_stage(
    evidence: Evidence,
    stage: str,
    *,
    reason: str,
    blocked_stages: tuple[str, ...] | list[str],
) -> None:
    latest_failures = [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)]
    evidence.checkpoint(
        stage,
        {
            "status": "failed",
            "reason": reason,
            "failures": latest_failures[-3:],
        },
    )
    for blocked_stage in blocked_stages:
        evidence.blocked(blocked_stage, blocked_by=stage, reason=reason)


def _stages_after(stage: str) -> tuple[str, ...]:
    try:
        index = E2E_STAGE_ORDER.index(stage)
    except ValueError:
        return ()
    return E2E_STAGE_ORDER[index + 1 :]


def _latest_managed_run_runtime_failure(evidence: Evidence) -> dict[str, Any] | None:
    failures = [failure for failure in evidence.data.get("failures", []) if isinstance(failure, dict)]
    for failure in reversed(failures):
        if failure.get("name") == "managed-run-runtime-error:visible":
            if "reason" not in failure:
                failure = dict(failure)
                failure["reason"] = _managed_run_runtime_failure_reason(failure)
            return failure
    return None


def _managed_run_runtime_failure_reason(failure: dict[str, Any]) -> str:
    payload = failure.get("failure")
    if isinstance(payload, dict):
        kind = str(payload.get("kind") or "")
        attempts = [attempt for attempt in payload.get("attempts", []) if isinstance(attempt, dict)]
        for attempt in attempts:
            error = str(attempt.get("error") or "")
            if error:
                return error
        if kind:
            return kind
    return str(failure.get("error") or failure.get("status") or "managed_run_runtime_error")


def _failed_plan_attempt_paths(
    *,
    data_root: Path,
    instance_id: str,
    failure: dict[str, Any],
) -> dict[str, Path | None]:
    attempt_id = _failed_plan_attempt_id(failure)
    attempt_root = data_root / "instances" / instance_id / "state" / "managed_run"
    candidate_dirs: list[Path] = []
    if attempt_id:
        candidate_dirs.append(attempt_root / attempt_id)
    if attempt_root.exists():
        candidate_dirs.extend(sorted(path for path in attempt_root.iterdir() if path.is_dir()))
    seen: set[Path] = set()
    for attempt_dir in candidate_dirs:
        if attempt_dir in seen:
            continue
        seen.add(attempt_dir)
        request_path = attempt_dir / "turn-request.json"
        result_path = attempt_dir / "turn-result.json"
        if not result_path.exists():
            result_path = attempt_dir / "turn-result.json.applied"
        request = _read_json_file(request_path)
        if request and str(request.get("attempt_id") or attempt_dir.name) != attempt_dir.name and attempt_id:
            continue
        if request and _looks_like_plan_request(request):
            return {
                "request": request_path if request_path.exists() else None,
                "result": result_path if result_path.exists() else None,
            }
    return {"request": None, "result": None}


def _failed_plan_attempt_id(failure: dict[str, Any]) -> str:
    payload = failure.get("failure")
    attempts = payload.get("attempts") if isinstance(payload, dict) else []
    for attempt in attempts if isinstance(attempts, list) else []:
        if not isinstance(attempt, dict):
            continue
        if str(attempt.get("mode") or "") == "plan" or str(attempt.get("attempt_id") or "").startswith("plan"):
            return str(attempt.get("attempt_id") or "")
    return ""


def _looks_like_plan_request(payload: dict[str, Any]) -> bool:
    return bool(payload.get("managed_run_intent") is not None or payload.get("root_node_id") or payload.get("issue_description"))


def _dispatch_context_for_plan_attempt(*, data_root: Path, plan_paths: dict[str, Path | None]) -> dict[str, Any]:
    request = _read_json_file(plan_paths.get("request"))
    node_id = str(request.get("node_id") or request.get("root_node_id") or "")
    if not node_id:
        return {}
    db_paths = (data_root / "pipeline" / "pipeline.db", data_root / "pipeline.db")
    row = None
    for db_path in db_paths:
        if not db_path.exists():
            continue
        try:
            with sqlite3.connect(db_path) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM dispatch_context WHERE node_id = ?",
                    (node_id,),
                ).fetchone()
        except sqlite3.Error:
            row = None
        if row is not None:
            break
    if row is None:
        return {}
    try:
        payload = json.loads(str(row[0]))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _read_json_file(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}
