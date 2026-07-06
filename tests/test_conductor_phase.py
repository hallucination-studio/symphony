from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
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


def test_dispatch_dependency_metadata_rebuilds_from_event_log(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)

    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id="dispatch-2",
        blocked_by=["issue-1", "issue-1", ""],
        parent_issue_id="parent-1",
    )

    assert run.blocked_by == ["issue-1"]
    assert run.parent_issue_id == "parent-1"
    assert store.rebuild_run(run.run_id) == run
    assert store.list_orchestration_events(run.run_id)[0].payload["blocked_by"] == ["issue-1"]


def test_duplicate_dispatch_updates_dependency_metadata_through_event_log(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    first = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id="dispatch-1",
        blocked_by=["issue-1"],
        parent_issue_id="parent-1",
    )

    second = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id="dispatch-2",
        blocked_by=[],
        parent_issue_id="parent-2",
    )

    assert second.run_id == first.run_id
    assert second.blocked_by == []
    assert second.parent_issue_id == "parent-2"
    assert store.rebuild_run(first.run_id) == second


def test_store_reopens_terminal_issue_dispatch_as_new_epoch(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    first = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(first.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    completed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=first.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )

    second = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-2",
    )

    assert completed.run_id == first.run_id
    assert second.run_id != first.run_id
    assert second.epoch == 2
    assert second.phase is RunPhase.QUEUED
    assert store.get_orchestration_run(first.run_id) is not None
    assert store.get_orchestration_run_by_issue("inst-1", "issue-1") == second
    assert [event.event_type for event in store.list_orchestration_events(first.run_id)] == [
        "dispatch.created",
        "performer.started",
        "performer.result",
    ]
    assert [event.event_type for event in store.list_orchestration_events(second.run_id)] == ["dispatch.created"]


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


def test_store_lists_reviewing_phase_run_as_due_after_implementation_result(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="gated-task",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="ready_for_review",
            reason="implementation_ready_for_review",
        )
    )

    rows = store.list_due_orchestration_runs()

    assert [row.run_id for row in rows] == [run.run_id]
    assert rows[0].phase is RunPhase.REVIEWING
    assert rows[0].status == RunStatus.QUEUED


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
    assert store.rebuild_run(run.run_id) == completed


def test_apply_event_is_the_only_phase_projection_writer(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )

    updated = store.apply_event(
        run.run_id,
        {
            "event_type": "performer.started",
            "to_phase": RunPhase.IMPLEMENTING,
            "payload": {
                "status": RunStatus.RUNNING,
                "request_path": "/tmp/request.json",
                "result_path": "/tmp/result.json",
                "process_pid": 123,
                "next_run_at": None,
                "last_error": None,
            },
        },
    )

    assert updated.phase is RunPhase.IMPLEMENTING
    assert updated.status == RunStatus.RUNNING
    assert store.rebuild_run(run.run_id) == updated


def test_apply_event_rejects_concurrent_stale_phase_transition_atomically(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )

    def submit(to_phase: RunPhase) -> tuple[str, RunPhase | str]:
        try:
            updated = store.apply_event(
                run.run_id,
                {
                    "event_type": f"test.{to_phase.value}",
                    "to_phase": to_phase,
                    "payload": {"status": RunStatus.RUNNING if to_phase is RunPhase.IMPLEMENTING else RunStatus.FAILED},
                },
                expected_current_phases={RunPhase.QUEUED},
            )
            return ("accepted", updated.phase)
        except PhaseTransitionError as exc:
            return ("rejected", str(exc))

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(submit, [RunPhase.IMPLEMENTING, RunPhase.FAILED]))

    accepted = [value for status, value in outcomes if status == "accepted"]
    rejected = [value for status, value in outcomes if status == "rejected"]
    events = store.list_orchestration_events(run.run_id)

    assert len(accepted) == 1
    assert len(rejected) == 1
    assert "Expected run" in str(rejected[0])
    assert [event.event_type for event in events].count("test.implementing") + [
        event.event_type for event in events
    ].count("test.failed") == 1
    assert store.rebuild_run(run.run_id) == store.get_orchestration_run(run.run_id)


def test_rebuild_run_matches_incremental_projection_across_event_types(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, overload_limit=1)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-1.json", result_path="/tmp/result-1.json")
    retry = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="upstream_overloaded",
            reason="upstream_overloaded_exhausted",
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-2.json", result_path="/tmp/result-2.json")
    failed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="upstream_overloaded",
            reason="upstream_overloaded_exhausted",
        )
    )
    with_human_action = store.apply_event(
        run.run_id,
        {
            "event_type": "human.failure_child_created",
            "to_phase": RunPhase.FAILED,
            "payload": {"human_action": {"child_issue_id": "child-1", "kind": "runtime_error"}},
        },
    )

    assert retry.phase is RunPhase.QUEUED
    assert failed.phase is RunPhase.FAILED
    assert with_human_action.human_action["child_issue_id"] == "child-1"
    assert store.rebuild_run(run.run_id) == store.get_orchestration_run(run.run_id)


def test_phase_reducer_starts_reviewing_phase_without_rewriting_to_implementation(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="gated-task",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="ready_for_review",
            reason="implementation_ready_for_review",
        )
    )

    started = reducer.performer_started(
        run.run_id,
        request_path="/tmp/review-request.json",
        result_path="/tmp/review-result.json",
        pid=456,
    )

    assert started.phase is RunPhase.REVIEWING
    assert started.status == RunStatus.RUNNING
    assert started.request_path == "/tmp/review-request.json"


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


def test_phase_reducer_preserves_raw_detail_and_http_status_on_retry(tmp_path: Path) -> None:
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
            reason="upstream_overloaded_exhausted",
            detail="upstream 502: server overloaded raw body",
            http_status=502,
            retry_delay_seconds=45,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )
    events = store.list_orchestration_events(run.run_id)

    assert queued.last_reason == "upstream_overloaded_exhausted"
    assert queued.last_error == "upstream 502: server overloaded raw body"
    assert events[-1].payload["detail"] == "upstream 502: server overloaded raw body"
    assert events[-1].payload["http_status"] == 502


def test_phase_reducer_counts_upstream_overload_independently(tmp_path: Path) -> None:
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
            status="upstream_overloaded",
            reason="upstream_overloaded_exhausted",
            detail="JSON-RPC error -32000: upstream 502: server overloaded",
            http_status=502,
            retry_delay_seconds=1,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )
    events = store.list_orchestration_events(run.run_id)

    assert queued.phase is RunPhase.QUEUED
    assert queued.status == RunStatus.QUEUED
    assert queued.attempt == 2
    assert queued.overload_count == 1
    assert queued.retry_count == 0
    assert queued.crash_count == 0
    assert queued.init_failure_count == 0
    assert queued.last_error == "JSON-RPC error -32000: upstream 502: server overloaded"
    assert queued.next_run_at == "2026-07-04T00:00:05Z"
    assert events[-1].event_type == "performer.upstream_overloaded"
    assert events[-1].payload["overload_count"] == 1


def test_phase_reducer_overload_circuit_breaker_is_separate_from_retry_budget(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, overload_limit=1)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-1.json", result_path="/tmp/result-1.json")
    first = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="upstream_overloaded",
            reason="upstream_overloaded_exhausted",
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-2.json", result_path="/tmp/result-2.json")
    failed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="upstream_overloaded",
            reason="upstream_overloaded_exhausted",
        )
    )

    assert first.phase is RunPhase.QUEUED
    assert failed.phase is RunPhase.FAILED
    assert failed.status == RunStatus.FAILED
    assert failed.overload_count == 2
    assert failed.retry_count == 0
    assert failed.crash_count == 0
    assert failed.init_failure_count == 0
    assert failed.last_error == "upstream overload exhausted repeatedly"


def test_phase_reducer_counts_retries_only_from_phase_results(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )

    reducer.performer_started(run.run_id, request_path="/tmp/request-1.json", result_path="/tmp/result-1.json")
    first_retry = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason="verification_failed",
            retry_delay_seconds=5,
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-2.json", result_path="/tmp/result-2.json")
    second_retry = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason="verification_failed_again",
            retry_delay_seconds=5,
        )
    )

    assert first_retry.retry_count == 1
    assert first_retry.attempt == 2
    assert second_retry.retry_count == 2
    assert second_retry.attempt == 3
    assert second_retry.crash_count == 0


def test_phase_reducer_counts_init_failures_independently_from_retries_and_crashes(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, init_failure_limit=5)
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
            status="init_failed",
            reason="codex_init_failed",
            retry_delay_seconds=1,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )
    events = store.list_orchestration_events(run.run_id)

    assert queued.phase is RunPhase.QUEUED
    assert queued.status == RunStatus.QUEUED
    assert queued.attempt == 2
    assert queued.init_failure_count == 1
    assert queued.retry_count == 0
    assert queued.crash_count == 0
    assert queued.next_run_at == "2026-07-04T00:00:05Z"
    assert events[-1].event_type == "performer.init_failed"
    assert events[-1].payload["init_failure_count"] == 1


def test_phase_reducer_init_failure_circuit_breaker_is_separate_from_retry_budget(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, init_failure_limit=2)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )

    reducer.performer_started(run.run_id, request_path="/tmp/request-1.json", result_path="/tmp/result-1.json")
    first = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="init_failed",
            reason="codex_init_failed",
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-2.json", result_path="/tmp/result-2.json")
    retry = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="retry",
            reason="verification_failed",
            retry_delay_seconds=5,
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-3.json", result_path="/tmp/result-3.json")
    second = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="init_failed",
            reason="codex_init_failed",
        )
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request-4.json", result_path="/tmp/result-4.json")
    failed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="init_failed",
            reason="codex_init_failed",
        )
    )

    assert first.init_failure_count == 1
    assert retry.retry_count == 1
    assert retry.init_failure_count == 1
    assert second.init_failure_count == 2
    assert second.phase is RunPhase.QUEUED
    assert failed.phase is RunPhase.FAILED
    assert failed.status == RunStatus.FAILED
    assert failed.init_failure_count == 3
    assert failed.retry_count == 1
    assert failed.crash_count == 0
    assert failed.last_error == "codex init failed repeatedly"


def test_phase_reducer_terminal_init_failure_fails_fast_without_retry_budget(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store, init_failure_limit=5)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")

    failed = reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.QUEUED,
            status="init_failed",
            reason="invalid_sdk_codex_bin",
        )
    )

    assert failed.phase is RunPhase.FAILED
    assert failed.status == RunStatus.FAILED
    assert failed.init_failure_count == 1
    assert failed.retry_count == 0
    assert failed.crash_count == 0
    assert failed.next_run_at is None
    assert failed.last_error == "invalid_sdk_codex_bin"


def test_phase_reducer_requeues_retry_result_with_minimum_delay(tmp_path: Path) -> None:
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
            retry_delay_seconds=0,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )

    assert queued.phase is RunPhase.QUEUED
    assert queued.status == RunStatus.QUEUED
    assert queued.next_run_at == "2026-07-04T00:00:05Z"


def test_phase_reducer_backs_off_already_claimed_result(tmp_path: Path) -> None:
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
            reason="already_running_or_claimed",
            retry_delay_seconds=0,
        ),
        now=datetime(2026, 7, 4, tzinfo=timezone.utc),
    )

    assert queued.next_run_at == "2026-07-04T00:00:30Z"


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
