from __future__ import annotations

from dataclasses import replace
from datetime import timezone
from typing import Any

from performer_api.models import utc_now
from performer_api.ops_models import AttemptRecord, IssueRecord, RunRecord, TraceEvent, TurnRecord
from performer_api.ops_store import OpsStore


class ExecutionTelemetryRecorder:
    def __init__(self, store: OpsStore):
        self.store = store

    def open_run(
        self,
        issue_id: str,
        issue_identifier: str,
        instance_id: str,
        workspace_path: str,
        prompt_digest: str,
        *,
        title: str = "",
    ) -> str:
        snapshot = self.store.load()
        run_id = f"run-{issue_id}-{len(snapshot.runs) + 1}"
        now = _utc_now_iso()
        snapshot.issues[issue_id] = IssueRecord(
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            title=title or issue_identifier,
            state="running",
            run_count=sum(1 for run in snapshot.runs.values() if run.issue_id == issue_id) + 1,
            last_activity_at=now,
        )
        snapshot.runs[run_id] = RunRecord(
            run_id=run_id,
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            instance_id=instance_id,
            workspace_path=workspace_path,
            prompt_digest=prompt_digest,
            status="running",
            started_at=now,
            last_activity_at=now,
        )
        snapshot.events.append(
            self.make_event("run_started", issue_id=issue_id, run_id=run_id, retention_tier="summary")
        )
        self.store.save(snapshot)
        return run_id

    def open_attempt(
        self, run_id: str, attempt_number: int, codex_session_id: str | None = None
    ) -> str:
        snapshot = self.store.load()
        run = snapshot.runs[run_id]
        attempt_id = f"attempt-{run_id}-{attempt_number}"
        now = _utc_now_iso()
        snapshot.attempts[attempt_id] = AttemptRecord(
            attempt_id=attempt_id,
            run_id=run_id,
            attempt_number=attempt_number,
            status="running",
            codex_session_id=codex_session_id,
            started_at=now,
            last_activity_at=now,
        )
        snapshot.runs[run_id] = replace(run, attempt_count=run.attempt_count + 1, last_activity_at=now)
        snapshot.events.append(
            self.make_event(
                "attempt_started",
                issue_id=run.issue_id,
                run_id=run_id,
                attempt_id=attempt_id,
                retention_tier="trace",
            )
        )
        self.store.save(snapshot)
        return attempt_id

    def open_turn(self, attempt_id: str, turn_number: int) -> str:
        snapshot = self.store.load()
        attempt = snapshot.attempts[attempt_id]
        run = snapshot.runs[attempt.run_id]
        turn_id = f"turn-{attempt_id}-{turn_number}"
        now = _utc_now_iso()
        snapshot.turns[turn_id] = TurnRecord(
            turn_id=turn_id,
            attempt_id=attempt_id,
            turn_number=turn_number,
            status="running",
            started_at=now,
            last_activity_at=now,
        )
        snapshot.events.append(
            self.make_event(
                "turn_started",
                issue_id=run.issue_id,
                run_id=run.run_id,
                attempt_id=attempt_id,
                turn_id=turn_id,
                retention_tier="trace",
            )
        )
        self.store.save(snapshot)
        return turn_id

    def record_event(self, event: TraceEvent) -> None:
        snapshot = self.store.load()
        snapshot.events.append(event)
        self.store.save(snapshot)

    def update_turn_tokens(
        self,
        turn_id: str,
        *,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int,
        total_tokens: int,
    ) -> None:
        snapshot = self.store.load()
        turn = snapshot.turns[turn_id]
        attempt = snapshot.attempts[turn.attempt_id]
        run = snapshot.runs[attempt.run_id]
        issue = snapshot.issues.get(run.issue_id)
        now = _utc_now_iso()
        snapshot.turns[turn_id] = replace(
            turn,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            total_tokens=total_tokens,
            last_activity_at=now,
        )
        snapshot.attempts[attempt.attempt_id] = replace(
            attempt,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            total_tokens=total_tokens,
            last_activity_at=now,
        )
        snapshot.runs[run.run_id] = replace(
            run,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            total_tokens=total_tokens,
            last_activity_at=now,
        )
        if issue is not None:
            snapshot.issues[issue.issue_id] = replace(
                issue,
                total_input_tokens=input_tokens,
                total_output_tokens=output_tokens,
                total_cached_tokens=cached_tokens,
                total_tokens=total_tokens,
                last_activity_at=now,
            )
        snapshot.events.append(
            self.make_event(
                "turn_tokens_updated",
                issue_id=run.issue_id,
                run_id=run.run_id,
                attempt_id=attempt.attempt_id,
                turn_id=turn_id,
                payload={
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cached_tokens": cached_tokens,
                    "total_tokens": total_tokens,
                },
            )
        )
        self.store.save(snapshot)

    def finish_turn(self, turn_id: str, *, status: str, stop_reason: str | None) -> None:
        snapshot = self.store.load()
        turn = snapshot.turns[turn_id]
        attempt = snapshot.attempts[turn.attempt_id]
        run = snapshot.runs[attempt.run_id]
        issue = snapshot.issues.get(run.issue_id)
        now = _utc_now_iso()
        snapshot.turns[turn_id] = replace(
            turn,
            status=status,
            completed_at=now,
            stop_reason=stop_reason,
            last_activity_at=now,
        )
        snapshot.attempts[attempt.attempt_id] = replace(
            attempt,
            status=status,
            completed_at=now if status in {"completed", "failed"} else attempt.completed_at,
            stop_reason=stop_reason,
            turn_count=max(attempt.turn_count, turn.turn_number),
            last_activity_at=now,
        )
        snapshot.runs[run.run_id] = replace(
            run,
            turn_count=max(run.turn_count, turn.turn_number),
            last_activity_at=now,
        )
        if issue is not None:
            snapshot.issues[issue.issue_id] = replace(
                issue,
                total_turn_count=max(issue.total_turn_count, turn.turn_number),
                last_activity_at=now,
            )
        snapshot.events.append(
            self.make_event(
                f"turn_{status}",
                issue_id=run.issue_id,
                run_id=run.run_id,
                attempt_id=attempt.attempt_id,
                turn_id=turn_id,
                retention_tier="summary" if status in {"completed", "failed"} else "trace",
                summary=stop_reason,
            )
        )
        self.store.save(snapshot)

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        failure_code: str | None,
        failure_summary: str | None,
    ) -> None:
        snapshot = self.store.load()
        run = snapshot.runs[run_id]
        issue = snapshot.issues.get(run.issue_id)
        now = _utc_now_iso()
        snapshot.runs[run_id] = replace(
            run,
            status=status,
            completed_at=now,
            failure_code=failure_code,
            failure_summary=failure_summary,
            last_activity_at=now,
        )
        if issue is not None:
            snapshot.issues[issue.issue_id] = replace(
                issue,
                state=status,
                failure_reason=failure_summary,
                last_activity_at=now,
            )
        snapshot.events.append(
            self.make_event(
                f"run_{status}",
                issue_id=run.issue_id,
                run_id=run_id,
                retention_tier="summary",
                summary=failure_summary,
            )
        )
        self.store.save(snapshot)

    def finish_latest_open_for_issue(
        self,
        issue_id: str,
        *,
        status: str,
        failure_code: str | None = None,
        failure_summary: str | None = None,
    ) -> None:
        snapshot = self.store.load()
        open_runs = [
            run
            for run in snapshot.runs.values()
            if run.issue_id == issue_id and run.status == "running"
        ]
        if not open_runs:
            return
        run = open_runs[-1]
        now = _utc_now_iso()
        open_attempts = [
            attempt
            for attempt in snapshot.attempts.values()
            if attempt.run_id == run.run_id and attempt.status == "running"
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
            for turn in list(snapshot.turns.values()):
                if turn.attempt_id != attempt.attempt_id or turn.status != "running":
                    continue
                snapshot.turns[turn.turn_id] = replace(
                    turn,
                    status=status,
                    completed_at=now,
                    stop_reason=failure_summary,
                    last_activity_at=now,
                )
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
        snapshot.events.append(
            self.make_event(
                f"run_{status}",
                issue_id=run.issue_id,
                run_id=run.run_id,
                retention_tier="summary",
                summary=failure_summary,
            )
        )
        self.store.save(snapshot)

    def make_event(
        self,
        event_type: str,
        *,
        issue_id: str | None = None,
        run_id: str | None = None,
        attempt_id: str | None = None,
        turn_id: str | None = None,
        retention_tier: str = "trace",
        summary: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> TraceEvent:
        return TraceEvent(
            event_id=self.next_event_id(),
            event_type=event_type,
            timestamp=_utc_now_iso(),
            issue_id=issue_id,
            run_id=run_id,
            attempt_id=attempt_id,
            turn_id=turn_id,
            retention_tier=retention_tier,
            summary=summary,
            payload=payload or {},
        )

    def next_event_id(self) -> str:
        snapshot = self.store.load()
        return f"evt-{len(snapshot.events) + 1}"


def _utc_now_iso() -> str:
    return utc_now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
