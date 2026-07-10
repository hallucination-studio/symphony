from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from .conductor_models import InstanceRecord
from .conductor_runtime_process import (
    _attempt_log_path,
    _can_recover_uninspectable_pid,
    _derive_attempt_id,
    _pid_alive,
    _pid_matches_command,
    _process_returncode,
)
from .conductor_runtime_types import RecoveredProcess, RuntimeHandle, _CompletedLogTask, _StartingProcess, _noop_log_task


class RuntimeLifecycleMixin:
    async def start(
        self,
        instance: InstanceRecord,
        *,
        env: dict[str, str] | None = None,
        mode: str | None = None,
        attempt_id: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
        lease_id: str | None = None,
    ) -> InstanceRecord:
        resolved_attempt_id = attempt_id or _derive_attempt_id(attempt_request_path, attempt_result_path)
        handle_key = (instance.id, resolved_attempt_id)
        lock = self._start_locks.setdefault(instance.id, asyncio.Lock())
        async with lock:
            existing = self._handles.get(handle_key)
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
            self._handles[handle_key] = RuntimeHandle(
                process=placeholder,
                log_task=asyncio.create_task(_noop_log_task()),
                process_status="starting",
                attempt_id=resolved_attempt_id,
                mode=mode or "",
                request_path=attempt_request_path or "",
                result_path=attempt_result_path or "",
                lease_id=lease_id or "",
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
                self._handles.pop(handle_key, None)
                raise
            attempt_log_path = _attempt_log_path(attempt_result_path)
            log_task = asyncio.create_task(
                self._capture_logs(
                    process,
                    log_path,
                    attempt_log_path=attempt_log_path,
                    mode=mode,
                    attempt_id=attempt_id,
                    lease_id=lease_id,
                    attempt_request_path=attempt_request_path,
                    attempt_result_path=attempt_result_path,
                )
            )
            self._handles[handle_key] = RuntimeHandle(
                process=process,
                log_task=log_task,
                process_status="running",
                attempt_id=resolved_attempt_id,
                mode=mode or "",
                request_path=attempt_request_path or "",
                result_path=attempt_result_path or "",
                lease_id=lease_id or "",
            )
            return instance.with_updates(process_status="running", pid=getattr(process, "pid", None), log_path=str(log_path))

    async def stop(self, instance: InstanceRecord) -> InstanceRecord:
        await self._stop_handles(self._handle_keys_for_instance(instance.id))
        self._clear_exited_attempts(instance.id)
        return instance.with_updates(process_status="stopped", pid=None)

    async def stop_attempts(self, instance: InstanceRecord, attempt_ids: list[str]) -> InstanceRecord:
        wanted = {str(attempt_id) for attempt_id in attempt_ids if str(attempt_id)}
        keys = [key for key in self._handle_keys_for_instance(instance.id) if key[1] in wanted]
        await self._stop_handles(keys)
        return self.refresh(instance)

    async def restart(self, instance: InstanceRecord, *, env: dict[str, str] | None = None) -> InstanceRecord:
        stopped = await self.stop(instance)
        return await self.start(stopped, env=env)

    def refresh(self, instance: InstanceRecord) -> InstanceRecord:
        keys = self._handle_keys_for_instance(instance.id)
        if not keys:
            if (
                instance.process_status in {"running", "starting"}
                and instance.pid is not None
                and not _pid_matches_command(instance.pid, self.command)
            ):
                return instance.with_updates(process_status="exited", pid=None, last_exit_code=-1)
            return instance
        active_handles: list[RuntimeHandle] = []
        last_exit_code: int | None = None
        for key in keys:
            handle = self._handles.get(key)
            if handle is None:
                continue
            returncode = _process_returncode(handle.process)
            if returncode is None:
                active_handles.append(handle)
            else:
                last_exit_code = returncode
                self._record_exited_attempt(key, handle, returncode)
                self._handles.pop(key, None)
        if active_handles:
            handle = active_handles[-1]
            return instance.with_updates(process_status="running", pid=getattr(handle.process, "pid", None))
        if last_exit_code is not None:
            return instance.with_updates(process_status="exited", pid=None, last_exit_code=last_exit_code)
        return instance

    def drain_exited_attempts(self, instance: InstanceRecord) -> list[dict[str, object]]:
        snapshots: list[dict[str, object]] = []
        for key in list(self._exited_attempts):
            if key[0] != instance.id:
                continue
            snapshots.append(dict(self._exited_attempts.pop(key)))
        return snapshots

    async def _stop_handles(self, keys: list[tuple[str, str]]) -> None:
        for key in keys:
            handle = self._handles.pop(key, None)
            if handle is None:
                continue
            if getattr(handle.process, "returncode", None) is None:
                handle.process.terminate()
            try:
                await asyncio.wait_for(handle.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                handle.process.kill()
                await handle.process.wait()
            await self._finish_log_task(handle.log_task)

    def runtime_snapshot(self, instance: InstanceRecord) -> dict[str, object]:
        process_status = instance.process_status
        pid = instance.pid
        handles = [self._handles[key] for key in self._handle_keys_for_instance(instance.id)]
        active = []
        for handle in handles:
            returncode = _process_returncode(handle.process)
            if returncode is None:
                active.append(handle)
        if active:
            process_status = "running"
            pid = getattr(active[-1].process, "pid", None)
        elif handles:
            process_status = "exited"
            pid = None
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
        if not _pid_alive(instance.pid):
            return None
        matches = _pid_matches_command(instance.pid, self.command)
        if not matches and not _can_recover_uninspectable_pid(instance):
            return None
        if not self._handle_keys_for_instance(instance.id):
            try:
                loop = asyncio.get_running_loop()
                log_task = loop.create_task(self._follow_recovered_process(instance.pid))
            except RuntimeError:
                log_task = _CompletedLogTask()
            self._handles[(instance.id, f"recovered-{instance.pid}")] = RuntimeHandle(
                process=RecoveredProcess(instance.pid),
                log_task=log_task,  # type: ignore[arg-type]
                process_status="running",
                attempt_id=f"recovered-{instance.pid}",
                recovered=True,
            )
        return instance.with_updates(process_status="running", pid=instance.pid)

    def recover_attempt(self, instance: InstanceRecord, attempt: Any) -> InstanceRecord | None:
        pid = getattr(attempt, "process_pid", None)
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return None
        if pid <= 0:
            return None
        if not _pid_alive(pid):
            return None
        matches = _pid_matches_command(pid, self.command)
        probe_instance = instance.with_updates(pid=pid) if getattr(instance, "pid", None) != pid else instance
        if not matches and not _can_recover_uninspectable_pid(probe_instance):
            return None
        attempt_id = str(getattr(attempt, "attempt_id", "") or f"recovered-{pid}")
        handle_key = (instance.id, attempt_id)
        if handle_key not in self._handles:
            try:
                loop = asyncio.get_running_loop()
                log_task = loop.create_task(self._follow_recovered_process(pid))
            except RuntimeError:
                log_task = _CompletedLogTask()
            request_path = str(Path(instance.instance_dir) / "state" / "managed_run" / attempt_id / "turn-request.json")
            result_path = str(Path(instance.instance_dir) / "state" / "managed_run" / attempt_id / "turn-result.json")
            self._handles[handle_key] = RuntimeHandle(
                process=RecoveredProcess(pid),
                log_task=log_task,  # type: ignore[arg-type]
                process_status="running",
                attempt_id=attempt_id,
                mode=str(getattr(getattr(attempt, "mode", ""), "value", getattr(attempt, "mode", ""))),
                request_path=request_path,
                result_path=result_path,
                lease_id=str(getattr(attempt, "lease_id", "") or ""),
                recovered=True,
            )
        return instance.with_updates(process_status="running", pid=pid)

    def _handle_keys_for_instance(self, instance_id: str) -> list[tuple[str, str]]:
        return [key for key in self._handles if key[0] == instance_id]

    def _record_exited_attempt(self, key: tuple[str, str], handle: RuntimeHandle, exit_code: int) -> None:
        self._exited_attempts[key] = {
            "instance_id": key[0],
            "attempt_id": handle.attempt_id or key[1],
            "mode": handle.mode,
            "lease_id": handle.lease_id,
            "request_path": handle.request_path,
            "result_path": handle.result_path,
            "pid": getattr(handle.process, "pid", None),
            "exit_code": exit_code,
        }

    def _clear_exited_attempts(self, instance_id: str) -> None:
        for key in list(self._exited_attempts):
            if key[0] == instance_id:
                self._exited_attempts.pop(key, None)
