from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from real_symphony_e2e_artifacts import _archive_managed_run_artifacts
from real_symphony_e2e_common import api_url, http_json, redact_evidence_value
from real_symphony_e2e_linear import fetch_linear_issue_tree
from real_symphony_e2e_podium_evidence import archive_podium_api_snapshots


async def archive_early_exit_artifacts(state: Any) -> None:
    _archive_managed_run_artifacts(
        evidence=state.evidence,
        root=state.root,
        data_root=state.data_root,
        instance_id=state.instance_id,
    )
    state.evidence.artifact("managed_run_e2e_report", state.evidence.out)
    await _archive_podium_snapshots(state)
    _archive_conductor_snapshots(state)
    await _archive_linear_tree(state)


async def _archive_podium_snapshots(state: Any) -> None:
    session = getattr(state, "podium_session", None)
    podium_running = any(
        process.name == "podium" and process.process.poll() is None
        for process in getattr(state, "processes", [])
    )
    if session is None or not podium_running:
        return
    try:
        await archive_podium_api_snapshots(
            session,
            root=Path(state.root),
            evidence=state.evidence,
            prefix="early-exit",
            tolerate_endpoint_errors=True,
        )
    except Exception as exc:
        state.evidence.check(
            "real-e2e:early-exit-podium-snapshots",
            False,
            error_type=type(exc).__name__,
            error_code=str(getattr(exc, "error_code", "podium_snapshot_archive_failed")),
            sanitized_reason=_sanitize_exception(exc),
            action_required="inspect_podium_log",
            retryable=True,
            next_action="retry_podium_snapshots",
        )


def record_unhandled_e2e_exception(evidence: Any, exc: Exception) -> None:
    record_e2e_exception(
        evidence,
        name="real-e2e:unhandled-exception",
        failure_class=str(getattr(exc, "failure_class", "product_failure")),
        error_code=str(getattr(exc, "error_code", "e2e_unhandled_exception")),
        next_action=str(getattr(exc, "next_action", "inspect_e2e_evidence")),
        retryable=bool(getattr(exc, "retryable", False)),
        exc=exc,
    )


def record_e2e_exception(
    evidence: Any,
    *,
    name: str,
    error_code: str,
    next_action: str,
    retryable: bool,
    exc: Exception,
    failure_class: str = "product_failure",
) -> None:
    evidence.check(
        name,
        False,
        failure_class=failure_class,
        error_type=type(exc).__name__,
        error_code=error_code,
        sanitized_reason=_sanitize_exception(exc),
        action_required="inspect_e2e_evidence",
        retryable=retryable,
        next_action=next_action,
    )


def _archive_conductor_snapshots(state: Any) -> None:
    port = int(getattr(state, "conductor_port", 0) or 0)
    if port <= 0:
        return
    _write_api_snapshot(state, "early_managed_runs_view", "early-managed-runs-view.json", "/api/managed-runs")
    instance_id = str(getattr(state, "instance_id", "") or "")
    if instance_id:
        _write_api_snapshot(state, "early_instance_runtime", "early-instance-runtime.json", f"/api/instances/{instance_id}/runtime")


def _write_api_snapshot(state: Any, artifact: str, filename: str, endpoint: str) -> None:
    status, body = http_json("GET", api_url(state.conductor_port, endpoint), timeout=2)
    path = Path(state.root) / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = redact_evidence_value({"status": status, "body": body})
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact(artifact, path)


async def _archive_linear_tree(state: Any) -> None:
    linear = getattr(state, "linear", {})
    issue = linear.get("issue") if isinstance(linear, dict) else {}
    issue_id = str(issue.get("id") or "") if isinstance(issue, dict) else ""
    if not issue_id:
        return
    try:
        tree = await fetch_linear_issue_tree(state.token, issue_id)
    except Exception as exc:
        state.evidence.check(
            "real-e2e:early-exit-linear-tree",
            False,
            error_type=type(exc).__name__,
            error_code="linear_tree_archive_failed",
            sanitized_reason=_sanitize_exception(exc),
            action_required="inspect_e2e_evidence",
            retryable=True,
            next_action="retry_linear_tree_snapshot",
        )
        return
    path = Path(state.root) / "early-linear-tree.json"
    path.write_text(json.dumps(redact_evidence_value(tree), indent=2, sort_keys=True), encoding="utf-8")
    state.evidence.artifact("early_linear_tree", path)


def _sanitize_exception(exc: Exception) -> str:
    text = str(exc).replace("\r", " ").replace("\n", " ")
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return f"{type(exc).__name__}:{text[:300]}"


_SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)\b(token|password|secret|api[_-]?key)=([^\s,;]+)"), r"\1=[REDACTED]"),
)


__all__ = ["archive_early_exit_artifacts", "record_e2e_exception", "record_unhandled_e2e_exception"]
