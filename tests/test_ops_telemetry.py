from pathlib import Path

from symphony.ops_store import OpsStore
from symphony.ops_telemetry import ExecutionTelemetryRecorder


def test_recorder_creates_run_attempt_turn_and_events(tmp_path: Path) -> None:
    store = OpsStore(tmp_path / "ops.json")
    recorder = ExecutionTelemetryRecorder(store)

    run_id = recorder.open_run(
        issue_id="issue-1",
        issue_identifier="ENG-1",
        instance_id="inst-1",
        workspace_path="/tmp/workspace/ENG-1",
        prompt_digest="abc123",
    )
    attempt_id = recorder.open_attempt(run_id, attempt_number=1, codex_session_id="thr_1-turn_1")
    turn_id = recorder.open_turn(attempt_id, turn_number=1)
    recorder.update_turn_tokens(turn_id, input_tokens=12, output_tokens=4, cached_tokens=2, total_tokens=18)
    recorder.finish_turn(turn_id, status="completed", stop_reason="completed")
    recorder.finish_run(run_id, status="completed", failure_code=None, failure_summary=None)

    snapshot = store.load()
    assert snapshot.issues["issue-1"].issue_identifier == "ENG-1"
    assert snapshot.runs[run_id].turn_count == 1
    assert snapshot.runs[run_id].total_tokens == 18
    assert snapshot.attempts[attempt_id].turn_count == 1
    assert snapshot.turns[turn_id].cached_tokens == 2
    assert snapshot.events[-1].event_type == "run_completed"


def test_recorder_appends_explicit_trace_events(tmp_path: Path) -> None:
    store = OpsStore(tmp_path / "ops.json")
    recorder = ExecutionTelemetryRecorder(store)
    event = recorder.make_event(
        "issue_dispatched",
        issue_id="issue-1",
        retention_tier="summary",
        summary="Dispatched ENG-1 to worker_host=local",
    )

    recorder.record_event(event)

    loaded = store.load()
    assert loaded.events[0].event_id == "evt-1"
    assert loaded.events[0].event_type == "issue_dispatched"
    assert loaded.events[0].retention_tier == "summary"
