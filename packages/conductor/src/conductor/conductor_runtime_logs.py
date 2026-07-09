from __future__ import annotations

import asyncio
from pathlib import Path
import re
from typing import Any

from .conductor_models import InstanceRecord
from .conductor_runtime_process import _process_returncode, _sanitize_log_value
from .conductor_runtime_types import LogQuery, LogQueryResult, RecoveredProcess


class RuntimeLogMixin:
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
        handles = [self._handles[key] for key in self._handle_keys_for_instance(instance.id)]
        if any(handle.recovered for handle in handles):
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
        attempt_log_path: Path | None = None,
        mode: str | None = None,
        attempt_id: str | None = None,
        lease_id: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
    ) -> None:
        await asyncio.gather(
            self._pipe_stream(
                process.stdout,
                log_path,
                attempt_log_path=attempt_log_path,
                stream_name="stdout",
                mode=mode,
                attempt_id=attempt_id,
                lease_id=lease_id,
                attempt_request_path=attempt_request_path,
                attempt_result_path=attempt_result_path,
            ),
            self._pipe_stream(
                process.stderr,
                log_path,
                attempt_log_path=attempt_log_path,
                stream_name="stderr",
                mode=mode,
                attempt_id=attempt_id,
                lease_id=lease_id,
                attempt_request_path=attempt_request_path,
                attempt_result_path=attempt_result_path,
            ),
        )

    async def _pipe_stream(
        self,
        stream: Any,
        log_path: Path,
        *,
        attempt_log_path: Path | None,
        stream_name: str,
        mode: str | None,
        attempt_id: str | None,
        lease_id: str | None,
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
                        " ".join(
                            [
                                "event=performer_stream",
                                f"stream={stream_name}",
                                f"mode={mode or ''}",
                                *([f"attempt_id={attempt_id}"] if attempt_id else []),
                                *([f"lease_id={lease_id}"] if lease_id else []),
                                f"attempt_request_path={attempt_request_path or ''}",
                                f"attempt_result_path={attempt_result_path or ''}",
                                f"message={_sanitize_log_value(line)}",
                            ]
                        )
                        + "\n"
                    )
                    handle.write(event.encode("utf-8"))
                    if attempt_log_path is not None:
                        attempt_log_path.parent.mkdir(parents=True, exist_ok=True)
                        with attempt_log_path.open("ab") as attempt_handle:
                            attempt_handle.write(event.encode("utf-8"))

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
