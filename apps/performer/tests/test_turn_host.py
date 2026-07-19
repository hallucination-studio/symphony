from __future__ import annotations

import json

import pytest

from performer.turn_protocol.host import TurnFileHost
from performer.conversation_protocol.host import ConversationFileHost


def test_conversation_host_opens_without_root_side_effect_inputs(tmp_path):
    request = tmp_path / "open.json"
    result = tmp_path / "opened.json"
    request.write_text(json.dumps(open_command()), encoding="utf-8")
    observed = []
    host = ConversationFileHost(
        lambda command: observed.append(command)
        or {"performer_id": "conversation-1"},
        now=lambda: "2026-07-19T11:00:00Z",
    )

    outcome = host.run(request, result)

    assert observed == [open_command()]
    assert outcome["performer_id"] == "conversation-1"
    assert json.loads(result.read_text()) == outcome


def test_conversation_host_rejects_context_before_provider_work(tmp_path):
    request = tmp_path / "open.json"
    result = tmp_path / "opened.json"
    request.write_text(
        json.dumps(
            {
                **open_command(),
                "root_context": {"json": "{}", "markdown": "unsafe"},
            }
        ),
        encoding="utf-8",
    )
    called = False

    def open_provider(_command):
        nonlocal called
        called = True

    with pytest.raises(ValueError, match="Open Root Conversation command"):
        ConversationFileHost(open_provider).run(request, result)
    assert called is False
    assert not result.exists()


def test_conversation_host_publishes_closed_provider_failure(tmp_path):
    from performer.backends.provider_backend_interface import ProviderBackendError

    request = tmp_path / "open.json"
    result = tmp_path / "opened.json"
    request.write_text(json.dumps(open_command()), encoding="utf-8")

    def fail(_command):
        raise ProviderBackendError(
            "Provider temporarily unavailable.",
            code="provider_conversation_open_failed",
            retryable=True,
            action_required="Retry opening the Root conversation.",
        )

    outcome = ConversationFileHost(
        fail, now=lambda: "2026-07-19T11:00:00Z"
    ).run(request, result)
    assert outcome == {
        "protocol_version": "1",
        "request_id": "request-1",
        "performer_profile_id": "profile-1",
        "error_code": "provider_conversation_open_failed",
        "sanitized_reason": "Provider temporarily unavailable.",
        "retryable": True,
        "action_required": "Retry opening the Root conversation.",
        "completed_at": "2026-07-19T11:00:00Z",
    }


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


def open_command():
    return {
        "protocol_version": "1",
        "request_id": "request-1",
        "performer_profile_id": "profile-1",
        "codex_turn_settings": {
            "model": "gpt-5.2-codex",
            "reasoning_effort": "high",
            "is_fast_mode_enabled": False,
        },
        "hard_deadline_at": "2026-07-19T12:00:00Z",
    }
