from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from performer_api.config import CodexConfig
from performer_api.pipeline import RuntimeMode

from .codex_client import CodexSdkClient


def _managed_codex_backend() -> CodexSdkClient:
    codex_home = os.environ.get("CODEX_HOME")
    if not codex_home:
        raise RuntimeError("managed_codex_home_required")
    if not Path(codex_home).is_dir():
        raise RuntimeError("managed_codex_home_required")
    return CodexSdkClient(
        CodexConfig(
            model=_env_str("CODEX_MODEL"),
            sdk_codex_bin=_env_str("CODEX_SDK_CODEX_BIN"),
            sandbox=_env_sandbox("CODEX_SANDBOX"),
            config_overrides=_env_config_overrides("CODEX_CONFIG_OVERRIDES"),
            hard_turn_timeout_ms=_env_int("CODEX_HARD_TURN_TIMEOUT_MS", 3_600_000),
            read_timeout_ms=_env_int("CODEX_READ_TIMEOUT_MS", 5_000),
            init_max_attempts=_env_int("CODEX_INIT_MAX_ATTEMPTS", 4),
            init_backoff_ms=_env_int("CODEX_INIT_BACKOFF_MS", 500),
            init_backoff_max_ms=_env_int("CODEX_INIT_BACKOFF_MAX_MS", 8_000),
            overload_max_attempts=_env_int("CODEX_OVERLOAD_MAX_ATTEMPTS", 5),
            overload_initial_delay_ms=_env_int("CODEX_OVERLOAD_INITIAL_DELAY_MS", 250),
            overload_max_delay_ms=_env_int("CODEX_OVERLOAD_MAX_DELAY_MS", 8_000),
        )
    )


async def _emit_runtime_wait_probe_if_requested(on_event: Any) -> None:
    if not _env_bool("SYMPHONY_EMIT_RUNTIME_WAIT_PROBE") and not _env_bool("CODEX_EMIT_RUNTIME_WAIT_PROBE"):
        return
    if not callable(on_event):
        return
    on_event(
        {
            "event": "sdk_approval_requested",
            "message": "waiting for command approval from runtime wait probe",
            "command": "symphony-runtime-wait-probe",
        }
    )
    delay_seconds = _env_float("SYMPHONY_RUNTIME_WAIT_PROBE_SECONDS", _env_float("CODEX_RUNTIME_WAIT_PROBE_SECONDS", 0.0))
    if delay_seconds > 0:
        await asyncio.sleep(delay_seconds)


def _attempt_event_printer(mode: RuntimeMode, *, attempt_id: str, node_id: str):
    def emit(event: dict[str, Any]) -> None:
        event_name = str(event.get("event") or event.get("type") or "codex_event")
        payload = {
            "event": "performer_attempt_event",
            "mode": mode.value,
            "attempt_id": attempt_id,
            "node_id": node_id,
            "codex_event": event_name,
        }
        for key in ("thread_id", "turn_id", "session_id", "message", "command", "exit_code", "http_status", "timeout_ms"):
            if key in event and event[key] is not None:
                payload[key] = _sanitize_error(str(event[key]))
        print(json.dumps(payload, sort_keys=True), flush=True)

    return emit


def _env_str(key: str) -> str | None:
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_bool(key: str) -> bool:
    return str(os.environ.get(key) or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_float(key: str, default: float) -> float:
    value = os.environ.get(key)
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if parsed >= 0 else default


def _env_sandbox(key: str) -> str | None:
    value = _env_str(key)
    if value is None:
        return None
    return value.replace("-", "_")


def _env_int(key: str, default: int) -> int:
    value = os.environ.get(key)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _env_config_overrides(key: str) -> tuple[str, ...]:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return ()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return tuple(item for item in raw.split(os.pathsep) if item)
    if not isinstance(parsed, list):
        return ()
    return tuple(str(item) for item in parsed if str(item).strip())


def _thread_state_workspace_path(payload: dict[str, object], *, fallback: Path) -> Path:
    thread_state_workspace = _optional_payload_str(payload.get("thread_state_workspace_path"))
    if thread_state_workspace:
        return Path(thread_state_workspace)
    return fallback


def _payload_kind(payload: dict[str, object], *, default: str) -> str:
    return _optional_payload_str(payload.get("kind")) or default


def _fencing_fields(payload: dict[str, object]) -> dict[str, object]:
    return {
        "graph_revision": int(payload.get("graph_revision") or 0),
        "policy_revision": int(payload.get("policy_revision") or 0),
        "lease_id": str(payload.get("lease_id") or ""),
        "fencing_token": str(payload.get("fencing_token") or ""),
    }


def _git(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True)


def _run(args: list[str], *, cwd: Path) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def _file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _optional_payload_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]
