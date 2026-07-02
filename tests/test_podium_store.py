from __future__ import annotations

from podium.models import (
    OnboardingProgress,
    OnboardingStep,
    RepositoryMapping,
    RepositoryMappingMode,
    RuntimeRecord,
    ValidationState,
)
from podium.store import PodiumStore


def test_store_persists_runtime_record_and_queries_by_id(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    record = RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="2026-01-01T00:00:00Z")
    store.save_runtime_record(record)

    reloaded = PodiumStore(data_dir=tmp_path)
    assert reloaded.get_runtime_record("rt-1") == record


def test_store_lists_runtime_records(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat=None))
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-2", online=False, last_heartbeat=None))

    ids = {r.runtime_id for r in store.list_runtime_records()}
    assert ids == {"rt-1", "rt-2"}


def test_store_update_heartbeat_creates_online_record(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    store.update_runtime_heartbeat("rt-new")
    record = store.get_runtime_record("rt-new")
    assert record is not None
    assert record.online is True
    assert record.last_heartbeat is not None


def test_store_persists_onboarding_progress(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    progress = OnboardingProgress(
        current_step=OnboardingStep.SCOPE_SELECTION,
        completed_steps=[OnboardingStep.LINEAR_CONNECT],
        next_action="Pick teams",
    )
    store.save_onboarding_progress("ws-1", progress)

    reloaded = PodiumStore(data_dir=tmp_path)
    assert reloaded.get_onboarding_progress("ws-1") == progress


def test_store_get_or_create_onboarding_defaults_to_linear_connect(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    progress = store.get_or_create_onboarding_progress("ws-new")
    assert progress.current_step == OnboardingStep.LINEAR_CONNECT
    assert progress.completed_steps == []


def test_store_persists_repository_mapping(tmp_path) -> None:
    store = PodiumStore(data_dir=tmp_path)
    mapping = RepositoryMapping(
        mode=RepositoryMappingMode.LOCAL_PATH,
        value="/srv/repo",
        validation_state=ValidationState.VALID,
    )
    store.save_repository_mapping("ws-1", mapping)

    reloaded = PodiumStore(data_dir=tmp_path)
    assert reloaded.get_repository_mapping("ws-1") == mapping
