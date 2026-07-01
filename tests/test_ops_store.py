from pathlib import Path

from performer_api.ops_models import IssueRecord, OpsSnapshot, RunRecord, TraceEvent
from performer_api.ops_store import OpsStore


def test_ops_store_round_trips_snapshot(tmp_path: Path) -> None:
    store = OpsStore(tmp_path / "ops.json")
    snapshot = OpsSnapshot(
        issues={
            "issue-1": IssueRecord(
                issue_id="issue-1",
                issue_identifier="ENG-1",
                title="Trace UI",
                state="running",
            )
        },
        runs={
            "run-1": RunRecord(
                run_id="run-1",
                issue_id="issue-1",
                instance_id="inst-1",
                status="running",
            )
        },
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="issue_dispatched",
                timestamp="2026-06-30T00:00:00Z",
                issue_id="issue-1",
            )
        ],
    )

    store.save(snapshot)
    loaded = store.load()

    assert loaded.issues["issue-1"].issue_identifier == "ENG-1"
    assert loaded.runs["run-1"].instance_id == "inst-1"
    assert loaded.events[0].event_type == "issue_dispatched"


def test_ops_store_loads_empty_snapshot_when_file_is_missing(tmp_path: Path) -> None:
    store = OpsStore(tmp_path / "missing" / "ops.json")

    snapshot = store.load()

    assert snapshot.issues == {}
    assert snapshot.runs == {}
    assert snapshot.events == []
