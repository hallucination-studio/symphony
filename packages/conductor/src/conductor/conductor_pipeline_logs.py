from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from performer_api.pipeline import (
    AttemptRecord,
    AttemptState,
    ExecuteAttemptResult,
    ExecuteAttemptRequest,
    PASS_THRESHOLD,
    GateSpecContent,
    GateSpecSnapshot,
    GateStep,
    GateStepSource,
    GraphNode,
    GraphNodeState,
    HumanEscalationReason,
    PlanAttemptRequest,
    PlanAttemptResult,
    PipelineModeView,
    PipelineView,
    IntentSpec,
    PlanProposal,
    PlanRepair,
    PlanValidator,
    PlanValidatorError,
    PredictedCall,
    RUNTIME_BACKENDS_BY_MODE,
    RuntimeConfigEnvelope,
    RuntimeMode,
    RuntimeProfile,
    SchedulerCapacity,
    SchedulerPolicy,
    TaskOutputManifest,
    VerificationInputSnapshot,
    VerifyAttemptResult,
    VerifyAttemptRequest,
    WorkerLease,
)

from .runtime_backends import prepare_backend_environment



from .conductor_pipeline_helpers import _json_dumps, _now, _parse_time, _sanitize_error, _utc

_PROCESS_EXIT_RESULT_GRACE_SECONDS = 15.0
def _runtime_log_candidates(instance: Any) -> list[Path]:
    candidates: list[Path] = []
    current = Path(str(getattr(instance, "instance_dir", ""))) / "logs" / "current.log"
    try:
        if current.is_file():
            target = current.read_text(encoding="utf-8").strip()
            if target:
                candidates.append(Path(target))
    except OSError:
        pass
    log_path = getattr(instance, "log_path", None)
    if log_path:
        candidates.append(Path(str(log_path)))
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _attempt_event_from_performer_stream_line(line: str) -> dict[str, Any] | None:
    marker = " message="
    if "event=performer_stream " not in line or marker not in line:
        return None
    raw = line.split(marker, 1)[1].strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get("event") != "performer_attempt_event":
        return None
    return payload


def _runtime_wait_from_attempt_event(event: dict[str, Any]) -> dict[str, Any] | None:
    codex_event = str(event.get("codex_event") or event.get("type") or "")
    message = str(event.get("message") or "")
    command = str(event.get("command") or "")
    wait_kind = _classify_runtime_wait_kind(codex_event, message, command)
    if wait_kind is None:
        return None
    return {
        "attempt_id": str(event.get("attempt_id") or ""),
        "node_id": str(event.get("node_id") or ""),
        "mode": str(event.get("mode") or ""),
        "wait_kind": wait_kind,
        "message": _sanitize_error(message) if message else None,
        "command": _sanitize_error(command) if command else None,
        "thread_id": _optional_event_str(event.get("thread_id")),
        "turn_id": _optional_event_str(event.get("turn_id")),
        "session_id": _optional_event_str(event.get("session_id")),
    }


def _classify_runtime_wait_kind(codex_event: str, message: str, command: str) -> str | None:
    text = " ".join([codex_event, message, command]).lower()
    if "approval" in text or "permission" in text:
        return "approval_requested"
    if "tool_input" in text or "tool input" in text:
        return "tool_input_requested"
    if "input_requested" in text or "input requested" in text:
        return "input_requested"
    if "waiting" in text and "input" in text:
        return "input_requested"
    return None


def _normalize_runtime_wait_kind(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    return normalized or "runtime_wait"


def _optional_event_str(value: Any) -> str | None:
    if value is None:
        return None
    text = _sanitize_error(str(value))
    return text or None
def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(_json_dumps(payload), encoding="utf-8")
    tmp.replace(path)


def _append_instance_log(instance: Any, message: str) -> None:
    log_path = getattr(instance, "log_path", None)
    if not log_path:
        return
    path = Path(str(log_path))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{_now()} {message}\n")
    except OSError:
        return


def _append_pipeline_log_event(instance: Any | None, event: str, **fields: Any) -> None:
    if instance is None:
        return
    parts = [f"event={event}"]
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(f"{key}={_sanitize_log_field(value)}")
    _append_instance_log(instance, " ".join(parts))


def _sanitize_log_field(value: Any) -> str:
    text = str(value).replace("\x00", "")
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text.replace(" ", "_")


def _process_exit_error(instance: Any) -> str:
    exit_code = getattr(instance, "last_exit_code", None)
    parts = [f"performer process exited before publishing attempt result exit_code={exit_code}"]
    tail = _instance_log_error_tail(instance)
    if tail:
        parts.append(f"log_tail={tail}")
    return _sanitize_error(" ".join(parts))


def _attempt_snapshot_exit_error(snapshot: dict[str, object], instance: Any) -> str:
    exit_code = snapshot.get("exit_code")
    if exit_code is None:
        parts = ["process exited before publishing attempt result"]
    else:
        parts = [f"process exited with code {exit_code} before publishing attempt result"]
    tail = _instance_log_error_tail(instance)
    if tail:
        parts.append(f"log_tail={tail}")
    return _sanitize_error(" ".join(parts))


def _instance_log_error_tail(instance: Any) -> str:
    paths: list[Path] = []
    current = Path(str(getattr(instance, "instance_dir", ""))) / "logs" / "current.log"
    try:
        if current.is_file():
            current_target = current.read_text(encoding="utf-8").strip()
            if current_target:
                paths.append(Path(current_target))
    except OSError:
        pass
    log_path = getattr(instance, "log_path", None)
    if log_path:
        paths.append(Path(str(log_path)))
    if not paths:
        return ""
    path = next((candidate for candidate in paths if candidate.exists() and candidate.stat().st_size > 0), paths[0])
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    lines = [line.strip().replace("\x00", "") for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    return " | ".join(lines[-3:])[-300:]


def _visible_attempt_error(result: PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult) -> str:
    raw = str(result.error or "").strip()
    if raw:
        return raw
    return "attempt_failed_without_reason"


def _attempt_result_from_payload(payload: dict[str, Any]) -> PlanAttemptResult | ExecuteAttemptResult | VerifyAttemptResult | None:
    try:
        mode = RuntimeMode(str(payload.get("mode") or ""))
    except ValueError:
        return None
    if mode is RuntimeMode.PLAN:
        return PlanAttemptResult.from_dict(payload)
    if mode is RuntimeMode.EXECUTE:
        return ExecuteAttemptResult.from_dict(payload)
    if mode is RuntimeMode.VERIFY:
        return VerifyAttemptResult.from_dict(payload)
    return None
def _recently_observed_process_exit(instance: Any, *, at: datetime) -> bool:
    observed_at = _parse_time(getattr(instance, "updated_at", None))
    if observed_at is None:
        return False
    return (_utc(at) - observed_at).total_seconds() < _PROCESS_EXIT_RESULT_GRACE_SECONDS
