from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from performer.backends.provider_backend_interface import ProviderBackendError
from performer.backends.provider_backend_interface import ProviderConversationUnavailable
from performer.root_turn.runtime import RootTurnRuntime


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
