from __future__ import annotations

from typing import Any, Callable

from .app import utc_now_iso
from .models import (
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RepositoryMappingMode,
    RuntimeRecord,
    SmokeCheckResult,
    SmokeCheckStatus,
    ValidationState,
)
from .store import PodiumStore


ORDER = [
    OnboardingStep.LINEAR_CONNECT,
    OnboardingStep.SCOPE_SELECTION,
    OnboardingStep.REPOSITORY_MAPPING,
    OnboardingStep.RUNTIME_ENROLLMENT,
    OnboardingStep.SMOKE_CHECK,
]


class OnboardingService:
    def __init__(
        self,
        store: PodiumStore,
        *,
        linear_connected: Callable[[str], bool] | None = None,
    ) -> None:
        self.store = store
        self.linear_connected = linear_connected or (lambda _workspace_id: False)
        self._smoke_results: dict[str, SmokeCheckResult] = {}

    def get_progress(self, workspace_id: str) -> OnboardingProgress:
        progress = self.store.get_or_create_onboarding_progress(workspace_id)
        completed = list(progress.completed_steps)
        if self.linear_connected(workspace_id) and OnboardingStep.LINEAR_CONNECT not in completed:
            completed.append(OnboardingStep.LINEAR_CONNECT)
        if any(record.online for record in self.store.list_runtime_records()) and OnboardingStep.RUNTIME_ENROLLMENT not in completed:
            completed.append(OnboardingStep.RUNTIME_ENROLLMENT)
        return self._save(workspace_id, completed, progress.metadata)

    def complete_step(self, workspace_id: str, step: OnboardingStep) -> OnboardingProgress:
        progress = self.store.get_or_create_onboarding_progress(workspace_id)
        completed = list(progress.completed_steps)
        if step not in completed and step != OnboardingStep.COMPLETE:
            completed.append(step)
        return self._save(workspace_id, completed, progress.metadata)

    def save_scope(self, workspace_id: str, scope: dict[str, Any]) -> OnboardingProgress:
        progress = self.complete_step(workspace_id, OnboardingStep.SCOPE_SELECTION)
        metadata = {**progress.metadata, "scope": scope}
        return self._save(workspace_id, progress.completed_steps, metadata)

    def save_repository(self, workspace_id: str, mode: str, value: str) -> tuple[RepositoryMapping, OnboardingProgress]:
        valid = mode == "local_path" or (mode == "git_url" and value.startswith(("https://", "git@")))
        mapping = RepositoryMapping(
            mode=RepositoryMappingMode(mode),
            value=value,
            validation_state=ValidationState.VALID if valid else ValidationState.INVALID,
        )
        self.store.save_repository_mapping(workspace_id, mapping)
        progress = self.get_progress(workspace_id)
        if valid:
            progress = self.complete_step(workspace_id, OnboardingStep.REPOSITORY_MAPPING)
        return mapping, progress

    def run_smoke_check(self, workspace_id: str) -> SmokeCheckResult:
        recommendations: list[str] = []
        if not self.linear_connected(workspace_id):
            recommendations.append("Connect Linear")
        if self.store.get_repository_mapping(workspace_id) is None:
            recommendations.append("Map a repository")
        if not any(record.online for record in self.store.list_runtime_records()):
            recommendations.append("Enroll an online runtime")
        status = SmokeCheckStatus.PASSED if not recommendations else SmokeCheckStatus.FAILED
        result = SmokeCheckResult(
            status=status,
            checks=[
                {"name": "linear", "passed": self.linear_connected(workspace_id)},
                {"name": "repository", "passed": self.store.get_repository_mapping(workspace_id) is not None},
                {"name": "runtime", "passed": any(record.online for record in self.store.list_runtime_records())},
            ],
            recommendations=recommendations,
            timestamp=utc_now_iso(),
        )
        self._smoke_results[workspace_id] = result
        if status == SmokeCheckStatus.PASSED:
            self.complete_step(workspace_id, OnboardingStep.SMOKE_CHECK)
        return result

    def get_smoke_result(self, workspace_id: str) -> SmokeCheckResult | None:
        return self._smoke_results.get(workspace_id)

    def _save(
        self,
        workspace_id: str,
        completed_steps: list[OnboardingStep],
        metadata: dict[str, Any],
    ) -> OnboardingProgress:
        ordered = [step for step in ORDER if step in completed_steps]
        current = OnboardingStep.COMPLETE
        for step in ORDER:
            if step not in ordered:
                current = step
                break
        progress = OnboardingProgress(
            current_step=current,
            completed_steps=ordered,
            next_action=None if current == OnboardingStep.COMPLETE else current.value,
            metadata=metadata,
        )
        self.store.save_onboarding_progress(workspace_id, progress)
        return progress
