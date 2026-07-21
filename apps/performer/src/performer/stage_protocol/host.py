from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Event
from typing import Any, Callable

from performer.stage_execution.runtime import StageExecutionRuntime


MAX_REQUEST_BYTES = 16 * 1024 * 1024


class StageFileHost:
    def __init__(self, runtime: StageExecutionRuntime) -> None:
        self._runtime = runtime
        self._used = False

    def run(
        self,
        request_path: Path,
        result_path: Path,
        workspace_root: Path,
        *,
        cancel_event: Event | None = None,
        emit_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        if self._used:
            raise ValueError("stage_process_already_used")
        self._used = True
        request = request_path.read_bytes()
        if len(request) > MAX_REQUEST_BYTES:
            raise ValueError("stage_request_limit_exceeded")
        try:
            envelope = json.loads(request)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("stage_request_invalid") from error
        result = self._runtime.run(
            envelope,
            workspace_root,
            cancel_event=cancel_event,
            emit_event=emit_event,
        )
        _write_atomic(result_path, result)
        return result


def _write_atomic(result_path: Path, result: dict[str, Any]) -> None:
    temporary = result_path.with_suffix(result_path.suffix + ".tmp")
    temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, result_path)
