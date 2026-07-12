from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

WORKSPACE_INIT_EXCLUDES = {
    ".conductor",
    "conductor-data",
    ".venv",
    "workspaces",
    ".codex-runtime",
    ".test-real-flow",
    ".tmp-real-linear-flow",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "target",
}
PROJECT_LABEL_PREFIX = "symphony:"


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


@dataclass
class CoordinationCadence:
    project_labels_seconds: float = 300
    last_project_labels_at: datetime | None = None

    def project_labels_due(self, now: datetime) -> bool:
        return self._due(self.last_project_labels_at, self.project_labels_seconds, now)

    def mark_project_labels(self, now: datetime) -> None:
        self.last_project_labels_at = now

    @staticmethod
    def _due(last_at: datetime | None, interval_seconds: float, now: datetime) -> bool:
        if last_at is None:
            return True
        return (now - last_at).total_seconds() >= interval_seconds


__all__ = [
    "WORKSPACE_INIT_EXCLUDES",
    "PROJECT_LABEL_PREFIX",
    "ConductorServiceError",
    "CoordinationCadence",
]
