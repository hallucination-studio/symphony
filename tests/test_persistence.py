from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from symphony.models import ContinuationEntry, Issue, RetryEntry, RunningEntry, RuntimeTokens, utc_now
from symphony.persistence import PersistenceStore, PersistedSession, PersistedState


def test_persistence_store_round_trips_retry_entries_and_sessions(tmp_path: Path) -> None:
    path = tmp_path / "state" / "symphony.json"
    store = PersistenceStore(path)
    due_at = utc_now() + timedelta(seconds=30)
    started_at = utc_now() - timedelta(seconds=5)
    state = PersistedState(
        retry_attempts=[
            RetryEntry(
                issue_id="issue-1",
                identifier="MT-1",
                attempt=3,
                due_at=due_at,
                due_at_ms=123456,
                error="retry poll failed",
                issue_url="https://linear.app/x/issue/MT-1",
            )
        ],
        continuations=[
            ContinuationEntry(
                issue_id="issue-3",
                identifier="MT-3",
                attempt=4,
                due_at=due_at,
                due_at_ms=234567,
                issue_url="https://linear.app/x/issue/MT-3",
                last_message="max turns reached; continuing",
            )
        ],
        sessions=[
            PersistedSession(
                issue_id="issue-2",
                issue_identifier="MT-2",
                issue_url="https://linear.app/x/issue/MT-2",
                session_id="thread-turn",
                thread_id="thread",
                turn_id="turn",
                worker_host="builder-1",
                started_at=started_at,
                last_event="turn_completed",
                last_message="done",
                last_raw_message="turn/completed",
                phase="running",
                status_label="symphony:running",
                workspace_path=str(tmp_path / "workspaces" / "MT-2"),
                recent_events=[
                    {
                        "at": "2026-06-30T00:00:00Z",
                        "event": "turn_completed",
                        "message": "done",
                        "raw_method": "turn/completed",
                        "raw_event": {"event": "turn_completed", "raw_method": "turn/completed"},
                    }
                ],
                turn_count=2,
                tokens=RuntimeTokens(input_tokens=10, output_tokens=4, cached_tokens=3, total_tokens=17),
            )
        ],
    )

    store.save(state)
    loaded = store.load()

    assert loaded.retry_attempts[0].issue_id == "issue-1"
    assert loaded.retry_attempts[0].identifier == "MT-1"
    assert loaded.retry_attempts[0].attempt == 3
    assert loaded.retry_attempts[0].error == "retry poll failed"
    assert loaded.retry_attempts[0].issue_url == "https://linear.app/x/issue/MT-1"
    assert loaded.retry_attempts[0].due_at == due_at
    assert loaded.retry_attempts[0].due_at_ms > 0
    assert loaded.continuations[0].issue_id == "issue-3"
    assert loaded.continuations[0].identifier == "MT-3"
    assert loaded.continuations[0].attempt == 4
    assert loaded.continuations[0].phase == "continuing"
    assert loaded.continuations[0].status_label == "symphony:continuing"
    assert loaded.continuations[0].last_message == "max turns reached; continuing"
    assert loaded.sessions[0].issue_id == "issue-2"
    assert loaded.sessions[0].session_id == "thread-turn"
    assert loaded.sessions[0].worker_host == "builder-1"
    assert loaded.sessions[0].last_raw_message == "turn/completed"
    assert loaded.sessions[0].phase == "running"
    assert loaded.sessions[0].status_label == "symphony:running"
    assert loaded.sessions[0].workspace_path == str(tmp_path / "workspaces" / "MT-2")
    assert loaded.sessions[0].recent_events[0]["raw_event"]["raw_method"] == "turn/completed"
    assert loaded.sessions[0].tokens.cached_tokens == 3
    assert loaded.sessions[0].tokens.total_tokens == 17


def test_persistence_store_builds_state_from_running_entries(tmp_path: Path) -> None:
    issue = Issue(id="issue-1", identifier="MT-1", title="Build", state="Todo", url="https://linear/MT-1")
    entry = RunningEntry(
        issue=issue,
        task=None,
        started_at=utc_now(),
        retry_attempt=1,
        session_id="thread-turn",
        thread_id="thread",
        turn_id="turn",
        last_codex_event="notification",
        last_codex_message="working",
        last_raw_codex_message="item/agentMessage/delta",
        phase="running",
        status_label="symphony:running",
        workspace_path=str(tmp_path / "workspaces" / "MT-1"),
        recent_events=[
            {
                "at": "2026-06-30T00:00:00Z",
                "event": "notification",
                "message": "working",
                "raw_method": "item/agentMessage/delta",
                "raw_event": {"event": "notification", "raw_method": "item/agentMessage/delta"},
            }
        ],
        tokens=RuntimeTokens(input_tokens=3, output_tokens=2, cached_tokens=1, total_tokens=6),
        turn_count=1,
    )

    state = PersistedState.from_runtime(retry_attempts=[], continuations=[], running=[entry])

    assert state.sessions[0].issue_id == "issue-1"
    assert state.sessions[0].issue_identifier == "MT-1"
    assert state.sessions[0].session_id == "thread-turn"
    assert state.sessions[0].last_event == "notification"
    assert state.sessions[0].last_raw_message == "item/agentMessage/delta"
    assert state.sessions[0].phase == "running"
    assert state.sessions[0].status_label == "symphony:running"
    assert state.sessions[0].workspace_path == str(tmp_path / "workspaces" / "MT-1")
    assert state.sessions[0].recent_events[0]["message"] == "working"
    assert state.sessions[0].tokens.cached_tokens == 1
    assert state.sessions[0].tokens.total_tokens == 6


def test_persistence_store_missing_or_corrupt_file_loads_empty(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    store = PersistenceStore(path)

    assert store.load() == PersistedState()

    path.write_text("{not-json", encoding="utf-8")

    assert store.load() == PersistedState()


def test_persistence_migrates_legacy_errorless_retry_to_continuation(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    due_at = utc_now() + timedelta(seconds=30)
    path.write_text(
        (
            '{"retry_attempts":[{'
            '"issue_id":"issue-1",'
            '"identifier":"MT-1",'
            '"attempt":2,'
            f'"due_at":"{due_at.isoformat().replace("+00:00", "Z")}",'
            '"error":null,'
            '"issue_url":"https://linear.app/x/issue/MT-1",'
            '"phase":"done",'
            '"status_label":"symphony:done",'
            '"last_message":"continue later"'
            '}],"sessions":[]}'
        ),
        encoding="utf-8",
    )

    loaded = PersistenceStore(path).load()

    assert loaded.retry_attempts == []
    assert len(loaded.continuations) == 1
    assert loaded.continuations[0].issue_id == "issue-1"
    assert loaded.continuations[0].attempt == 2
    assert loaded.continuations[0].phase == "continuing"
    assert loaded.continuations[0].status_label == "symphony:continuing"
