from __future__ import annotations

import logging
from pathlib import Path

from performer_api.config import ServiceConfig, load_env_file
from performer_api.workflow import load_workflow


logger = logging.getLogger(__name__)


class WorkflowReloader:
    def __init__(self, path: Path):
        self.path = path
        self._last_mtime_ns: int | None = None
        self._current: ServiceConfig | None = None
        self.last_error: Exception | None = None

    def current(self) -> ServiceConfig:
        stat = self.path.stat()
        if self._current is not None and self._last_mtime_ns == stat.st_mtime_ns:
            return self._current
        try:
            load_env_file(self.path.parent / ".env")
            workflow = load_workflow(self.path)
            config = ServiceConfig.from_workflow(workflow, self.path)
            config.validate_for_dispatch()
        except Exception as exc:
            self.last_error = exc
            logger.warning("performer_workflow_reload failed path=%s reason=%s", self.path, exc)
            if self._current is not None:
                return self._current
            raise
        self._current = config
        self._last_mtime_ns = stat.st_mtime_ns
        self.last_error = None
        return config
