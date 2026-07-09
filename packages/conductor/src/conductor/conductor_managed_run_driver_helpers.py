from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any

from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeConfigEnvelope, TaskOutputManifest, VerificationInputSnapshot, WorkItemResult

from .conductor_models import InstanceRecord


def _attempt_paths(instance: InstanceRecord, run_id: str, kind: str, item: str) -> dict[str, Any]:
    attempt_id = _safe_id(f"{kind}-{run_id}-{item}")
    root = Path(instance.instance_dir) / "state" / "managed_run" / attempt_id
    return {
        "attempt_id": attempt_id,
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
        "started_at": _utc_now(),
    }
    if work_item_id:
        payload["work_item_id"] = work_item_id
        payload["node_id"] = work_item_id
    return payload


def _active_attempt(run: dict[str, Any]) -> dict[str, Any]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    attempt = payload.get("active_attempt") if isinstance(payload.get("active_attempt"), dict) else {}
    return attempt


def _active_attempts(run: dict[str, Any], *, kind: str | None = None) -> list[dict[str, Any]]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    raw_attempts = payload.get("active_attempts")
    attempts = [dict(attempt) for attempt in raw_attempts if isinstance(attempt, dict)] if isinstance(raw_attempts, list) else []
    if not attempts:
        attempt = _active_attempt(run)
        if attempt:
            attempts = [attempt]
    if kind is not None:
        attempts = [attempt for attempt in attempts if str(attempt.get("kind") or "") == kind]
    return attempts


def _completed_attempts(run: dict[str, Any]) -> list[dict[str, Any]]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    raw_attempts = payload.get("completed_attempts")
    return [dict(attempt) for attempt in raw_attempts if isinstance(attempt, dict)] if isinstance(raw_attempts, list) else []


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
    instance: InstanceRecord,
    *,
    attempt: dict[str, Any],
    gate_snapshot_hash: str,
) -> VerificationInputSnapshot:
    workspace = Path(instance.resolved_repo_path)
    return VerificationInputSnapshot(
        work_item_id=str(item["work_item_id"]),
        execute_attempt_id=str(attempt.get("attempt_id") or ""),
        base_revision=str(attempt.get("base_revision") or _git_text(workspace, "rev-parse", "HEAD") or "workspace"),
        branch_name=_git_text(workspace, "branch", "--show-current") or "workspace",
        commit_sha=_git_text(workspace, "rev-parse", "HEAD") or "workspace",
        no_change=not bool(result.changed_files or result.undeclared_files),
        artifact_hashes=_artifact_hashes(result, workspace),
        declared_commands=list(result.tests.get("green_commands_run") or []),
        evidence_uri=str(attempt.get("result_path") or ""),
        gate_snapshot_hash=gate_snapshot_hash,
    )


def _task_output_manifest(
    item: dict[str, Any],
    result: WorkItemResult,
    instance: InstanceRecord,
    *,
    attempt: dict[str, Any],
    plan_version: int,
) -> TaskOutputManifest:
    workspace = Path(instance.resolved_repo_path)
    attempt_id = str(attempt.get("attempt_id") or "")
    return TaskOutputManifest(
        work_item_id=str(item["work_item_id"]),
        verify_attempt_id=f"verify-{attempt_id}" if attempt_id else f"verify-{item['work_item_id']}",
        plan_version=plan_version,
        score=3,
        branch_name=_git_text(workspace, "branch", "--show-current") or "workspace",
        commit_sha=_git_text(workspace, "rev-parse", "HEAD") or "workspace",
        artifacts=_artifact_hashes(result, workspace),
        created_at=_utc_now(),
    )


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in value)[:180]


def _artifact_hashes(result: WorkItemResult, workspace: Path) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for changed in result.changed_files:
        path = workspace / changed.path
        item: dict[str, Any] = {"uri": changed.path, "path": changed.path}
        if path.is_file():
            item["sha256"] = _sha256(path)
        artifacts.append(item)
    return artifacts


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_text(workspace: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _sanitize(exc: Exception) -> str:
    return str(exc).replace("\n", " ")[:500] or exc.__class__.__name__


def _run_verification_command(command: str, *, workspace_path: Path, timeout_seconds: int = 300) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=workspace_path,
            shell=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return f"verification_command_timeout:{_safe_command(command)}:{_output_tail(exc.stdout or '', exc.stderr or '')}"
    if completed.returncode != 0:
        return f"verification_command_failed:{_safe_command(command)}:exit_{completed.returncode}:{_output_tail(completed.stdout, completed.stderr)}"
    return ""


def _safe_command(command: str) -> str:
    return _redact_secret_text(str(command or "").replace("\n", " ").replace("\r", " ").strip())[:200]


def _output_tail(stdout: Any, stderr: Any) -> str:
    text = f"{stdout or ''}\n{stderr or ''}".replace("\n", " ").replace("\r", " ").strip()
    return _redact_secret_text(text or "no output")[-200:]


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
