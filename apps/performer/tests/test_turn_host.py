from __future__ import annotations

import json

from performer.turn_protocol.host import TurnFileHost


def test_host_writes_atomic_result_and_bounded_neutral_events(tmp_path, plan_command):
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    events = tmp_path / "events.ndjson"
    request.write_text(json.dumps(plan_command), encoding="utf-8")
    expected = {
        "protocol_version": "1",
        "turn_id": "turn-1",
        "turn_kind": "plan",
        "result_kind": "plan_ready",
        "root_issue_id": "root-1",
        "performer_profile_id": "profile-1",
        "turn_input_hash": "hash-1",
        "completed_at": plan_command["started_at"],
        "performer_id": "opaque",
        "usage": {
            "input_tokens": 1,
            "cached_input_tokens": 0,
            "output_tokens": 1,
            "reasoning_output_tokens": 0,
            "total_tokens": 2,
        },
        "body": {"summary": "ok", "nodes": []},
    }

    TurnFileHost(lambda _: expected).run(request, result, events)

    assert json.loads(result.read_text()) == expected
    written_events = [json.loads(line) for line in events.read_text().splitlines()]
    assert [event["body"]["kind"] for event in written_events] == [
        "turn_started",
        "usage_updated",
    ]
    assert "provider" not in events.read_text().lower()


def test_event_failure_is_best_effort(tmp_path, plan_command):
    request = tmp_path / "request.json"
    request.write_text(json.dumps(plan_command), encoding="utf-8")
    result = tmp_path / "result.json"

    TurnFileHost(lambda _: {"result_kind": "turn_failed"}).run(
        request, result, tmp_path / "missing" / "events.ndjson"
    )

    assert result.exists()
