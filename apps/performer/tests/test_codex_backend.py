from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from openai_codex import InvalidRequestError

from performer.backends.codex.codex_backend_impl import (
    SYMPHONY_BASE_INSTRUCTIONS,
    CodexBackendImpl,
)
from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderConversationUnavailable,
)


class FakeThread:
    def __init__(self, response="Root work yielded."):
        self.id = "thread-1"
        self.calls = []
        self.response = response

    def turn(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        result = SimpleNamespace(
            status="completed", error=None, final_response=self.response,
            usage=SimpleNamespace(total=SimpleNamespace(
                input_tokens=11, cached_input_tokens=2, output_tokens=7,
                reasoning_output_tokens=3, total_tokens=23,
            )),
        )
        return SimpleNamespace(run=lambda: result, interrupt=lambda: None)


class FakeCodex:
    def __init__(self, thread=None):
        self.thread = thread or FakeThread()
        self.started = []
        self.resumed = []

    def thread_start(self, **kwargs):
        self.started.append(kwargs)
        return self.thread

    def thread_resume(self, thread_id, **kwargs):
        self.resumed.append((thread_id, kwargs))
        return self.thread

    def account(self, refresh_token=False):
        return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))


def test_open_conversation_is_side_effect_free():
    sdk = FakeCodex()
    outcome = CodexBackendImpl(sdk).open_conversation({
        "codex_turn_settings": {"model": "gpt-5.2-codex", "reasoning_effort": "high",
                                "is_fast_mode_enabled": False},
    })
    assert outcome == {"performer_id": "thread-1"}
    assert sdk.started == [{
        "model": "gpt-5.2-codex",
        "service_tier": None,
        "base_instructions": SYMPHONY_BASE_INSTRUCTIONS,
    }]
    assert sdk.thread.calls == []


def test_root_turn_only_resumes_supplied_conversation(root_command):
    sdk = FakeCodex()
    outcome = CodexBackendImpl(sdk).run_root_turn(root_command)
    assert sdk.started == []
    assert sdk.resumed[0][0] == "conversation-1"
    assert sdk.resumed[0][1]["base_instructions"] == SYMPHONY_BASE_INSTRUCTIONS
    prompt, kwargs = sdk.thread.calls[0]
    assert root_command["root_context"]["json"] in prompt
    assert root_command["root_context"]["markdown"] not in prompt
    assert prompt.count(root_command["root_context"]["json"]) == 1
    assert json.dumps(root_command["command_channel"], separators=(",", ":")) in prompt
    assert json.dumps(root_command["turn_limits"], separators=(",", ":")) in prompt
    assert "output_schema" not in kwargs
    assert outcome["bounded_summary"] == "Root work yielded."
    assert outcome["yield_reason"] == "agent_finished"


def test_base_instructions_define_closed_root_performer_safety_boundary():
    for phrase in (
        "supplied Root",
        "untrusted data",
        "private broker channel",
        "Do not claim an effect",
        "smallest workflow-advancing action",
        "Do not create alternate workflow state",
    ):
        assert phrase in SYMPHONY_BASE_INSTRUCTIONS


def test_first_root_turn_uses_the_side_effect_free_opened_thread(root_command):
    sdk = FakeCodex()
    backend = CodexBackendImpl(sdk)
    opened = backend.open_conversation({
        "codex_turn_settings": root_command["codex_turn_settings"],
    })
    command = {**root_command, "performer_id": opened["performer_id"]}

    outcome = backend.run_opened_root_turn(command)

    assert sdk.resumed == []
    assert sdk.thread.calls
    assert outcome["yield_reason"] == "agent_finished"


def test_root_turn_preserves_explicit_conversation_loss(root_command):
    class LostConversation(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise ProviderConversationUnavailable("conversation_not_found")
    with pytest.raises(ProviderConversationUnavailable):
        CodexBackendImpl(LostConversation()).run_root_turn(root_command)


def test_root_turn_maps_exact_missing_rollout_to_conversation_loss(root_command):
    class MissingRollout(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise InvalidRequestError(
                -32600,
                f"no rollout found for thread id {thread_id}",
            )

    with pytest.raises(ProviderConversationUnavailable) as raised:
        CodexBackendImpl(MissingRollout()).run_root_turn(root_command)
    assert raised.value.code == "conversation_not_found"


def test_root_turn_does_not_guess_mismatched_rollout_loss(root_command):
    class DifferentRollout(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise InvalidRequestError(
                -32600,
                "no rollout found for thread id another-conversation",
            )

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(DifferentRollout()).run_root_turn(root_command)
    assert raised.value.code == "provider_conversation_resume_failed"


def test_root_turn_reports_sanitized_resume_failure(root_command):
    class FailedResume(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise RuntimeError("resume rejected for Bearer sk-private-canary")
    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(FailedResume()).run_root_turn(root_command)
    assert raised.value.code == "provider_conversation_resume_failed"
    assert "RuntimeError: resume rejected" in raised.value.sanitized_reason
    assert "sk-private-canary" not in raised.value.sanitized_reason


@pytest.mark.parametrize("field", ["command_allowlist", "command_denylist"])
def test_nonempty_command_rules_fail_before_provider(root_command, field):
    command = deepcopy(root_command)
    command["execution_policy"][field] = [{"executable": "git", "argv_prefix": []}]
    sdk = FakeCodex()
    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(sdk).run_root_turn(command)
    assert raised.value.code == "performer_profile_setting_unsupported"
    assert sdk.resumed == []
