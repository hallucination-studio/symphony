from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

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
HUMAN_ACTION_LABEL = "performer:type/human-action"
HUMAN_RESPONSE_MARKER_NAME = "SYMPHONY HUMAN RESPONSE"
PROJECT_LABEL_PREFIX = "symphony:"
CONDUCTOR_STALL_TIMEOUT_FLOOR_MS = 300_000


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


class CoordinationResult(dict[str, Any]):
    def __init__(
        self,
        *,
        repository_handoff: dict[str, Any],
        dispatch_acks: dict[str, Any],
        project_labels_synced: int,
        managed_run_turns_started: int = 0,
        managed_run_results_applied: int = 0,
        managed_run_integrations_processed: int = 0,
        managed_run_timeouts: int = 0,
        managed_run_crash_retries: int = 0,
        managed_run_crash_failures: int = 0,
        managed_run_human_actions_created: int = 0,
        managed_run_human_actions_completed: int = 0,
        managed_run_human_actions_missing_response: int = 0,
        managed_run_human_actions_failed: int = 0,
        managed_run_runtime_waits_observed: int = 0,
        linear_managed_run_ingestions: int = 0,
        linear_managed_run_projections: int = 0,
        dispatchable: int = 0,
        blocked_waiting: int = 0,
        reconcile_findings: list[dict[str, Any]] | None = None,
        remediations: dict[str, Any] | None = None,
        crash_restarts: int = 0,
        crash_loops: int = 0,
    ):
        super().__init__(
            repository_handoff=repository_handoff,
            dispatch_acks=dispatch_acks,
            project_labels_synced=project_labels_synced,
            managed_run_turns_started=managed_run_turns_started,
            managed_run_results_applied=managed_run_results_applied,
            managed_run_integrations_processed=managed_run_integrations_processed,
            managed_run_timeouts=managed_run_timeouts,
            managed_run_crash_retries=managed_run_crash_retries,
            managed_run_crash_failures=managed_run_crash_failures,
            managed_run_human_actions_created=managed_run_human_actions_created,
            managed_run_human_actions_completed=managed_run_human_actions_completed,
            managed_run_human_actions_missing_response=managed_run_human_actions_missing_response,
            managed_run_human_actions_failed=managed_run_human_actions_failed,
            managed_run_runtime_waits_observed=managed_run_runtime_waits_observed,
            linear_managed_run_ingestions=linear_managed_run_ingestions,
            linear_managed_run_projections=linear_managed_run_projections,
            dispatchable=dispatchable,
            blocked_waiting=blocked_waiting,
            reconcile_findings=list(reconcile_findings or []),
            remediations=dict(remediations or {}),
            crash_restarts=crash_restarts,
            crash_loops=crash_loops,
        )

    def to_dict(self) -> dict[str, Any]:
        return dict(self)

    def __getattr__(self, key: str) -> Any:
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc


@dataclass
class CoordinationCadence:
    repository_handoff_seconds: float = 30
    project_labels_seconds: float = 300
    last_repository_handoff_at: datetime | None = None
    last_project_labels_at: datetime | None = None

    def repository_handoff_due(self, now: datetime) -> bool:
        return self._due(self.last_repository_handoff_at, self.repository_handoff_seconds, now)

    def project_labels_due(self, now: datetime) -> bool:
        return self._due(self.last_project_labels_at, self.project_labels_seconds, now)

    def mark_repository_handoff(self, now: datetime) -> None:
        self.last_repository_handoff_at = now

    def mark_project_labels(self, now: datetime) -> None:
        self.last_project_labels_at = now

    @staticmethod
    def _due(last_at: datetime | None, interval_seconds: float, now: datetime) -> bool:
        if last_at is None:
            return True
        return (now - last_at).total_seconds() >= interval_seconds


__all__ = [
    "WORKSPACE_INIT_EXCLUDES",
    "HUMAN_ACTION_LABEL",
    "HUMAN_RESPONSE_MARKER_NAME",
    "PROJECT_LABEL_PREFIX",
    "CONDUCTOR_STALL_TIMEOUT_FLOOR_MS",
    "ConductorServiceError",
    "CoordinationResult",
    "CoordinationCadence",
]
