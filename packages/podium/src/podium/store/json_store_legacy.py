from __future__ import annotations

from typing import Any

from ..models import OnboardingProgress, OnboardingStep, RepositoryMapping, RuntimeRecord
from ..podium_shared import utc_now_iso


class JsonStoreLegacyMixin:
    # Legacy synchronous API used by small service unit tests.
    def save_runtime_record(self, record: RuntimeRecord) -> None:
        rows = self._load_map("runtimes.json")
        rows[record.runtime_id] = record.to_dict()
        self._write("runtimes.json", rows)

    def get_runtime_record(self, runtime_id: str) -> RuntimeRecord | None:
        row = self._load_map("runtimes.json").get(runtime_id)
        return RuntimeRecord.from_dict(row) if isinstance(row, dict) else None

    def list_runtime_records(self) -> list[RuntimeRecord]:
        return [
            RuntimeRecord.from_dict(row)
            for row in self._load_map("runtimes.json").values()
            if isinstance(row, dict)
        ]

    def update_runtime_heartbeat(
        self,
        runtime_id: str,
        *,
        version: str | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> RuntimeRecord:
        existing = self.get_runtime_record(runtime_id)
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
        rows = self._load_map("legacy_onboarding.json")
        rows[workspace_id] = progress.to_dict()
        self._write("legacy_onboarding.json", rows)

    def get_onboarding_progress(self, workspace_id: str) -> OnboardingProgress | None:
        row = self._load_map("legacy_onboarding.json").get(workspace_id)
        return OnboardingProgress.from_dict(row) if isinstance(row, dict) else None

    def get_or_create_onboarding_progress(self, workspace_id: str) -> OnboardingProgress:
        progress = self.get_onboarding_progress(workspace_id)
        if progress is None:
            progress = OnboardingProgress(
                current_step=OnboardingStep.LINEAR_CONNECT,
                completed_steps=[],
                next_action=OnboardingStep.LINEAR_CONNECT.value,
            )
            self.save_onboarding_progress(workspace_id, progress)
        return progress

    def save_repository_mapping(self, workspace_id: str, mapping: RepositoryMapping) -> None:
        rows = self._load_map("repositories.json")
        rows[workspace_id] = mapping.to_dict()
        self._write("repositories.json", rows)

    def get_repository_mapping(self, workspace_id: str) -> RepositoryMapping | None:
        row = self._load_map("repositories.json").get(workspace_id)
        return RepositoryMapping.from_dict(row) if isinstance(row, dict) else None

    def save_user(self, user_id: str, user: dict[str, Any]) -> None:
        rows = self._load_map("users.json")
        rows[user_id] = dict(user)
        self._write("users.json", rows)
