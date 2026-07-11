from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
import signal
from typing import Any, Awaitable, Callable

from .conductor_runtime_process import _noop_log_task, _pid_alive


ProcessFactory = Callable[..., Awaitable[Any]]
SENSITIVE_RUNTIME_ENV_KEYS = {
    "LINEAR_API_KEY",
    "PODIUM_PROXY_TOKEN",
    "PODIUM_RUNTIME_GROUP_ID",
    "PODIUM_RUNTIME_ID",
    "PODIUM_RUNTIME_TOKEN",
}
ALLOWED_RUNTIME_OVERRIDE_KEYS = SENSITIVE_RUNTIME_ENV_KEYS - {"LINEAR_API_KEY"}
MANAGED_RUNTIME_ENV_KEYS = {
    "CODEX_HOME",
    "CODEX_MODEL",
    "CODEX_SDK_CODEX_BIN",
    "CODEX_SANDBOX",
    "CODEX_CONFIG_OVERRIDES",
    "CODEX_HARD_TURN_TIMEOUT_MS",
    "CODEX_READ_TIMEOUT_MS",
    "CODEX_INIT_MAX_ATTEMPTS",
    "CODEX_INIT_BACKOFF_MS",
    "CODEX_INIT_BACKOFF_MAX_MS",
    "CODEX_OVERLOAD_MAX_ATTEMPTS",
    "CODEX_OVERLOAD_INITIAL_DELAY_MS",
    "CODEX_OVERLOAD_MAX_DELAY_MS",
}
ALLOWED_RUNTIME_OVERRIDE_KEYS = ALLOWED_RUNTIME_OVERRIDE_KEYS | MANAGED_RUNTIME_ENV_KEYS


@dataclass
class RuntimeHandle:
    process: Any
    log_task: asyncio.Task[None]
    process_status: str
    attempt_id: str = ""
    mode: str = ""
    request_path: str = ""
    result_path: str = ""
    lease_id: str = ""
    recovered: bool = False


class RecoveredProcess:
    def __init__(self, pid: int):
        self.pid = pid
        self.returncode: int | None = None

    def terminate(self) -> None:
        self._signal(signal.SIGTERM)

    def kill(self) -> None:
        self._signal(signal.SIGKILL)

    async def wait(self) -> int:
        while self.returncode is None:
            try:
                waited_pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                waited_pid = 0
                status = 0
            if waited_pid == self.pid:
                self.returncode = os.waitstatus_to_exitcode(status)
                break
            if not _pid_alive(self.pid):
                self.returncode = 0
                break
            await asyncio.sleep(0.05)
        return self.returncode

    def _signal(self, sig: signal.Signals) -> None:
        if self.returncode is not None:
            return
        try:
            os.kill(self.pid, sig)
        except ProcessLookupError:
            self.returncode = 0


class _StartingProcess:
    pid: int | None = None
    returncode: int | None = None

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class _CompletedLogTask:
    def done(self) -> bool:
        return True

    def cancel(self) -> None:
        return None

    def __await__(self):
        if False:
            yield None
        return None


@dataclass(frozen=True)
class LogQuery:
    tail: int | None = 200
    limit_bytes: int = 1_048_576
    previous: bool = False
    order: str = "desc"
    timestamps: bool = False
    prefix: bool = False


@dataclass(frozen=True)
class LogQueryResult:
    instance_id: str
    generation: int | None
    path: str | None
    order: str
    lines: list[str]
    offset_start: int
    offset_end: int
    warnings: list[str]

    def text(self) -> str:
        if not self.lines:
            return ""
        return "\n".join(self.lines) + "\n"
