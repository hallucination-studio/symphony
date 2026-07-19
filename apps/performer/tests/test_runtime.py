from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from performer.backends.provider_backend_interface import ProviderBackendError
from performer.backends.provider_backend_interface import ProviderConversationUnavailable
from performer.root_turn.runtime import RootTurnRuntime
from performer.turn_runtime.runtime import TurnRuntime


class FakeBackend:
    def __init__(self, outcome=None):
        self.calls = []
        self.outcome = outcome or {
            "performer_id": "thread-1",
            "body": {"summary": "Ready", "nodes": []},
            "usage": {
                "input_tokens": 2,
                "cached_input_tokens": 1,
                "output_tokens": 3,
                "reasoning_output_tokens": 4,
                "total_tokens": 10,
            },
        }

    def run_turn(self, command):
        self.calls.append(command)
        return self.outcome


def test_first_plan_starts_and_preserves_correlation(plan_command):
    backend = FakeBackend()
    result = TurnRuntime(backend).run(plan_command)

    assert len(backend.calls) == 1
    assert result["result_kind"] == "plan_ready"
    assert result["performer_id"] == "thread-1"
    for field in (
        "protocol_version",
        "turn_id",
        "root_issue_id",
        "performer_profile_id",
        "turn_input_hash",
    ):
        assert result[field] == plan_command[field]
    assert result["usage"]["total_tokens"] == 10


def test_expired_deadline_cancels_without_backend(plan_command):
    command = deepcopy(plan_command)
    command["hard_deadline_at"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    backend = FakeBackend()

    result = TurnRuntime(backend).run(command)

    assert backend.calls == []
    assert result["result_kind"] == "turn_canceled"
    assert result["body"] == {"sanitized_reason": "The Turn deadline expired before execution."}


def test_invalid_command_is_rejected_before_backend(plan_command):
    command = deepcopy(plan_command)
    command["unexpected"] = True
    backend = FakeBackend()

    with pytest.raises(ValueError, match="invalid Performer Turn command"):
        TurnRuntime(backend).run(command)

    assert backend.calls == []


def test_provider_error_is_sanitized(plan_command):
    class FailingBackend(FakeBackend):
        def run_turn(self, command):
            raise RuntimeError("secret /Users/alice/.codex/auth.json")

    result = TurnRuntime(FailingBackend()).run(plan_command)
    rendered = str(result)

    assert result["result_kind"] == "turn_failed"
    assert result["body"]["error_code"] == "provider_backend_failed"
    assert "secret" not in rendered
    assert "/Users/" not in rendered


def test_closed_backend_error_preserves_actionable_category(plan_command):
    class UnsupportedSettingsBackend(FakeBackend):
        def run_turn(self, command):
            raise ProviderBackendError(
                code="performer_profile_setting_unsupported",
                sanitized_reason="Codex Fast is unavailable for this Profile.",
                retryable=False,
                action_required="Disable Fast or use a supported ChatGPT Profile.",
            )

    result = TurnRuntime(UnsupportedSettingsBackend()).run(plan_command)

    assert result["body"] == {
        "error_code": "performer_profile_setting_unsupported",
        "sanitized_reason": "Codex Fast is unavailable for this Profile.",
        "retryable": False,
        "action_required": "Disable Fast or use a supported ChatGPT Profile.",
    }


def test_work_failure_keeps_opaque_id_and_work_correlation(plan_command):
    command = deepcopy(plan_command)
    command.update(
        {
            "turn_kind": "work",
            "work_issue_id": "work-1",
            "performer_id": "opaque-thread",
            "body": {
                "root_issue": command["body"]["root_issue"],
                "work_leaf": {
                    "identifier": "SYM-1",
                    "title": "Implement",
                    "description": "Do it",
                },
                "human_inputs": [],
            },
        }
    )
    backend = FakeBackend(
        {
            "performer_id": "opaque-thread",
            "body": {"sanitized_prompt": "Which environment should be targeted?"},
        }
    )

    result = TurnRuntime(backend).run(command)

    assert result["result_kind"] == "human_input_required"
    assert result["work_issue_id"] == "work-1"
    assert result["performer_id"] == "opaque-thread"


class FakeRootBackend:
    def __init__(self, outcome=None):
        self.calls = []
        self.outcome = outcome or {
            "bounded_summary": "Root work yielded.",
            "yield_reason": "agent_finished",
            "usage": {
                "input_tokens": 2,
                "cached_input_tokens": 1,
                "output_tokens": 3,
                "reasoning_output_tokens": 4,
                "total_tokens": 10,
            },
        }

    def run_root_turn(self, command):
        self.calls.append(command)
        return self.outcome


def test_root_turn_resumes_one_root_and_reports_complete_accounting(root_command):
    backend = FakeRootBackend()
    result = RootTurnRuntime(
        backend,
        command_usage=lambda: {"broker_calls": 2, "mutations": 1},
    ).run(root_command)

    assert backend.calls == [root_command]
    assert result["result_kind"] == "root_turn_completed"
    assert result["bounded_summary"] == "Root work yielded."
    assert result["yield_reason"] == "agent_finished"
    assert result["usage"]["total_tokens"] == 10
    assert result["turn_usage"]["provider_tokens"] == 10
    assert result["turn_usage"]["broker_calls"] == 2
    assert result["turn_usage"]["mutations"] == 1
    assert result["turn_usage"]["context_bytes"] == sum(
        len(root_command["root_context"][field].encode("utf-8"))
        for field in ("json", "markdown")
    )
    assert result["turn_usage"]["wall_time_ms"] >= 0


def test_root_turn_rejects_oversized_context_before_provider(root_command):
    command = deepcopy(root_command)
    command["turn_limits"]["max_context_bytes"] = 1
    backend = FakeRootBackend()

    result = RootTurnRuntime(backend).run(command)

    assert backend.calls == []
    assert result["result_kind"] == "root_turn_failed"
    assert result["error_code"] == "root_context_limit_exceeded"
    assert result["turn_usage"]["provider_tokens"] == 0


def test_root_turn_preserves_typed_conversation_loss(root_command):
    class LostRootBackend(FakeRootBackend):
        def run_root_turn(self, command):
            raise ProviderConversationUnavailable("conversation_unrecoverable")

    result = RootTurnRuntime(LostRootBackend()).run(root_command)

    assert result["result_kind"] == "root_conversation_unavailable"
    assert result["error_code"] == "conversation_unrecoverable"
    assert result["turn_usage"]["provider_tokens"] == 0


def test_root_turn_command_limit_yields_without_failing_provider(root_command):
    backend = FakeRootBackend()
    result = RootTurnRuntime(
        backend,
        command_usage=lambda: {
            "broker_calls": root_command["turn_limits"]["max_broker_calls"],
            "mutations": 0,
            "limit_reached": True,
        },
    ).run(root_command)

    assert len(backend.calls) == 1
    assert result["result_kind"] == "root_turn_completed"
    assert result["yield_reason"] == "command_limit_reached"
