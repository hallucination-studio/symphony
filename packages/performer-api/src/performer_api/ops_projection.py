from __future__ import annotations

from typing import Any

from .ops_models import AttemptRecord, IssueRecord, OpsSnapshot, RunRecord, TraceEvent, TurnRecord
from .ops_reasoning import explain_issue_state


def build_issue_list(snapshot: OpsSnapshot) -> list[IssueRecord]:
    return sorted(snapshot.issues.values(), key=lambda issue: issue.last_activity_at or "", reverse=True)


def build_issue_detail(snapshot: OpsSnapshot, issue_id: str) -> dict[str, object]:
    issue = snapshot.issues[issue_id]
    runs = _runs_for_issue(snapshot, issue_id)
    latest_run = runs[0] if runs else None
    events = build_trace_stream(snapshot, issue_id=issue_id)
    last_event = events[-1] if events else None
    attempts = _attempts_for_runs(snapshot, {run.run_id for run in runs})
    turns = _turns_for_attempts(snapshot, {attempt.attempt_id for attempt in attempts})
    failure_summary = (
        (latest_run.failure_summary if latest_run is not None else None)
        or issue.failure_reason
        or (last_event.summary if last_event is not None else None)
    )
    detail: dict[str, object] = {
        "issue": issue.to_dict(),
        "issue_id": issue.issue_id,
        "issue_identifier": issue.issue_identifier,
        "title": issue.title,
        "state": issue.state,
        "status": issue.state,
        "runs": [_run_row(run) for run in runs],
        "latest_run": _run_row(latest_run) if latest_run is not None else None,
        "metrics": {
            "runs": len(runs),
            "attempts": len(attempts) or issue.attempt_count,
            "turns": len(turns) or issue.total_turn_count,
            "tool_calls": issue.tool_call_count,
            "input_tokens": issue.total_input_tokens,
            "output_tokens": issue.total_output_tokens,
            "cached_tokens": issue.total_cached_tokens,
            "total_tokens": issue.total_tokens,
            "estimated_cost_usd": issue.total_estimated_cost_usd,
            "duration_ms": issue.duration_ms,
            "retry_count": issue.retry_count,
            "time_to_first_output_ms": issue.time_to_first_output_ms,
            "time_to_first_tool_call_ms": issue.time_to_first_tool_call_ms,
            "failure_reason": failure_summary,
            "last_activity_at": issue.last_activity_at,
        },
        "events": [_event_row(event) for event in events],
        "last_event_type": last_event.event_type if last_event is not None else None,
        "failure_summary": failure_summary,
        "failure_reason": issue.failure_reason,
        "last_reason_summary": issue.failure_reason,
    }
    detail["state_explanation"] = explain_issue_state(detail)
    return detail


def build_run_detail(snapshot: OpsSnapshot, run_id: str) -> dict[str, object]:
    run = snapshot.runs[run_id]
    attempts = _attempts_for_runs(snapshot, {run_id})
    turns = _turns_for_attempts(snapshot, {attempt.attempt_id for attempt in attempts})
    events = build_trace_stream(snapshot, run_id=run_id)
    return {
        "run": _run_row(run),
        "issue": snapshot.issues.get(run.issue_id).to_dict() if run.issue_id in snapshot.issues else None,
        "attempts": [_attempt_row(attempt) for attempt in attempts],
        "turns": [_turn_row(turn) for turn in turns],
        "events": [_event_row(event) for event in events],
        "metrics": {
            "attempts": len(attempts) or run.attempt_count,
            "turns": len(turns) or run.turn_count,
            "tool_calls": run.tool_call_count,
            "input_tokens": run.input_tokens,
            "output_tokens": run.output_tokens,
            "cached_tokens": run.cached_tokens,
            "total_tokens": run.total_tokens,
            "estimated_cost_usd": run.estimated_cost_usd,
            "duration_ms": run.duration_ms,
            "retry_count": run.retry_count,
            "time_to_first_output_ms": run.time_to_first_output_ms,
            "time_to_first_tool_call_ms": run.time_to_first_tool_call_ms,
            "failure_reason": run.failure_summary,
            "last_activity_at": run.last_activity_at,
        },
    }


def build_trace_stream(
    snapshot: OpsSnapshot,
    *,
    issue_id: str | None = None,
    run_id: str | None = None,
    limit: int = 200,
) -> list[TraceEvent]:
    events = snapshot.events
    if issue_id is not None:
        events = [event for event in events if event.issue_id == issue_id]
    if run_id is not None:
        events = [event for event in events if event.run_id == run_id]
    return sorted(events, key=lambda event: event.timestamp)[-limit:]


def _runs_for_issue(snapshot: OpsSnapshot, issue_id: str) -> list[RunRecord]:
    return sorted(
        [run for run in snapshot.runs.values() if run.issue_id == issue_id],
        key=lambda run: run.last_activity_at or run.completed_at or run.started_at or "",
        reverse=True,
    )


def _attempts_for_runs(snapshot: OpsSnapshot, run_ids: set[str]) -> list[AttemptRecord]:
    return sorted(
        [attempt for attempt in snapshot.attempts.values() if attempt.run_id in run_ids],
        key=lambda attempt: (attempt.run_id, attempt.attempt_number),
    )


def _turns_for_attempts(snapshot: OpsSnapshot, attempt_ids: set[str]) -> list[TurnRecord]:
    return sorted(
        [turn for turn in snapshot.turns.values() if turn.attempt_id in attempt_ids],
        key=lambda turn: (turn.attempt_id, turn.turn_number),
    )


def _run_row(run: RunRecord | None) -> dict[str, Any] | None:
    return None if run is None else run.to_dict()


def _attempt_row(attempt: AttemptRecord) -> dict[str, Any]:
    return attempt.to_dict()


def _turn_row(turn: TurnRecord) -> dict[str, Any]:
    return turn.to_dict()


def _event_row(event: TraceEvent) -> dict[str, Any]:
    return event.to_dict()
