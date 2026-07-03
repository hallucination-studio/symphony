from __future__ import annotations

from podium.models import RunStatus, RunSummary, RuntimeRecord
from podium.runtime_service import RuntimeService
from podium.store import PodiumStore


def _service() -> tuple[RuntimeService, PodiumStore]:
    store = PodiumStore()
    return RuntimeService(store), store


def test_enrollment_status_accepts_external_token_pending_state() -> None:
    service, _ = _service()
    assert service.enrollment_status("ws-1", token_pending=True)["token_pending"] is True
    assert service.enrollment_status("ws-1", token_pending=False)["token_pending"] is False


def test_enrollment_status_reports_online_runtimes() -> None:
    service, store = _service()
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now"))
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-2", online=False, last_heartbeat=None))

    status = service.enrollment_status("ws-1")
    assert status["runtime_count"] == 2
    assert status["online_count"] == 1
    assert status["enrolled"] is True


def test_list_runtimes_returns_all_records() -> None:
    service, store = _service()
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now"))
    ids = {r.runtime_id for r in service.list_runtimes()}
    assert ids == {"rt-1"}


def test_get_runtime_returns_detail() -> None:
    service, store = _service()
    store.save_runtime_record(RuntimeRecord(runtime_id="rt-1", online=True, last_heartbeat="now", version="1.0"))
    record = service.get_runtime("rt-1")
    assert record is not None
    assert record.version == "1.0"


def test_record_heartbeat_marks_runtime_online() -> None:
    service, store = _service()
    service.record_heartbeat("rt-new")
    record = store.get_runtime_record("rt-new")
    assert record is not None
    assert record.online is True


def test_recent_runs_returns_newest_first_limited() -> None:
    service, _ = _service()
    for i in range(5):
        service.record_run(
            RunSummary(
                run_id=f"run-{i}",
                issue_identifier=f"ENG-{i}",
                runtime_id="rt-1",
                status=RunStatus.SUCCESS,
                started_at=f"2026-01-0{i+1}T00:00:00Z",
                completed_at=None,
                duration_seconds=None,
            )
        )
    recent = service.recent_runs(limit=3)
    assert [r.run_id for r in recent] == ["run-4", "run-3", "run-2"]


def test_get_run_returns_detail() -> None:
    service, _ = _service()
    service.record_run(
        RunSummary(
            run_id="run-1",
            issue_identifier="ENG-1",
            runtime_id="rt-1",
            status=RunStatus.FAILED,
            started_at="2026-01-01T00:00:00Z",
            completed_at="2026-01-01T00:01:00Z",
            duration_seconds=60.0,
            failure_reason="boom",
        )
    )
    run = service.get_run("run-1")
    assert run is not None
    assert run.failure_reason == "boom"
