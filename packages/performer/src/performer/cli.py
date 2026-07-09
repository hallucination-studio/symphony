from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from performer_api.config import CodexConfig
from performer_api.managed_runs import WorkItem

from .codex_client import CodexSdkClient
from .managed_run_backend import CodexManagedRunBackend


async def run_managed_run_turn(
    turn_request_path: Path,
    turn_result_path: Path,
    *,
    codex_client: Any | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(turn_request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"could not read managed-run turn request: {turn_request_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"managed-run turn request must be a JSON object: {turn_request_path}")
    backend = CodexManagedRunBackend(codex_client or _managed_codex_backend())
    turn_kind = str(payload.get("turn_kind") or "")
    workspace_path = Path(str(payload.get("workspace_path") or "")).expanduser().resolve()
    if turn_kind == "plan":
        result = await backend.plan_turn(
            workspace_path,
            str(payload.get("issue_description") or ""),
            existing_thread_id=_optional_str(payload.get("thread_id")),
        )
        body: dict[str, object] = {
            "turn_kind": "plan",
            "thread_id": result.thread_id,
            "plan": result.plan.to_dict(),
            "events": result.events,
        }
    elif turn_kind == "work_item":
        work_item_payload = payload.get("work_item")
        if not isinstance(work_item_payload, dict):
            raise RuntimeError("work_item turn requires work_item payload")
        result = await backend.execute_turn(
            workspace_path,
            WorkItem.from_dict(work_item_payload),
            thread_id=str(payload.get("thread_id") or ""),
        )
        body = {
            "turn_kind": "work_item",
            "thread_id": result.thread_id,
            "result": result.result.to_dict(),
            "events": result.events,
        }
    else:
        raise RuntimeError(f"unsupported managed-run turn kind: {turn_kind}")
    _write_json_atomic(turn_result_path, body)
    return body


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


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


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
            run_managed_run_turn(
                Path(args.turn_request_path).resolve(),
                Path(args.turn_result_path).resolve(),
            )
        )
        os._exit(0)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"performer startup failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
