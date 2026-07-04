from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conductor.conductor_phase import (
    PhaseReducer,
    PhaseTransitionError,
    RunStatus,
)
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def test_store_upserts_duplicate_dispatch_by_instance_and_issue(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")

    first = store.upsert_orchestration_run(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    second = store.upsert_orchestration_run(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-2",
    )
    events = store.list_orchestration_events(first.run_id)

    assert first.run_id == second.run_id
    assert second.phase is RunPhase.QUEUED
    assert second.status == RunStatus.QUEUED
    assert second.dispatch_id == "dispatch-2"
    assert [event.event_type for event in events] == ["dispatch.created", "dispatch.duplicate"]


def test_store_lists_due_phase_runs_and_tracks_result_paths(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    due = store.upsert_orchestration_run(
        instance_id="inst-1",
        issue_id="due",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    later = store.upsert_orchestration_run(
        instance_id="inst-1",
        issue_id="later",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
    )
    now = datetime(2026, 7, 4, tzinfo=timezone.utc)
    store.update_orchestration_run(
        later.run_id,
        phase=RunPhase.QUEUED,
        status=RunStatus.QUEUED,
        next_run_at=_iso(now + timedelta(seconds=60)),
    )
    store.update_orchestration_run(
        due.run_id,
        phase=RunPhase.QUEUED,
        status=RunStatus.QUEUED,
        result_path="/tmp/result.json",
    )

    rows = store.list_due_orchestration_runs(now=_iso(now))

    assert [row.run_id for row in rows] == [due.run_id]
    assert rows[0].result_path == "/tmp/result.json"


def test_phase_reducer_starts_performer_and_applies_done_result(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )

    started = reducer.performer_started(
        run.run_id,
        request_path="/tmp/request.json",
        result_path="/tmp/result.json",
        pid=123,
    )
    completed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
            workspace_path="/tmp/workspace",
            ops_snapshot_path="/tmp/ops.json",
        )
    )

    assert started.phase is RunPhase.IMPLEMENTING
    assert started.status == RunStatus.RUNNING
    assert completed.phase is RunPhase.DONE
    assert completed.status == RunStatus.COMPLETED
    assert completed.ack_status == "pending"
    assert completed.workspace_path == "/tmp/workspace"
    assert [event.event_type for event in store.list_orchestration_events(run.run_id)] == [
        "dispatch.created",
        "performer.started",
        "performer.result",
    ]


def test_phase_reducer_requeues_retry_result_with_delay(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")

    queued = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason="temporary failure",
            retry_delay_seconds=45,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )

    assert queued.phase is RunPhase.QUEUED
    assert queued.status == RunStatus.QUEUED
    assert queued.attempt == 2
    assert queued.next_run_at == "2026-07-04T00:00:45Z"
    assert queued.last_reason == "temporary failure"


def test_phase_reducer_waits_for_human_and_resumes_with_response(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    waiting = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="need approval",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "child_url": "https://linear.test/ENG-2",
            },
        )
    )

    resumed = reducer.human_completed(run.run_id, human_response="Approved")

    assert waiting.phase is RunPhase.AWAITING_HUMAN
    assert waiting.status == RunStatus.WAITING
    assert resumed.phase is RunPhase.QUEUED
    assert resumed.status == RunStatus.QUEUED
    assert resumed.human_response == "Approved"
    assert resumed.human_action["child_issue_id"] == "child-1"


def test_phase_reducer_crash_retries_until_limit(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, crash_limit=3)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")

    first = reducer.performer_crashed(
        run.run_id,
        exit_code=1,
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-2.json", result_path="/tmp/result-2.json")
    second = reducer.performer_crashed(
        run.run_id,
        exit_code=1,
        now=datetime(2026, 7, 4, 0, 0, 5, tzinfo=timezone.utc),
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-3.json", result_path="/tmp/result-3.json")
    third = reducer.performer_crashed(
        run.run_id,
        exit_code=1,
        now=datetime(2026, 7, 4, 0, 0, 10, tzinfo=timezone.utc),
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-4.json", result_path="/tmp/result-4.json")
    failed = reducer.performer_crashed(
        run.run_id,
        exit_code=1,
        now=datetime(2026, 7, 4, 0, 0, 15, tzinfo=timezone.utc),
    )

    assert first.phase is RunPhase.QUEUED
    assert second.next_run_at == "2026-07-04T00:00:15Z"
    assert third.next_run_at == "2026-07-04T00:00:30Z"
    assert failed.phase is RunPhase.FAILED
    assert failed.status == RunStatus.FAILED
    assert failed.crash_count == 4


def test_phase_reducer_rejects_stale_result_for_wrong_phase(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )

    with pytest.raises(PhaseTransitionError):
        reducer.performer_result(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.DONE,
                status="completed",
                reason="too early",
            )
        )
