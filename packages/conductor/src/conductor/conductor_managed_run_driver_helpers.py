from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeConfigEnvelope, TaskOutputManifest, VerificationInputSnapshot, WorkItemResult

from .conductor_managed_run_attempts import active_attempt_records, completed_attempt_records, next_attempt_number
from .conductor_models import InstanceRecord
from .conductor_managed_run_execution import ExecutionHandoff


def _attempt_paths(instance: InstanceRecord, run: dict[str, Any], kind: str, item: str) -> dict[str, Any]:
    run_id = str(run["run_id"])
    work_item_id = item if kind == "work_item" else ""
    attempt_number = next_attempt_number(run.get("payload") if isinstance(run.get("payload"), dict) else {}, kind=kind, work_item_id=work_item_id)
    attempt_id = _safe_id(f"{kind}-{run_id}-{item}-{attempt_number}")
    root = Path(instance.instance_dir) / "state" / "managed_run" / attempt_id
    return {
        "attempt_id": attempt_id,
        "attempt_number": attempt_number,
        "request_path": root / "turn-request.json",
        "result_path": root / "turn-result.json",
    }


def _attempt_payload(attempt: dict[str, Any], kind: str, *, work_item_id: str = "") -> dict[str, str]:
    mode = "execute" if kind == "work_item" else kind
    payload = {
        "attempt_id": str(attempt["attempt_id"]),
        "kind": kind,
        "mode": mode,
        "state": "running",
        "request_path": str(attempt["request_path"]),
        "result_path": str(attempt["result_path"]),
        "attempt_number": str(attempt.get("attempt_number") or ""),
        "started_at": _utc_now(),
    }
    if work_item_id:
        payload["work_item_id"] = work_item_id
        payload["node_id"] = work_item_id
    return payload


def _active_attempt(run: dict[str, Any]) -> dict[str, Any]:
    attempts = _active_attempts(run)
    return attempts[-1] if attempts else {}


def _active_attempts(run: dict[str, Any], *, kind: str | None = None) -> list[dict[str, Any]]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    return active_attempt_records(payload, kind=kind)


def _completed_attempts(run: dict[str, Any]) -> list[dict[str, Any]]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    return completed_attempt_records(payload)


def _completed_attempt_for_work_item(run: dict[str, Any], work_item_id: str) -> dict[str, Any]:
    for attempt in reversed(_completed_attempts(run)):
        if str(attempt.get("work_item_id") or "") == work_item_id:
            return attempt
    return {}


def _complete_attempt(attempt: dict[str, Any], *, state: str, events: list[dict[str, Any]] | None = None, thread_id: str = "") -> dict[str, Any]:
    completed = {**attempt, "state": state, "completed_at": _utc_now()}
    if thread_id:
        completed["thread_id"] = thread_id
    if events:
        completed["events"] = events
    return completed


def _events_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_events = payload.get("events")
    if not isinstance(raw_events, list):
        return []
    return [_sanitize_event(event) for event in raw_events if isinstance(event, dict)]


def _sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    return {str(key): _sanitize_event_value(str(key), value) for key, value in event.items()}


def _sanitize_event_value(key: str, value: Any) -> Any:
    lowered = key.lower()
    if any(marker in lowered for marker in ("authorization", "token", "secret", "password", "cookie", "api_key", "apikey")):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(child_key): _sanitize_event_value(str(child_key), child_value) for child_key, child_value in value.items()}
    if isinstance(value, list):
        return [_sanitize_event_value(key, item) for item in value]
    if isinstance(value, str):
        return _redact_secret_text(value)[:2000]
    return value


def _role_capacity(envelope: RuntimeConfigEnvelope, role: ManagedRunRuntimeRole) -> int:
    active_by_role = {ManagedRunRuntimeRole.PLAN: 0, ManagedRunRuntimeRole.WORK_ITEM: 0, ManagedRunRuntimeRole.VERIFY: 0}
    remaining = envelope.managed_run_policy.remaining_for_role(role, active_global=0, active_by_role=active_by_role)
    return max(1, int(remaining if remaining is not None else 1))


def _issue_description(run: dict[str, Any]) -> str:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    return str(payload.get("issue_description") or payload.get("issue_title") or run.get("issue_identifier") or "")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("turn_result_not_object")
    return payload


def _verification_input_snapshot(
    item: dict[str, Any],
    result: WorkItemResult,
    *,
    attempt: dict[str, Any],
    gate_snapshot_hash: str,
    handoff: ExecutionHandoff,
) -> VerificationInputSnapshot:
    return VerificationInputSnapshot(
        work_item_id=str(item["work_item_id"]),
        execute_attempt_id=str(attempt.get("attempt_id") or ""),
        base_revision=handoff.base_revision,
        branch_name=handoff.branch_name,
        commit_sha=handoff.commit_sha,
        no_change=not bool(result.changed_files or result.undeclared_files),
        artifact_hashes=handoff.artifact_hashes,
        declared_commands=list(result.tests.get("green_commands_run") or []),
        evidence_uri=str(attempt.get("result_path") or ""),
        gate_snapshot_hash=gate_snapshot_hash,
    )


def _task_output_manifest(
    item: dict[str, Any],
    result: WorkItemResult,
    *,
    attempt: dict[str, Any],
    verify_attempt_id: str,
    plan_version: int,
    handoff: ExecutionHandoff,
    score: int,
) -> TaskOutputManifest:
    return TaskOutputManifest(
        work_item_id=str(item["work_item_id"]),
        verify_attempt_id=verify_attempt_id,
        plan_version=plan_version,
        score=score,
        branch_name=handoff.branch_name,
        commit_sha=handoff.commit_sha,
        artifacts=handoff.artifact_hashes,
        created_at=_utc_now(),
    )


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:180]


def _sanitize(exc: Exception) -> str:
    return str(exc).replace("\n", " ")[:500] or exc.__class__.__name__


_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9_-]+", re.IGNORECASE),
    re.compile(r"(api[_-]?key=)[^&\s]+", re.IGNORECASE),
    re.compile(r"(access_token=)[^&\s]+", re.IGNORECASE),
    re.compile(r"(refresh_token=)[^&\s]+", re.IGNORECASE),
)


def _redact_secret_text(value: str) -> str:
    redacted = value
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>" if match.lastindex else "<redacted>", redacted)
    return redacted


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
