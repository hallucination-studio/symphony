from __future__ import annotations

import asyncio
import os
from pathlib import Path
import re
import sys
from typing import Any

from .conductor_models import InstanceRecord


async def _noop_log_task() -> None:
    return None


def _derive_attempt_id(attempt_request_path: str | None, attempt_result_path: str | None) -> str:
    for value in (attempt_result_path, attempt_request_path):
        if value:
            parent_name = Path(value).parent.name
            if parent_name:
                return parent_name
    return "unknown-attempt"


def _attempt_log_path(attempt_result_path: str | None) -> Path | None:
    if not attempt_result_path:
        return None
    return Path(attempt_result_path).parent / "attempt.log"


def _sanitize_log_value(value: str) -> str:
    text = value.replace("\x00", "")
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text.replace("\r", "\\r").replace("\n", "\\n")


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _pid_matches_command(pid: int, command: str) -> bool:
    if not _pid_alive(pid):
        return False
    argv = _pid_argv(pid)
    if not argv:
        return False
    command_name = Path(command).name
    executable_name = Path(argv[0]).name if argv else ""
    if executable_name == command_name:
        return True
    basenames = {Path(arg).name for arg in argv[1:] if arg}
    if command_name in basenames:
        return True
    return any(
        executable_name == Path(sys.executable).name
        and arg == "-m"
        and index + 1 < len(argv)
        and argv[index + 1] == "performer.cli"
        for index, arg in enumerate(argv)
    )


def _has_recoverable_performer_log(instance: InstanceRecord) -> bool:
    path = Path(instance.log_path)
    return path.name.startswith("performer-") and path.name.endswith(".log") and path.exists()


def _can_recover_uninspectable_pid(instance: InstanceRecord) -> bool:
    if _has_recoverable_performer_log(instance):
        return True
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _pid_argv(pid: int) -> list[str]:
    proc_path = Path("/proc") / str(pid) / "cmdline"
    try:
        raw = proc_path.read_bytes()
    except OSError:
        raw = b""
    if raw:
        return [part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part]
    try:
        result = subprocess_run_ps(pid)
    except Exception:
        return []
    return result


def subprocess_run_ps(pid: int) -> list[str]:
    import shlex
    import subprocess

    output = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
    if not output:
        return []
    return shlex.split(output)


def _process_returncode(process: Any) -> int | None:
    poll = getattr(process, "poll", None)
    if callable(poll):
        try:
            return poll()
        except Exception:
            pass
    return getattr(process, "returncode", None)
