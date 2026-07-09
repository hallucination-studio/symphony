from __future__ import annotations

from dataclasses import replace

from performer_api.ops_models import TraceEvent


def finish_latest_open_for_issue_snapshot(
    snapshot,
    issue_id: str,
    *,
    status: str,
    failure_code: str | None,
    failure_summary: str | None,
    now: str,
    event: TraceEvent,
) -> None:
    open_runs = [run for run in snapshot.runs.values() if run.issue_id == issue_id and run.status == "running"]
    if not open_runs:
        return
    run = open_runs[-1]
    _finish_open_attempts(snapshot, run.run_id, status, failure_code, failure_summary, now)
    snapshot.runs[run.run_id] = replace(
        run,
        status=status,
        completed_at=now,
        failure_code=failure_code,
        failure_summary=failure_summary,
        last_activity_at=now,
    )
    issue = snapshot.issues.get(run.issue_id)
    if issue is not None:
        snapshot.issues[issue.issue_id] = replace(
            issue,
            state=status,
            failure_reason=failure_summary,
            last_activity_at=now,
        )
    snapshot.events.append(event)


def _finish_open_attempts(snapshot, run_id, status, failure_code, failure_summary, now) -> None:
    open_attempts = [
        attempt for attempt in snapshot.attempts.values() if attempt.run_id == run_id and attempt.status == "running"
    ]
    for attempt in open_attempts:
        snapshot.attempts[attempt.attempt_id] = replace(
            attempt,
            status=status,
            completed_at=now,
            failure_code=failure_code,
            failure_summary=failure_summary,
            last_activity_at=now,
        )
        _finish_open_turns(snapshot, attempt.attempt_id, status, failure_summary, now)


def _finish_open_turns(snapshot, attempt_id, status, failure_summary, now) -> None:
    for turn in list(snapshot.turns.values()):
        if turn.attempt_id != attempt_id or turn.status != "running":
            continue
        snapshot.turns[turn.turn_id] = replace(
            turn,
            status=status,
            completed_at=now,
            stop_reason=failure_summary,
            last_activity_at=now,
        )
