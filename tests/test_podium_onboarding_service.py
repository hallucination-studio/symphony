from __future__ import annotations

from podium.models import (
    OnboardingStep,
    RepositoryMappingMode,
    RuntimeRecord,
    SmokeCheckStatus,
    ValidationState,
)
from podium.onboarding_service import OnboardingService
from podium.store import PodiumStore


def _service() -> tuple[OnboardingService, PodiumStore]:
    store = PodiumStore()
    return OnboardingService(store), store


def _service_with_linear(connected: set[str]) -> tuple[OnboardingService, PodiumStore]:
    """Service whose Linear-connection check is backed by an explicit set.

    Mirrors the server wiring where LinearService (not the store) is the source
    of truth for connection state.
    """
    store = PodiumStore()
    return OnboardingService(store, linear_connected=lambda ws: ws in connected), store


def test_progress_starts_at_linear_connect() -> None:
    service, _ = _service()
    progress = service.get_progress("ws-1")
    assert progress.current_step == OnboardingStep.LINEAR_CONNECT


def test_completing_linear_connect_advances_to_scope_selection() -> None:
    service, _ = _service()
    progress = service.complete_step("ws-1", OnboardingStep.LINEAR_CONNECT)
    assert progress.current_step == OnboardingStep.SCOPE_SELECTION
    assert OnboardingStep.LINEAR_CONNECT in progress.completed_steps


def test_save_scope_records_selection_and_advances() -> None:
    service, _ = _service()
    service.complete_step("ws-1", OnboardingStep.LINEAR_CONNECT)
    progress = service.save_scope("ws-1", {"teams": ["ENG"]})
    assert progress.current_step == OnboardingStep.REPOSITORY_MAPPING
    assert progress.metadata["scope"] == {"teams": ["ENG"]}


def test_save_valid_git_url_repository_advances() -> None:
    service, store = _service()
    mapping, progress = service.save_repository("ws-1", "git_url", "https://github.com/acme/repo.git")
    assert mapping.validation_state == ValidationState.VALID
    assert mapping.mode == RepositoryMappingMode.GIT_URL
    assert OnboardingStep.REPOSITORY_MAPPING in progress.completed_steps
    assert store.get_repository_mapping("ws-1") == mapping


def test_save_invalid_git_url_does_not_advance() -> None:
    service, _ = _service()
    mapping, progress = service.save_repository("ws-1", "git_url", "not-a-url")
    assert mapping.validation_state == ValidationState.INVALID
    assert OnboardingStep.REPOSITORY_MAPPING not in progress.completed_steps


def test_smoke_check_fails_when_prerequisites_missing() -> None:
    service, _ = _service()
    result = service.run_smoke_check("ws-1")
    assert result.status == SmokeCheckStatus.FAILED
    assert len(result.recommendations) == 3


def test_smoke_check_passes_when_all_prerequisites_met() -> None:
    service, store = _service_with_linear({"ws-1"})
    service.save_repository("ws-1", "local_path", "/srv/repo")
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now"))

    result = service.run_smoke_check("ws-1")
    assert result.status == SmokeCheckStatus.PASSED
    assert result.recommendations == []


def test_smoke_check_passing_completes_onboarding() -> None:
    service, store = _service_with_linear({"ws-1"})
    service.save_repository("ws-1", "local_path", "/srv/repo")
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now"))

    service.run_smoke_check("ws-1")
    progress = service.get_progress("ws-1")
    assert OnboardingStep.SMOKE_CHECK in progress.completed_steps


def test_get_smoke_result_returns_latest() -> None:
    service, _ = _service()
    assert service.get_smoke_result("ws-1") is None
    service.run_smoke_check("ws-1")
    assert service.get_smoke_result("ws-1") is not None


def test_linear_connection_marks_linear_connect_complete_on_read() -> None:
    service, _ = _service_with_linear({"ws-1"})
    progress = service.get_progress("ws-1")
    assert OnboardingStep.LINEAR_CONNECT in progress.completed_steps
    assert progress.current_step == OnboardingStep.SCOPE_SELECTION


def test_online_runtime_marks_runtime_enrollment_complete_on_read() -> None:
    service, store = _service()
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now"))
    progress = service.get_progress("ws-1")
    assert OnboardingStep.RUNTIME_ENROLLMENT in progress.completed_steps


def test_completing_later_step_does_not_snap_back_when_linear_connected() -> None:
    # Regression: with Linear connected, completing repository_mapping must not
    # reset current_step to linear_connect.
    service, _ = _service_with_linear({"ws-1"})
    service.save_scope("ws-1", {"teams": ["ENG"]})
    _, progress = service.save_repository("ws-1", "git_url", "https://github.com/acme/repo.git")
    assert progress.current_step == OnboardingStep.RUNTIME_ENROLLMENT
    assert OnboardingStep.LINEAR_CONNECT in progress.completed_steps
