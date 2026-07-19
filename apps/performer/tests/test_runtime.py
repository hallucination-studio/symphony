from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from performer.backends.provider_backend_interface import ProviderBackendError
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
