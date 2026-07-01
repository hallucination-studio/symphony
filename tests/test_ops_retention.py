from performer_api.ops_models import OpsSnapshot, RetentionMetadata, TraceEvent
from performer_api.ops_retention import RetentionPolicy


def test_retention_policy_prunes_old_completed_raw_before_summary() -> None:
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="summary-1",
                event_type="run_completed",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="issue-1",
                retention_tier="summary",
            ),
            TraceEvent(
                event_id="trace-1",
                event_type="turn_started",
                timestamp="2026-06-30T00:01:00Z",
                issue_id="issue-1",
                retention_tier="trace",
            ),
            TraceEvent(
                event_id="trace-2",
                event_type="turn_completed",
                timestamp="2026-06-30T00:02:00Z",
                issue_id="issue-1",
                retention_tier="trace",
            ),
            TraceEvent(
                event_id="raw-old",
                event_type="stdout",
                timestamp="2026-06-30T00:03:00Z",
                issue_id="issue-1",
                retention_tier="raw",
            ),
            TraceEvent(
                event_id="raw-new",
                event_type="stderr",
                timestamp="2026-06-30T00:04:00Z",
                issue_id="issue-1",
                retention_tier="raw",
            ),
        ]
    )

    pruned = RetentionPolicy(max_raw_events=1, max_trace_events=3).apply(snapshot)

    assert [event.event_id for event in pruned.events if event.retention_tier == "summary"] == ["summary-1"]
    assert [event.event_id for event in pruned.events if event.retention_tier == "raw"] == ["raw-new"]


def test_retention_policy_keeps_pinned_issue_events() -> None:
    snapshot = OpsSnapshot(
        retention=RetentionMetadata(pinned_issue_ids=["issue-1"]),
        events=[
            TraceEvent(
                event_id="raw-pinned",
                event_type="stdout",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="issue-1",
                retention_tier="raw",
            ),
            TraceEvent(
                event_id="raw-unpinned",
                event_type="stdout",
                timestamp="2026-06-30T00:01:00Z",
                issue_id="issue-2",
                retention_tier="raw",
            ),
        ],
    )

    pruned = RetentionPolicy(max_raw_events=0, max_trace_events=0).apply(snapshot)

    assert [event.event_id for event in pruned.events] == ["raw-pinned"]
