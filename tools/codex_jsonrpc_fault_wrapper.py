#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class FaultState:
    mode: str
    target_method: str
    fail_count: int
    http_status: int
    message: str
    log_path: Path | None = None
    injected: int = 0


def build_real_command(*, codex_bin: str, passthrough_args: list[str]) -> list[str]:
    return [codex_bin, *passthrough_args]


def sanitized_config_overrides(command: list[str]) -> list[str]:
    overrides: list[str] = []
    index = 0
    while index < len(command):
        if command[index] == "--config" and index + 1 < len(command):
            overrides.append(_sanitize_config_override(command[index + 1]))
            index += 2
            continue
        index += 1
    return overrides


def maybe_fault_response(message: dict[str, Any], state: FaultState) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None or method != state.target_method:
        return None
    if state.injected >= state.fail_count:
        return None

    state.injected += 1
    if state.mode == "overload":
        response = {
            "id": request_id,
            "error": {
                "code": -32000,
                "message": state.message,
                "data": {
                    "codex_error_info": "server_overloaded",
                    "httpStatusCode": state.http_status,
                },
            },
        }
    elif state.mode == "invalid_params":
        response = {
            "id": request_id,
            "error": {
                "code": -32602,
                "message": state.message,
                "data": {"httpStatusCode": state.http_status},
            },
        }
    else:
        raise ValueError(f"Unsupported fault mode: {state.mode}")

    _append_log(
        state.log_path,
        {
            "event": "fault_injected",
            "mode": state.mode,
            "target_method": state.target_method,
            "request_id": str(request_id),
            "injected": state.injected,
            "fail_count": state.fail_count,
            "http_status": state.http_status,
            "codex_error_info": "server_overloaded" if state.mode == "overload" else None,
        },
    )
    return response


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(
        description="Proxy codex app-server stdio and inject JSON-RPC faults for real resilience acceptance."
    )
    arg_parser.add_argument("--real-codex-bin", default=os.environ.get("CODEX_FAULT_REAL_BIN") or "codex")
    arg_parser.add_argument("--mode", choices=["overload", "invalid_params"], default=os.environ.get("CODEX_FAULT_MODE") or "overload")
    arg_parser.add_argument("--target-method", default=os.environ.get("CODEX_FAULT_TARGET_METHOD") or "turn/start")
    arg_parser.add_argument("--fail-count", type=int, default=int(os.environ.get("CODEX_FAULT_FAIL_COUNT") or "1"))
    arg_parser.add_argument("--http-status", type=int, default=int(os.environ.get("CODEX_FAULT_HTTP_STATUS") or "502"))
    arg_parser.add_argument(
        "--message",
        default=os.environ.get("CODEX_FAULT_MESSAGE") or "upstream 502: server overloaded by Track D induced fault",
    )
    arg_parser.add_argument("--log-path", type=Path, default=Path(os.environ["CODEX_FAULT_LOG"]) if os.environ.get("CODEX_FAULT_LOG") else None)
    return arg_parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    arg_parser = parser()
    args, codex_args = arg_parser.parse_known_args(argv)
    if codex_args and codex_args[0] == "--":
        codex_args = codex_args[1:]
    args.codex_args = codex_args
    return args


def run(args: argparse.Namespace) -> int:
    passthrough_args = list(args.codex_args)
    command = build_real_command(codex_bin=args.real_codex_bin, passthrough_args=passthrough_args)
    state = FaultState(
        mode=args.mode,
        target_method=args.target_method,
        fail_count=max(0, args.fail_count),
        http_status=args.http_status,
        message=args.message,
        log_path=args.log_path,
    )
    _append_log(
        state.log_path,
        {
            "event": "wrapper_started",
            "mode": state.mode,
            "target_method": state.target_method,
            "fail_count": state.fail_count,
            "http_status": state.http_status,
            "real_codex_bin": command[0],
            "passthrough_arg_count": len(passthrough_args),
            "config_overrides": sanitized_config_overrides(command),
        },
    )
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    stderr_thread = threading.Thread(target=_copy_stream, args=(proc.stderr, sys.stderr), daemon=True)
    stderr_thread.start()
    stdout_thread = threading.Thread(target=_copy_stream, args=(proc.stdout, sys.stdout), daemon=True)
    stdout_thread.start()
    try:
        _stdin_loop(proc, state)
    finally:
        _terminate(proc)
        stderr_thread.join(timeout=1)
        stdout_thread.join(timeout=1)
        _append_log(state.log_path, {"event": "wrapper_stopped", "injected": state.injected})
    return proc.returncode or 0


def _stdin_loop(proc: subprocess.Popen[str], state: FaultState) -> None:
    assert proc.stdin is not None
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            proc.stdin.write(line)
            proc.stdin.flush()
            continue
        if isinstance(message, dict):
            response = maybe_fault_response(message, state)
            if response is not None:
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
                continue
        proc.stdin.write(line)
        proc.stdin.flush()


def _copy_stream(source: Any, target: Any) -> None:
    if source is None:
        return
    for line in source:
        target.write(line)
        target.flush()


def _terminate(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except OSError:
        pass
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=2)
    except Exception:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
            proc.wait(timeout=2)


def _append_log(path: Path | None, row: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({key: value for key, value in row.items() if value is not None}, sort_keys=True) + "\n")


def _sanitize_config_override(value: str) -> str:
    if "=" not in value:
        return value
    key, raw = value.split("=", 1)
    lowered_key = key.lower()
    lowered_value = raw.lower()
    if raw.startswith("$"):
        return value
    if any(marker in lowered_key for marker in ("token", "secret", "password", "api_key", "apikey", "key")):
        return f"{key}=<redacted>"
    if "sk-" in lowered_value or "bearer " in lowered_value:
        return f"{key}=<redacted>"
    return value


def main() -> int:
    return run(parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
