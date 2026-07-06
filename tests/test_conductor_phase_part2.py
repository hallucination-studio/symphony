from test_conductor_phase_support import *  # noqa: F401,F403

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
