from __future__ import annotations

import asyncio

from .conductor_runtime_env_command import RuntimeEnvCommandMixin
from .conductor_runtime_lifecycle import RuntimeLifecycleMixin
from .conductor_runtime_logs import RuntimeLogMixin
from .conductor_runtime_types import (
    LogQuery,
    LogQueryResult,
    ProcessFactory,
    RecoveredProcess,
    RuntimeHandle,
    _CompletedLogTask,
    _StartingProcess,
)


class ConductorRuntimeManager(RuntimeLifecycleMixin, RuntimeLogMixin, RuntimeEnvCommandMixin):
    def __init__(self, *, process_factory: ProcessFactory | None = None, command: str | None = None):
        self._handles: dict[tuple[str, str], RuntimeHandle] = {}
        self._exited_attempts: dict[tuple[str, str], dict[str, object]] = {}
        self._start_locks: dict[str, asyncio.Lock] = {}
        self.process_factory = process_factory or asyncio.create_subprocess_exec
        self.command = command or self._default_performer_command()


__all__ = [
    "ConductorRuntimeManager",
    "LogQuery",
    "LogQueryResult",
    "ProcessFactory",
    "RecoveredProcess",
    "RuntimeHandle",
    "_CompletedLogTask",
    "_StartingProcess",
]
