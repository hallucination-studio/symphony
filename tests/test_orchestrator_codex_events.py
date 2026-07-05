from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from performer.orchestrator import Orchestrator
from performer_api.models import Issue, RunningEntry, RuntimeTokens, utc_now
from tests.test_orchestrator import FakeRunner, FakeTracker, make_config


@pytest.mark.asyncio
async def test_codex_event_processor_updates_entry_tokens_rate_limits_and_recent_events(tmp_path: Path) -> None:
    orchestrator = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner())
    orchestrator.state.running["mt-1"] = RunningEntry(
        issue=Issue(id="mt-1", identifier="MT-1", title="Task", state="Todo"),
        task=None,
        started_at=utc_now(),
        retry_attempt=0,
    )

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "thread_token_usage_updated",
            "session_id": "thread-1-turn-1",
            "payload": {
                "total_token_usage": {
                    "input_tokens": 130,
                    "output_tokens": 50,
                    "cached_tokens": 20,
                    "total_tokens": 180,
                },
                "rate_limits": {"primary": {"remaining": 10}},
            },
        },
    )

    entry = orchestrator.state.running["mt-1"]
    assert entry.session_id == "thread-1-turn-1"
    assert entry.thread_id == "thread-1"
    assert entry.turn_id == "turn-1"
    assert entry.tokens == RuntimeTokens(input_tokens=130, output_tokens=50, cached_tokens=20, total_tokens=180)
    assert orchestrator.state.codex_totals.total_tokens == 180
    assert orchestrator.state.codex_rate_limits == {"primary": {"remaining": 10}}
    assert entry.recent_events[-1]["usage"]["total_tokens"] == 180


@pytest.mark.asyncio
async def test_codex_event_processor_cancels_worker_when_permission_error_needs_human(tmp_path: Path) -> None:
    orchestrator = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner())
    task = asyncio.create_task(asyncio.sleep(60))
    orchestrator.state.running["mt-1"] = RunningEntry(
        issue=Issue(id="mt-1", identifier="MT-1", title="Task", state="Todo"),
        task=task,
        started_at=utc_now(),
        retry_attempt=0,
    )

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "turn_ended_with_error",
            "message": "Permission denied writing outside workspace",
            "payload": {"error": {"message": "Permission denied writing outside workspace"}},
        },
    )

    entry = orchestrator.state.running["mt-1"]
    assert entry.human_blocked_reason is not None
    assert entry.phase == "error"
    assert entry.runtime_phase == "failed"
    assert task.cancelled() or task.cancelling()
    task.cancel()
