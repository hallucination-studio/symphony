from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
from pathlib import Path
import re
import signal
import sys
from typing import Any, Awaitable, Callable

from .conductor_models import InstanceRecord


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


class ConductorRuntimeManager:
    def __init__(self, *, process_factory: ProcessFactory | None = None, command: str | None = None):
        self._handles: dict[str, RuntimeHandle] = {}
        self._start_locks: dict[str, asyncio.Lock] = {}
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.command = command or self._default_performer_command()

    async def start(
        self,
        instance: InstanceRecord,
        *,
        env: dict[str, str] | None = None,
        mode: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
    ) -> InstanceRecord:
        lock = self._start_locks.setdefault(instance.id, asyncio.Lock())
        async with lock:
            existing = self._handles.get(instance.id)
            if existing is not None and getattr(existing.process, "returncode", None) is None:
                pid = getattr(existing.process, "pid", None)
                status = existing.process_status if existing.process_status in {"starting", "running"} else "running"
                return instance.with_updates(process_status=status, pid=pid)

            legacy_log_path = Path(instance.log_path)
            legacy_log_path.parent.mkdir(parents=True, exist_ok=True)
            legacy_log_path.touch(exist_ok=True)
            log_path, _generation = self._allocate_generation_log(instance)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.touch(exist_ok=False)
            self._write_current_pointer(log_path)
            Path(instance.resolved_repo_path).mkdir(parents=True, exist_ok=True)
            placeholder = _StartingProcess()
            self._handles[instance.id] = RuntimeHandle(
                process=placeholder,
                log_task=asyncio.create_task(_noop_log_task()),
                process_status="starting",
            )
            try:
                process = await self.process_factory(
                    *self._command_args(
                        mode=mode,
                        attempt_request_path=attempt_request_path,
                        attempt_result_path=attempt_result_path,
                    ),
                    cwd=instance.resolved_repo_path,
                    env=self._process_env(env),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except Exception:
                self._handles.pop(instance.id, None)
                raise
            log_task = asyncio.create_task(
                self._capture_logs(
                    process,
                    log_path,
                    mode=mode,
                    attempt_request_path=attempt_request_path,
                    attempt_result_path=attempt_result_path,
                )
            )
            self._handles[instance.id] = RuntimeHandle(process=process, log_task=log_task, process_status="running")
            return instance.with_updates(process_status="running", pid=getattr(process, "pid", None), log_path=str(log_path))

    async def stop(self, instance: InstanceRecord) -> InstanceRecord:
        handle = self._handles.pop(instance.id, None)
        if handle is not None:
            if getattr(handle.process, "returncode", None) is None:
                handle.process.terminate()
            try:
                await asyncio.wait_for(handle.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                handle.process.kill()
                await handle.process.wait()
            await self._finish_log_task(handle.log_task)
        return instance.with_updates(process_status="stopped", pid=None)

    async def restart(self, instance: InstanceRecord, *, env: dict[str, str] | None = None) -> InstanceRecord:
        stopped = await self.stop(instance)
        return await self.start(stopped, env=env)

    def refresh(self, instance: InstanceRecord) -> InstanceRecord:
        handle = self._handles.get(instance.id)
        if handle is None:
            if (
                instance.process_status in {"running", "starting"}
                and instance.pid is not None
                and not _pid_matches_command(instance.pid, self.command)
            ):
                return instance.with_updates(process_status="exited", pid=None, last_exit_code=-1)
            return instance
        returncode = _process_returncode(handle.process)
        if returncode is None:
            return instance.with_updates(process_status="running", pid=getattr(handle.process, "pid", None))
        self._handles.pop(instance.id, None)
        return instance.with_updates(process_status="exited", pid=None, last_exit_code=returncode)

    def runtime_snapshot(self, instance: InstanceRecord) -> dict[str, object]:
        handle = self._handles.get(instance.id)
        process_status = instance.process_status
        pid = instance.pid
        if handle is not None:
            returncode = _process_returncode(handle.process)
            process_status = "running" if returncode is None else "exited"
            pid = getattr(handle.process, "pid", None) if returncode is None else None
        return {
            "instance_id": instance.id,
            "process_status": process_status,
            "pid": pid,
            "http_port": instance.http_port,
            "log_path": instance.log_path,
        }

    def recover(self, instance: InstanceRecord) -> InstanceRecord | None:
        if instance.pid is None:
            return None
        matches = _pid_matches_command(instance.pid, self.command)
        if not matches and not _can_recover_uninspectable_pid(instance):
            return None
        if instance.id not in self._handles:
            try:
                loop = asyncio.get_running_loop()
                log_task = loop.create_task(self._follow_recovered_process(instance.pid))
            except RuntimeError:
                log_task = _CompletedLogTask()
            self._handles[instance.id] = RuntimeHandle(
                process=RecoveredProcess(instance.pid),
                log_task=log_task,  # type: ignore[arg-type]
                process_status="running",
                recovered=True,
            )
        return instance.with_updates(process_status="running", pid=instance.pid)

    def read_logs(self, instance: InstanceRecord) -> str:
        return self.query_logs(instance, LogQuery(order="asc")).text()

    def query_logs(self, instance: InstanceRecord, query: LogQuery | None = None) -> LogQueryResult:
        query = query or LogQuery()
        path, generation = self._select_log_file(instance, previous=query.previous)
        order = "asc" if query.order == "asc" else "desc"
        if path is None or not path.exists():
            return LogQueryResult(
                instance_id=instance.id,
                generation=None,
                path=None,
                order=order,
                lines=[],
                offset_start=0,
                offset_end=0,
                warnings=[],
            )
        limit_bytes = max(int(query.limit_bytes), 0)
        raw, offset_start, offset_end = self._read_log_window(path, tail=query.tail, limit_bytes=limit_bytes)
        lines = raw.decode("utf-8", errors="replace").splitlines()
        if order == "desc":
            lines = list(reversed(lines))
        warnings = []
        handle = self._handles.get(instance.id)
        if handle is not None and handle.recovered:
            warnings.append("stdout/stderr pipes could not be reattached after Conductor restart; showing persisted log file only")
        return LogQueryResult(
            instance_id=instance.id,
            generation=generation,
            path=str(path),
            order=order,
            lines=lines,
            offset_start=offset_start,
            offset_end=offset_end,
            warnings=warnings,
        )

    async def _follow_recovered_process(self, pid: int) -> None:
        process = RecoveredProcess(pid)
        await process.wait()

    async def _capture_logs(
        self,
        process: Any,
        log_path: Path,
        *,
        mode: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
    ) -> None:
        await asyncio.gather(
            self._pipe_stream(
                process.stdout,
                log_path,
                stream_name="stdout",
                mode=mode,
                attempt_request_path=attempt_request_path,
                attempt_result_path=attempt_result_path,
            ),
            self._pipe_stream(
                process.stderr,
                log_path,
                stream_name="stderr",
                mode=mode,
                attempt_request_path=attempt_request_path,
                attempt_result_path=attempt_result_path,
            ),
        )

    async def _pipe_stream(
        self,
        stream: Any,
        log_path: Path,
        *,
        stream_name: str,
        mode: str | None,
        attempt_request_path: str | None,
        attempt_result_path: str | None,
    ) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.readline()
            if not chunk:
                return
            with log_path.open("ab") as handle:
                for line in chunk.decode("utf-8", errors="replace").splitlines():
                    event = (
                        "event=performer_stream "
                        f"stream={stream_name} mode={mode or ''} "
                        f"attempt_request_path={attempt_request_path or ''} "
                        f"attempt_result_path={attempt_result_path or ''} "
                        f"message={_sanitize_log_value(line)}\n"
                    )
                    handle.write(event.encode("utf-8"))

    async def _finish_log_task(self, log_task: asyncio.Task[None]) -> None:
        if log_task.done():
            await log_task
            return
        try:
            await asyncio.wait_for(log_task, timeout=1)
        except asyncio.TimeoutError:
            log_task.cancel()
            try:
                await log_task
            except asyncio.CancelledError:
                pass

    def _default_performer_command(self) -> str:
        sibling = Path(sys.executable).with_name("performer")
        if sibling.exists():
            return str(sibling)
        repo_performer = Path(__file__).resolve().parents[3] / "performer" / "src"
        if repo_performer.exists():
            return sys.executable
        return "performer"

    def _process_env(self, overrides: dict[str, str] | None) -> dict[str, str]:
        env = dict(os.environ)
        for key in SENSITIVE_RUNTIME_ENV_KEYS:
            env.pop(key, None)
        for key in list(env):
            if key.startswith("CODEX_"):
                env.pop(key, None)
        if overrides:
            env.update({key: value for key, value in overrides.items() if key in ALLOWED_RUNTIME_OVERRIDE_KEYS})
        package_root = Path(__file__).resolve().parents[3]
        local_srcs = [
            str(package_root / "performer-api" / "src"),
            str(package_root / "performer" / "src"),
            str(package_root / "conductor" / "src"),
            str(package_root / "podium" / "src"),
        ]
        existing = env.get("PYTHONPATH")
        paths = existing.split(os.pathsep) if existing else []
        for local_src in reversed(local_srcs):
            if local_src not in paths:
                paths.insert(0, local_src)
        env["PYTHONPATH"] = os.pathsep.join(paths)
        return env

    def _command_args(
        self,
        *,
        mode: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
    ) -> tuple[str, ...]:
        if not mode or not attempt_request_path or not attempt_result_path:
            raise ValueError("--mode, --attempt-request-path, and --attempt-result-path are required for Performer launches")
        if self.command == sys.executable:
            args = (self.command, "-m", "performer.cli")
        else:
            args = (self.command,)
        return (
            *args,
            "--mode",
            mode,
            "--attempt-request-path",
            attempt_request_path,
            "--attempt-result-path",
            attempt_result_path,
        )

    def _allocate_generation_log(self, instance: InstanceRecord) -> tuple[Path, int]:
        logs_dir = Path(instance.instance_dir) / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        generations = self._generation_files(logs_dir)
        next_generation = (max(generations) + 1) if generations else 1
        return logs_dir / f"performer-{next_generation:06d}.log", next_generation

    def _select_log_file(self, instance: InstanceRecord, *, previous: bool) -> tuple[Path | None, int | None]:
        current_path = Path(instance.log_path)
        logs_dir = Path(instance.instance_dir) / "logs"
        generations = self._generation_files(logs_dir)
        current_generation = self._generation_from_path(current_path)
        if current_generation is None and generations:
            current_generation = max(generations)
            current_path = generations[current_generation]
        if previous:
            candidates = [generation for generation in generations if current_generation is None or generation < current_generation]
            if not candidates:
                return None, None
            generation = max(candidates)
            return generations[generation], generation
        if current_generation is not None:
            return current_path, current_generation
        if current_path.exists():
            return current_path, None
        return None, None

    def _generation_files(self, logs_dir: Path) -> dict[int, Path]:
        files: dict[int, Path] = {}
        if not logs_dir.exists():
            return files
        for path in logs_dir.glob("performer-*.log"):
            generation = self._generation_from_path(path)
            if generation is not None:
                files[generation] = path
        return files

    def _generation_from_path(self, path: Path) -> int | None:
        match = re.fullmatch(r"performer-(\d{6})\.log", path.name)
        if match is None:
            return None
        return int(match.group(1))

    def _write_current_pointer(self, log_path: Path) -> None:
        pointer = log_path.parent / "current.log"
        if pointer.exists() or pointer.is_symlink():
            pointer.unlink()
        pointer.write_text(str(log_path), encoding="utf-8")

    def _read_log_window(self, path: Path, *, tail: int | None, limit_bytes: int) -> tuple[bytes, int, int]:
        file_size = path.stat().st_size
        if file_size == 0 or limit_bytes == 0:
            return b"", file_size, file_size
        max_bytes = min(file_size, limit_bytes)
        if tail is None or tail <= 0:
            with path.open("rb") as handle:
                handle.seek(file_size - max_bytes)
                data = handle.read(max_bytes)
            data = self._drop_partial_first_line(data, file_size - max_bytes)
            return data, file_size - len(data), file_size
        data, offset_start = self._read_tail_lines(path, tail=tail, max_bytes=max_bytes)
        if len(data) > limit_bytes:
            data = data[-limit_bytes:]
            data = self._drop_partial_first_line(data, file_size - len(data))
        return data, offset_start, file_size

    def _read_tail_lines(self, path: Path, *, tail: int, max_bytes: int) -> tuple[bytes, int]:
        file_size = path.stat().st_size
        remaining = min(file_size, max_bytes)
        chunks: list[bytes] = []
        newlines = 0
        block_size = 8192
        offset = file_size
        with path.open("rb") as handle:
            while remaining > 0 and newlines <= tail:
                read_size = min(block_size, remaining)
                remaining -= read_size
                offset -= read_size
                handle.seek(offset)
                chunk = handle.read(read_size)
                chunks.insert(0, chunk)
                newlines += chunk.count(b"\n")
        data = b"".join(chunks)
        if len(data) > max_bytes:
            data = data[-max_bytes:]
            data = self._drop_partial_first_line(data, file_size - len(data))
        lines = data.splitlines(keepends=True)
        if len(lines) > tail:
            selected = b"".join(lines[-tail:])
            return selected, file_size - len(selected)
        return data, file_size - len(data)

    def _drop_partial_first_line(self, data: bytes, offset_start: int) -> bytes:
        if offset_start <= 0 or not data:
            return data
        newline_index = data.find(b"\n")
        if newline_index == -1:
            return b""
        return data[newline_index + 1 :]


async def _noop_log_task() -> None:
    return None


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
    import subprocess

    output = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
    if not output:
        return []
    import shlex

    return shlex.split(output)


def _process_returncode(process: Any) -> int | None:
    poll = getattr(process, "poll", None)
    if callable(poll):
        try:
            return poll()
        except Exception:
            pass
    return getattr(process, "returncode", None)
