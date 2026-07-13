from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from performer_api.turns import TurnContext
from performer_api.workflow import Task

from .backend import TurnBackend
from .codex_client import CodexSdkClient
from .codex_config import CodexConfig


async def run_turn(
    turn_request_path: Path,
    turn_result_path: Path,
    *,
    codex_client: Any | None = None,
) -> dict[str, object]:
    payload = _read_json_object(turn_request_path, "turn request")
    context_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    context = TurnContext.from_dict(context_payload)
    errors = context.validation_errors()
    if errors:
        raise RuntimeError("turn_context_invalid:" + ",".join(errors))

    workspace_path = Path(str(payload.get("workspace_path") or "")).expanduser().resolve()
    backend = TurnBackend(codex_client or _managed_codex_backend())
    thread_id = str(payload.get("thread_id") or "")
    if context.turn_kind == "plan":
        result = await backend.plan(workspace_path, str(payload.get("issue_description") or ""), thread_id=thread_id)
        body = _turn_wait_body(context, result.thread_id, result.runtime_wait, result.events) if result.runtime_wait else {
            "turn_kind": "plan",
            "context": context.to_dict(),
            "thread_id": result.thread_id,
            "plan": result.plan.to_dict() if result.plan is not None else {},
            "events": result.events,
        }
    else:
        task_payload = payload.get("task")
        if not isinstance(task_payload, dict):
            raise RuntimeError(f"{context.turn_kind} turn requires task payload")
        task = Task.from_dict(task_payload)
        if task.id != context.task_id:
            raise RuntimeError("turn_context_task_id_mismatch")
        if context.turn_kind == "execute":
            result = await backend.execute(workspace_path, task, thread_id=thread_id)
            body = _turn_wait_body(context, result.thread_id, result.runtime_wait, result.events) if result.runtime_wait else {
                "turn_kind": "execute",
                "context": context.to_dict(),
                "thread_id": result.thread_id,
                "result": result.result.to_dict() if result.result is not None else {},
                "events": result.events,
            }
        else:
            evidence = payload.get("evidence") if isinstance(payload.get("evidence"), dict) else {}
            result = await backend.gate(workspace_path, task, evidence, thread_id=thread_id)
            body = _turn_wait_body(context, result.thread_id, result.runtime_wait, result.events) if result.runtime_wait else {
                "turn_kind": "gate",
                "context": context.to_dict(),
                "thread_id": result.thread_id,
                "gate_result": result.result.to_dict() if result.result is not None else {},
                "events": result.events,
            }
    _write_json_atomic(turn_result_path, body)
    return body


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read {label}: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} must be a JSON object: {path}")
    return payload


def _turn_wait_body(
    context: TurnContext,
    thread_id: str,
    wait: Any,
    events: list[dict[str, Any]],
) -> dict[str, object]:
    return {
        "turn_kind": context.turn_kind,
        "context": context.to_dict(),
        "thread_id": thread_id,
        "runtime_wait": wait.to_dict(),
        "events": events,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one Symphony managed-run turn.")
    parser.add_argument("--turn-request-path", required=True, help="Read one managed-run turn request JSON file.")
    parser.add_argument("--turn-result-path", required=True, help="Write one managed-run turn result JSON file.")
    return parser.parse_args(argv)


def _managed_codex_backend() -> CodexSdkClient:
    codex_home = os.environ.get("CODEX_HOME")
    if not codex_home or not Path(codex_home).is_dir():
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


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _env_str(key: str) -> str | None:
    value = os.environ.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_sandbox(key: str) -> str | None:
    value = _env_str(key)
    return value.replace("-", "_") if value is not None else None


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


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        asyncio.run(
            run_turn(
                Path(args.turn_request_path).resolve(),
                Path(args.turn_result_path).resolve(),
            )
        )
        os._exit(0)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        code = str(getattr(exc, "code", "") or "").strip()
        reason = str(exc)
        if code and not reason.startswith(f"{code}:"):
            reason = f"{code}:{reason}"
        print(f"performer startup failed: {reason}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
