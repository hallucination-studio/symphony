from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
from pathlib import Path
import sys
from typing import Any, Awaitable, Callable

from .conductor_models import InstanceRecord


ProcessFactory = Callable[..., Awaitable[Any]]


@dataclass
class RuntimeHandle:
    process: Any
    log_task: asyncio.Task[None]
    process_status: str


class ConductorRuntimeManager:
    def __init__(self, *, process_factory: ProcessFactory | None = None, command: str | None = None):
        self._handles: dict[str, RuntimeHandle] = {}
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.command = command or self._default_symphony_command()

    async def start(self, instance: InstanceRecord, *, env: dict[str, str] | None = None) -> InstanceRecord:
        existing = self._handles.get(instance.id)
        if existing is not None and getattr(existing.process, "returncode", None) is None:
            return instance.with_updates(process_status="running", pid=getattr(existing.process, "pid", None))

        log_path = Path(instance.log_path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("", encoding="utf-8")
        Path(instance.resolved_repo_path).mkdir(parents=True, exist_ok=True)
        process = await self.process_factory(
            self.command,
            instance.workflow_path,
            cwd=instance.resolved_repo_path,
            env=self._process_env(env),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        log_task = asyncio.create_task(self._capture_logs(process, log_path))
        self._handles[instance.id] = RuntimeHandle(process=process, log_task=log_task, process_status="running")
        return instance.with_updates(process_status="running", pid=getattr(process, "pid", None))

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

    def read_logs(self, instance: InstanceRecord) -> str:
        path = Path(instance.log_path)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

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

    def _default_symphony_command(self) -> str:
        sibling = Path(sys.executable).with_name("symphony")
        if sibling.exists():
            return str(sibling)
        return "symphony"

    def _process_env(self, overrides: dict[str, str] | None) -> dict[str, str]:
        env = dict(os.environ)
        if overrides:
            env.update(overrides)
        return env
