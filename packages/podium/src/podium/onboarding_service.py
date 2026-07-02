from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from podium.models import (
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RepositoryMappingMode,
    SmokeCheckResult,
    SmokeCheckStatus,
    ValidationState,
)
from podium.store import PodiumStore

# Ordered onboarding steps (drives the state machine progression)
STEP_ORDER: list[OnboardingStep] = [
    OnboardingStep.LINEAR_CONNECT,
    OnboardingStep.SCOPE_SELECTION,
    OnboardingStep.REPOSITORY_MAPPING,
    OnboardingStep.RUNTIME_ENROLLMENT,
    OnboardingStep.SMOKE_CHECK,
    OnboardingStep.COMPLETE,
]

# Human-readable next action for each step
NEXT_ACTION: dict[OnboardingStep, str] = {
    OnboardingStep.LINEAR_CONNECT: "Connect your Linear workspace to get started",
    OnboardingStep.SCOPE_SELECTION: "Select the teams and projects to route",
    OnboardingStep.REPOSITORY_MAPPING: "Map your repository (local path or git URL)",
    OnboardingStep.RUNTIME_ENROLLMENT: "Install and enroll a runtime agent",
    OnboardingStep.SMOKE_CHECK: "Run a smoke check to verify everything works",
    OnboardingStep.COMPLETE: "Onboarding complete",
}


class OnboardingService:
    """
    Onboarding state machine.

    Drives a workspace through the setup steps in order:
    linear_connect -> scope_selection -> repository_mapping ->
    runtime_enrollment -> smoke_check -> complete

    Each completed step advances current_step to the next incomplete step
    and updates the human-readable next_action.
    """

    def __init__(self, store: PodiumStore, linear_connected: Callable[[str], bool] | None = None):
        self.store = store
        # Callable to check Linear connection for a workspace. Defaults to the
        # store's own installation record. The server injects a LinearService-backed
        # checker so OAuth installations are the single source of truth.
        self._linear_connected = linear_connected or (
            lambda workspace_id: self.store.get_linear_installation(workspace_id) is not None
        )
        # workspace_id -> latest SmokeCheckResult
        self._smoke_results: dict[str, SmokeCheckResult] = {}

    def get_progress(self, workspace_id: str) -> OnboardingProgress:
        """Get current onboarding progress, creating a default if none exists."""
        return self.store.get_or_create_onboarding_progress(workspace_id)

    def complete_step(self, workspace_id: str, step: OnboardingStep, **metadata: Any) -> OnboardingProgress:
        """
        Mark a step complete and advance to the next incomplete step.

        Returns the updated progress.
        """
        progress = self.store.get_or_create_onboarding_progress(workspace_id)
        completed = list(progress.completed_steps)
        if step not in completed:
            completed.append(step)

        # Determine next step: first step (in order) not yet completed
        next_step = OnboardingStep.COMPLETE
        for candidate in STEP_ORDER:
            if candidate == OnboardingStep.COMPLETE:
                next_step = OnboardingStep.COMPLETE
                break
            if candidate not in completed:
                next_step = candidate
                break

        merged_metadata = dict(progress.metadata)
        merged_metadata.update(metadata)

        updated = OnboardingProgress(
            current_step=next_step,
            completed_steps=completed,
            next_action=NEXT_ACTION[next_step],
            metadata=merged_metadata,
        )
        self.store.save_onboarding_progress(workspace_id, updated)
        return updated

    def save_scope(self, workspace_id: str, scope: dict[str, Any]) -> OnboardingProgress:
        """Save the user's team/project scope selection and advance."""
        return self.complete_step(
            workspace_id,
            OnboardingStep.SCOPE_SELECTION,
            scope=scope,
        )

    def save_repository(self, workspace_id: str, mode: str, value: str) -> tuple[RepositoryMapping, OnboardingProgress]:
        """
        Save a repository mapping and advance onboarding.

        Validates the mapping mode. Returns the mapping and updated progress.
        """
        mapping_mode = RepositoryMappingMode(mode)
        validation_state, message = self._validate_repository(mapping_mode, value)
        mapping = RepositoryMapping(
            mode=mapping_mode,
            value=value,
            validation_state=validation_state,
            validation_message=message,
        )
        self.store.save_repository_mapping(workspace_id, mapping)

        # Only advance if the mapping is valid
        if validation_state == ValidationState.VALID:
            progress = self.complete_step(workspace_id, OnboardingStep.REPOSITORY_MAPPING)
        else:
            progress = self.store.get_or_create_onboarding_progress(workspace_id)
        return mapping, progress

    def run_smoke_check(self, workspace_id: str) -> SmokeCheckResult:
        """
        Run smoke checks against the workspace configuration.

        Checks Linear connection, repository mapping, and runtime enrollment.
        Stores and returns the result.
        """
        checks: list[dict[str, Any]] = []
        recommendations: list[str] = []

        # Check 1: Linear connected
        linear_ok = self._linear_connected(workspace_id)
        checks.append({"name": "linear_connection", "passed": linear_ok})
        if not linear_ok:
            recommendations.append("Connect your Linear workspace")

        # Check 2: Repository mapped and valid
        mapping = self.store.get_repository_mapping(workspace_id)
        repo_ok = mapping is not None and mapping.validation_state == ValidationState.VALID
        checks.append({"name": "repository_mapping", "passed": repo_ok})
        if not repo_ok:
            recommendations.append("Map a valid repository")

        # Check 3: At least one runtime online
        runtimes = self.store.list_runtime_records()
        runtime_ok = any(r.online for r in runtimes)
        checks.append({"name": "runtime_online", "passed": runtime_ok})
        if not runtime_ok:
            recommendations.append("Enroll and start a runtime agent")

        status = SmokeCheckStatus.PASSED if all(c["passed"] for c in checks) else SmokeCheckStatus.FAILED
        result = SmokeCheckResult(
            status=status,
            checks=checks,
            recommendations=recommendations,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        self._smoke_results[workspace_id] = result

        if status == SmokeCheckStatus.PASSED:
            self.complete_step(workspace_id, OnboardingStep.SMOKE_CHECK)

        return result

    def get_smoke_result(self, workspace_id: str) -> SmokeCheckResult | None:
        """Get the latest smoke check result for a workspace."""
        return self._smoke_results.get(workspace_id)

    # ===== Internal =====

    def _validate_repository(self, mode: RepositoryMappingMode, value: str) -> tuple[ValidationState, str | None]:
        """Validate a repository mapping value based on its mode."""
        if not value.strip():
            return ValidationState.INVALID, "Repository value is required"
        if mode == RepositoryMappingMode.GIT_URL:
            if not (value.startswith(("http://", "https://", "git@", "ssh://"))):
                return ValidationState.INVALID, "Git URL must start with http(s)://, git@, or ssh://"
        return ValidationState.VALID, None
