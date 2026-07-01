from performer_api.ops_models import AttemptRecord, IssueRecord, OpsSnapshot, RunRecord, TraceEvent, TurnRecord
from performer_api.ops_projection import build_issue_detail, build_issue_list, build_run_detail, build_trace_stream


def sample_snapshot() -> OpsSnapshot:
    return OpsSnapshot(
        issues={
            "issue-1": IssueRecord(
                issue_id="issue-1",
                issue_identifier="ENG-1",
                title="Trace UI",
                state="stalled",
                total_turn_count=7,
                total_tokens=188240,
                total_estimated_cost_usd=0.97,
                failure_reason="no Codex output arrived for 14 minutes after a tool timeout",
                last_activity_at="2026-06-30T00:10:00Z",
            ),
            "issue-2": IssueRecord(
                issue_id="issue-2",
                issue_identifier="ENG-2",
                title="Backend",
                state="completed",
                last_activity_at="2026-06-30T00:05:00Z",
            ),
        },
        runs={
            "run-1": RunRecord(
                run_id="run-1",
                issue_id="issue-1",
                instance_id="inst-1",
                status="stalled",
                turn_count=7,
                attempt_count=2,
                total_tokens=188240,
                estimated_cost_usd=0.97,
                failure_summary="no Codex output arrived for 14 minutes after a tool timeout",
                last_activity_at="2026-06-30T00:10:00Z",
            ),
            "run-2": RunRecord(
                run_id="run-2",
                issue_id="issue-2",
                instance_id="inst-1",
                status="completed",
                last_activity_at="2026-06-30T00:05:00Z",
            ),
        },
        attempts={
            "attempt-1": AttemptRecord(
                attempt_id="attempt-1",
                run_id="run-1",
                attempt_number=1,
                status="failed",
            ),
            "attempt-2": AttemptRecord(
                attempt_id="attempt-2",
                run_id="run-1",
                attempt_number=2,
                status="stalled",
            ),
        },
        turns={
            f"turn-{index}": TurnRecord(
                turn_id=f"turn-{index}",
                attempt_id="attempt-2",
                turn_number=index,
                status="completed" if index < 7 else "stalled",
            )
            for index in range(1, 8)
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="issue_dispatched",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="issue-1",
                run_id="run-1",
                retention_tier="summary",
            ),
            TraceEvent(
                event_id="evt-2",
                event_type="tool_call_failed",
                timestamp="2026-06-30T00:09:00Z",
                issue_id="issue-1",
                run_id="run-1",
                retention_tier="trace",
            ),
            TraceEvent(
                event_id="evt-3",
                event_type="run_completed",
                timestamp="2026-06-30T00:05:00Z",
                issue_id="issue-2",
                run_id="run-2",
                retention_tier="summary",
            ),
        ],
    )


def test_issue_list_orders_by_last_activity_descending() -> None:
    issues = build_issue_list(sample_snapshot())

    assert [issue.issue_identifier for issue in issues] == ["ENG-1", "ENG-2"]


def test_issue_detail_includes_human_reason_and_metrics() -> None:
    detail = build_issue_detail(sample_snapshot(), "issue-1")

    assert detail["metrics"]["turns"] == 7
    assert detail["metrics"]["attempts"] == 2
    assert detail["latest_run"]["run_id"] == "run-1"
    assert "no Codex output" in detail["state_explanation"]


def test_run_detail_includes_attempts_turns_and_timeline() -> None:
    detail = build_run_detail(sample_snapshot(), "run-1")

    assert detail["run"]["run_id"] == "run-1"
    assert len(detail["attempts"]) == 2
    assert len(detail["turns"]) == 7
    assert detail["events"][0]["event_type"] == "issue_dispatched"


def test_trace_stream_filters_by_run_id() -> None:
    events = build_trace_stream(sample_snapshot(), run_id="run-1")

    assert all(event.run_id == "run-1" for event in events)
    assert [event.event_id for event in events] == ["evt-1", "evt-2"]
