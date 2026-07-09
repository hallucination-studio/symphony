from __future__ import annotations

from pathlib import Path
from typing import Any

from real_symphony_e2e_analysis import pipeline_integrations_terminal

def immediate_pipeline_failure(
    sample: dict[str, Any],
    *,
    expected_failure: str = "none",
    permission_approval_probe: bool = False,
) -> dict[str, Any] | None:
    if expected_failure != "none":
        return None
    attempts = [attempt for attempt in sample.get("pipeline_attempts", []) if isinstance(attempt, dict)]
    failed_attempts = [
        attempt
        for attempt in attempts
        if str(attempt.get("state") or "").lower() in {"failed", "timed_out", "cancelled"}
    ]
    if failed_attempts:
        return {"kind": "attempt_failed", "attempts": failed_attempts}
    nodes = [node for node in sample.get("pipeline_nodes", []) if isinstance(node, dict)]
    failed_nodes = [node for node in nodes if str(node.get("state") or "").lower() == "failed"]
    if failed_nodes:
        return {"kind": "node_failed", "nodes": failed_nodes}
    waits = [action for action in sample.get("pipeline_human_actions", []) if isinstance(action, dict)]
    backend_waits = [
        action
        for action in waits
        if str(action.get("reason") or "") in {"BACKEND_UNAVAILABLE", "VERIFIER_CREDENTIAL_UNAVAILABLE"}
    ]
    if backend_waits:
        return {"kind": "backend_human_wait", "actions": backend_waits}
    runtime_waits = [
        action
        for action in waits
        if isinstance(action.get("details"), dict) and str(action["details"].get("wait_kind") or "")
    ]
    if runtime_waits and permission_approval_probe:
        return None
    if runtime_waits:
        return {"kind": "runtime_human_wait", "actions": runtime_waits}
    return None

def _pipeline_integrated(pipeline_payload: dict[str, Any]) -> bool:
    return pipeline_integrations_terminal(pipeline_payload)


def _human_answered_push_satisfies_resume_probe(status: int, body: Any) -> bool:
    if status != 200 or not isinstance(body, dict):
        return False
    if body.get("status") == "accepted":
        return True
    return body.get("status") == "ignored" and body.get("reason") == "completed_child_required"


def _wait_resolved_before_harness_resume(wait: dict[str, Any]) -> bool:
    if wait.get("status") != "resolved":
        return False
    resolution = str(wait.get("resolution") or "").strip().lower()
    return resolution in {"attempt succeeded", "attempt cancelled", "attempt failed", "attempt timed_out"}


def _immediate_failure_matches_attempt(failure: dict[str, Any], attempt_id: str | None) -> bool:
    expected_attempt_id = str(attempt_id or "").strip()
    if not expected_attempt_id:
        return False
    attempts = failure.get("attempts")
    if isinstance(attempts, list):
        attempt_ids = [
            str(attempt.get("attempt_id") or "")
            for attempt in attempts
            if isinstance(attempt, dict) and str(attempt.get("attempt_id") or "")
        ]
        return bool(attempt_ids) and all(attempt_id == expected_attempt_id for attempt_id in attempt_ids)
    actions = failure.get("actions")
    if not isinstance(actions, list):
        return False
    matched = False
    for action in actions:
        if not isinstance(action, dict):
            return False
        details = action.get("details")
        if not isinstance(details, dict) or str(details.get("attempt_id") or "") != expected_attempt_id:
            return False
        matched = True
    return matched


def _immediate_failure_without_attempt(failure: dict[str, Any], attempt_id: str | None) -> dict[str, Any] | None:
    expected_attempt_id = str(attempt_id or "").strip()
    if not expected_attempt_id:
        return failure
    attempts = failure.get("attempts")
    if not isinstance(attempts, list):
        return None if _immediate_failure_matches_attempt(failure, expected_attempt_id) else failure
    remaining_attempts = [
        attempt
        for attempt in attempts
        if not (isinstance(attempt, dict) and str(attempt.get("attempt_id") or "") == expected_attempt_id)
    ]
    if len(remaining_attempts) == len(attempts):
        return failure
    if not remaining_attempts:
        return None
    filtered = dict(failure)
    filtered["attempts"] = remaining_attempts
    return filtered


def _resolved_pipeline_wait_ids(pipeline_payload: dict[str, Any]) -> set[str]:
    wait_ids: set[str] = set()
    for key in ("human_waits", "runtime_waits"):
        waits = pipeline_payload.get(key)
        if not isinstance(waits, list):
            continue
        for wait in waits:
            if not isinstance(wait, dict) or wait.get("status") != "resolved":
                continue
            wait_id = str(wait.get("wait_id") or "")
            if wait_id:
                wait_ids.add(wait_id)
    return wait_ids


def _pipeline_wait_by_id(pipeline_payload: dict[str, Any], wait_id: str) -> dict[str, Any]:
    for key in ("human_waits", "runtime_waits"):
        waits = pipeline_payload.get(key)
        if not isinstance(waits, list):
            continue
        for wait in waits:
            if isinstance(wait, dict) and wait.get("wait_id") == wait_id:
                return wait
    return {}


def _pipeline_integrated_result_path(pipeline_payload: dict[str, Any]) -> Path | None:
    integrations = [item for item in pipeline_payload.get("integration_queue", []) if isinstance(item, dict)]
    integrated_verify_attempt_ids = {
        str(item.get("verify_attempt_id") or "") for item in integrations if item.get("status") == "integrated"
    }
    if not integrated_verify_attempt_ids:
        return None
    for manifest in pipeline_payload.get("manifests", []):
        if not isinstance(manifest, dict):
            continue
        if str(manifest.get("verify_attempt_id") or "") not in integrated_verify_attempt_ids:
            continue
        code = manifest.get("code")
        if not isinstance(code, dict):
            continue
        repository_path = str(code.get("repository_path") or "").strip()
        if repository_path:
            return Path(repository_path) / "SYMPHONY_REAL_E2E_RESULT.md"
    return None
