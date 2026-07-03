from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..models import (
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RunSummary,
    RuntimeRecord,
)


class PodiumStore:
    """Small JSON-backed store used by Podium service wrappers and tests."""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else None
        self.runtime_records: dict[str, RuntimeRecord] = {}
        self.onboarding_progress: dict[str, OnboardingProgress] = {}
        self.repository_mappings: dict[str, RepositoryMapping] = {}
        self.runs: dict[str, RunSummary] = {}
        self.users: dict[str, dict[str, Any]] = {}
        if self.data_dir is not None:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self._load()

    def _path(self, name: str) -> Path | None:
        return self.data_dir / name if self.data_dir else None

    def _load_json(self, name: str) -> dict[str, Any]:
        path = self._path(name)
        if path is None or not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _write_json(self, name: str, payload: dict[str, Any]) -> None:
        path = self._path(name)
        if path is not None:
            path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def _load(self) -> None:
        self.runtime_records = {
            key: RuntimeRecord.from_dict(value)
            for key, value in self._load_json("runtimes.json").items()
        }
        self.onboarding_progress = {
            key: OnboardingProgress.from_dict(value)
            for key, value in self._load_json("onboarding.json").items()
        }
        self.repository_mappings = {
            key: RepositoryMapping.from_dict(value)
            for key, value in self._load_json("repositories.json").items()
        }
        self.runs = {
            key: RunSummary.from_dict(value)
            for key, value in self._load_json("runs.json").items()
        }
        self.users = self._load_json("users.json")

    def save_runtime_record(self, record: RuntimeRecord) -> None:
        self.runtime_records[record.runtime_id] = record
        self._write_json("runtimes.json", {k: v.to_dict() for k, v in self.runtime_records.items()})

    def get_runtime_record(self, runtime_id: str) -> RuntimeRecord | None:
        return self.runtime_records.get(runtime_id)

    def list_runtime_records(self) -> list[RuntimeRecord]:
        return list(self.runtime_records.values())

    def update_runtime_heartbeat(
        self,
        runtime_id: str,
        *,
        version: str | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> RuntimeRecord:
        from ..app import utc_now_iso

        existing = self.runtime_records.get(runtime_id)
        record = RuntimeRecord(
            runtime_id=runtime_id,
            online=True,
            last_heartbeat=timestamp or utc_now_iso(),
            version=version if version is not None else (existing.version if existing else None),
            metadata=metadata if metadata is not None else (existing.metadata if existing else {}),
        )
        self.save_runtime_record(record)
        return record

    def save_onboarding_progress(self, workspace_id: str, progress: OnboardingProgress) -> None:
        self.onboarding_progress[workspace_id] = progress
        self._write_json("onboarding.json", {k: v.to_dict() for k, v in self.onboarding_progress.items()})

    def get_onboarding_progress(self, workspace_id: str) -> OnboardingProgress | None:
        return self.onboarding_progress.get(workspace_id)

    def get_or_create_onboarding_progress(self, workspace_id: str) -> OnboardingProgress:
        progress = self.onboarding_progress.get(workspace_id)
        if progress is None:
            progress = OnboardingProgress(
                current_step=OnboardingStep.LINEAR_CONNECT,
                completed_steps=[],
                next_action=OnboardingStep.LINEAR_CONNECT.value,
            )
            self.save_onboarding_progress(workspace_id, progress)
        return progress

    def save_repository_mapping(self, workspace_id: str, mapping: RepositoryMapping) -> None:
        self.repository_mappings[workspace_id] = mapping
        self._write_json("repositories.json", {k: v.to_dict() for k, v in self.repository_mappings.items()})

    def get_repository_mapping(self, workspace_id: str) -> RepositoryMapping | None:
        return self.repository_mappings.get(workspace_id)

    def save_run(self, run: RunSummary) -> None:
        self.runs[run.run_id] = run
        self._write_json("runs.json", {k: v.to_dict() for k, v in self.runs.items()})

    def list_runs(self) -> list[RunSummary]:
        return list(self.runs.values())

    def get_run(self, run_id: str) -> RunSummary | None:
        return self.runs.get(run_id)

    def save_user(self, user_id: str, user: dict[str, Any]) -> None:
        self.users[user_id] = user
        self._write_json("users.json", self.users)
