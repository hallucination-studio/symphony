from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STEPS = [
    "linear_connect",
    "scope_selection",
    "repository_mapping",
    "runtime_enrollment",
    "smoke_check",
    "complete",
]

# Maps a completed step to the step it satisfies in the ordered pipeline.
_STEP_ORDER = STEPS[:-1]  # everything except "complete"


class OnboardingStore:
    """Per-workspace onboarding state with optional JSON persistence."""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else None
        self._workspaces: dict[str, dict[str, Any]] = {}
        self._smoke_results: dict[str, dict[str, Any]] = {}
        if self._data_dir is not None:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            self._load()

    # ---- persistence -------------------------------------------------
    @property
    def _onboarding_file(self) -> Path | None:
        return self._data_dir / "onboarding.json" if self._data_dir else None

    @property
    def _smoke_file(self) -> Path | None:
        return self._data_dir / "smoke_results.json" if self._data_dir else None

    def _load(self) -> None:
        onboarding_file = self._onboarding_file
        if onboarding_file and onboarding_file.exists():
            try:
                self._workspaces = json.loads(onboarding_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                self._workspaces = {}
        smoke_file = self._smoke_file
        if smoke_file and smoke_file.exists():
            try:
                self._smoke_results = json.loads(smoke_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                self._smoke_results = {}

    def _persist_onboarding(self) -> None:
        onboarding_file = self._onboarding_file
        if onboarding_file is not None:
            onboarding_file.write_text(
                json.dumps(self._workspaces, indent=2, sort_keys=True), encoding="utf-8"
            )

    def _persist_smoke(self) -> None:
        smoke_file = self._smoke_file
        if smoke_file is not None:
            smoke_file.write_text(
                json.dumps(self._smoke_results, indent=2, sort_keys=True), encoding="utf-8"
            )

    # ---- state -------------------------------------------------------
    def _workspace(self, workspace_id: str) -> dict[str, Any]:
        return self._workspaces.setdefault(
            workspace_id,
            {"completed_steps": [], "scope": None, "repository": None},
        )

    def _mark(self, workspace_id: str, step: str) -> None:
        workspace = self._workspace(workspace_id)
        completed = workspace["completed_steps"]
        if step not in completed:
            completed.append(step)

    def _progress(self, workspace_id: str) -> dict[str, Any]:
        workspace = self._workspace(workspace_id)
        completed = [s for s in _STEP_ORDER if s in workspace["completed_steps"]]
        current_step = "complete"
        for step in _STEP_ORDER:
            if step not in completed:
                current_step = step
                break
        next_action = None if current_step == "complete" else current_step
        return {
            "current_step": current_step,
            "completed_steps": completed,
            "next_action": next_action,
        }

    def get(self, workspace_id: str) -> dict[str, Any]:
        return self._progress(workspace_id)

    def save_scope(self, workspace_id: str, teams: Any, projects: Any) -> dict[str, Any]:
        workspace = self._workspace(workspace_id)
        workspace["scope"] = {"teams": teams, "projects": projects}
        self._mark(workspace_id, "scope_selection")
        self._persist_onboarding()
        return self._progress(workspace_id)

    def save_repository(self, workspace_id: str, mode: str, value: str) -> dict[str, Any]:
        workspace = self._workspace(workspace_id)
        workspace["repository"] = {"mode": mode, "value": value}
        self._mark(workspace_id, "repository_mapping")
        self._persist_onboarding()
        return self._progress(workspace_id)

    def mark_linear_connected(self, workspace_id: str) -> dict[str, Any]:
        self._mark(workspace_id, "linear_connect")
        self._persist_onboarding()
        return self._progress(workspace_id)

    def mark_runtime_enrolled(self, workspace_id: str) -> dict[str, Any]:
        self._mark(workspace_id, "runtime_enrollment")
        self._persist_onboarding()
        return self._progress(workspace_id)

    def set_smoke_result(self, workspace_id: str, result: dict[str, Any]) -> dict[str, Any]:
        self._smoke_results[workspace_id] = result
        self._mark(workspace_id, "smoke_check")
        self._persist_smoke()
        self._persist_onboarding()
        return self._progress(workspace_id)

    def get_smoke_result(self, workspace_id: str) -> dict[str, Any] | None:
        return self._smoke_results.get(workspace_id)
