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


@dataclass
class RuntimeHandle:
    process: Any
    log_task: asyncio.Task[None]
    process_status: str


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
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.command = command or self._default_performer_command()

    async def start(
        self,
        instance: InstanceRecord,
        *,
        env: dict[str, str] | None = None,
        dispatch_issue_id: str | None = None,
    ) -> InstanceRecord:
        existing = self._handles.get(instance.id)
        if existing is not None and getattr(existing.process, "returncode", None) is None:
            return instance.with_updates(process_status="running", pid=getattr(existing.process, "pid", None))

        legacy_log_path = Path(instance.log_path)
        legacy_log_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_log_path.touch(exist_ok=True)
        log_path, _generation = self._allocate_generation_log(instance)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.touch(exist_ok=False)
        self._write_current_pointer(log_path)
        Path(instance.resolved_repo_path).mkdir(parents=True, exist_ok=True)
        process = await self.process_factory(
            *self._command_args(instance.workflow_path, dispatch_issue_id=dispatch_issue_id),
            cwd=instance.resolved_repo_path,
            env=self._process_env(env),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        log_task = asyncio.create_task(self._capture_logs(process, log_path))
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
            return instance
        returncode = getattr(handle.process, "returncode", None)
        if returncode is None:
            return instance.with_updates(process_status="running", pid=getattr(handle.process, "pid", None))
        self._handles.pop(instance.id, None)
        return instance.with_updates(process_status="exited", pid=None, last_exit_code=returncode)

    def runtime_snapshot(self, instance: InstanceRecord) -> dict[str, object]:
        handle = self._handles.get(instance.id)
        process_status = instance.process_status
        pid = instance.pid
        if handle is not None:
            returncode = getattr(handle.process, "returncode", None)
            process_status = "running" if returncode is None else "exited"
            pid = getattr(handle.process, "pid", None) if returncode is None else None
        return {
            "instance_id": instance.id,
            "process_status": process_status,
            "pid": pid,
            "http_port": instance.http_port,
            "workflow_path": instance.workflow_path,
            "log_path": instance.log_path,
        }

    def recover(self, instance: InstanceRecord) -> InstanceRecord | None:
        if instance.pid is None or not _pid_alive(instance.pid):
            return None
        if instance.id not in self._handles:
            log_task = asyncio.create_task(_noop_log_task())
            self._handles[instance.id] = RuntimeHandle(
                process=RecoveredProcess(instance.pid),
                log_task=log_task,
                process_status="running",
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
        return LogQueryResult(
            instance_id=instance.id,
            generation=generation,
            path=str(path),
            order=order,
            lines=lines,
            offset_start=offset_start,
            offset_end=offset_end,
            warnings=[],
        )

    async def _capture_logs(self, process: Any, log_path: Path) -> None:
        await asyncio.gather(
            self._pipe_stream(process.stdout, log_path),
            self._pipe_stream(process.stderr, log_path),
        )

    async def _pipe_stream(self, stream: Any, log_path: Path) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.readline()
            if not chunk:
                return
            with log_path.open("ab") as handle:
                handle.write(chunk)

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
        if overrides:
            env.update(overrides)
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

    def _command_args(self, workflow_path: str, *, dispatch_issue_id: str | None = None) -> tuple[str, ...]:
        if self.command == sys.executable:
            args = (self.command, "-m", "performer.cli", workflow_path)
        else:
            args = (self.command, workflow_path)
        if dispatch_issue_id:
            return (*args, "--dispatch-issue-id", dispatch_issue_id)
        return args

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
        with path.open("rb") as handle:
            while remaining > 0 and newlines <= tail:
                read_size = min(block_size, remaining)
                remaining -= read_size
                handle.seek(file_size - (sum(len(chunk) for chunk in chunks) + read_size))
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
