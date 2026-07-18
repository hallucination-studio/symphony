from __future__ import annotations

import json

import pytest

from performer.turn_protocol.host import TurnFileHost


def test_host_publishes_result_before_flushed_completion(
    tmp_path, plan_command, monkeypatch
):
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    request.write_text(json.dumps(plan_command), encoding="utf-8")
    expected = successful_result(plan_command)
    emitted = []

    def capture(payload, *, flush):
        assert flush is True
        event = json.loads(payload)
        if event["body"]["kind"] == "turn_completed":
            assert json.loads(result.read_text()) == expected
        emitted.append(event)

    monkeypatch.setattr("builtins.print", capture)

    TurnFileHost(lambda _: expected).run(request, result)

    assert json.loads(result.read_text()) == expected
    assert [event["body"]["kind"] for event in emitted] == [
        "turn_started",
        "usage_updated",
        "turn_completed",
    ]
    assert [event["sequence"] for event in emitted] == [0, 1, 2]


def test_failed_turn_publishes_result_before_closed_error_event(
    tmp_path, plan_command, monkeypatch
):
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    request.write_text(json.dumps(plan_command), encoding="utf-8")
    failure = failed_result(plan_command)
    emitted = []

    def capture(payload, *, flush):
        assert flush is True
        event = json.loads(payload)
        if event["body"]["kind"] == "error_raised":
            assert json.loads(result.read_text()) == failure
        emitted.append(event)

    monkeypatch.setattr("builtins.print", capture)

    TurnFileHost(lambda _: failure).run(
        request, result, event_sequence_start=4
    )

    assert [event["sequence"] for event in emitted] == [4, 5]
    assert emitted[1]["body"] == {
        "kind": "error_raised",
        "error_code": "provider_turn_failed",
        "sanitized_summary": "Upstream request failed.",
        "retryable": True,
    }


@pytest.mark.parametrize("error_type", [OSError, ValueError])
def test_stdout_event_failure_does_not_change_the_result(
    tmp_path, plan_command, monkeypatch, error_type
):
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    request.write_text(json.dumps(plan_command), encoding="utf-8")
    expected = successful_result(plan_command)

    def fail_stdout(*_args, **_kwargs):
        raise error_type("stdout unavailable")

    monkeypatch.setattr("builtins.print", fail_stdout)

    TurnFileHost(lambda _: expected).run(request, result)

    assert json.loads(result.read_text()) == expected


def successful_result(plan_command):
    return {
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


def failed_result(plan_command):
    return {
        "protocol_version": "1",
        "turn_id": "turn-1",
        "turn_kind": "plan",
        "result_kind": "turn_failed",
        "root_issue_id": "root-1",
        "performer_profile_id": "profile-1",
        "turn_input_hash": "hash-1",
        "completed_at": plan_command["started_at"],
        "body": {
            "error_code": "provider_turn_failed",
            "sanitized_reason": "Upstream request failed.",
            "retryable": True,
            "action_required": "Retry the Turn.",
        },
    }
