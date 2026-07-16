from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, ProviderBackendError


class FakeThread:
    def __init__(self, thread_id="thread-1", response=None):
        self.id = thread_id
        self.calls = []
        self.response = response or {"summary": "Planned", "nodes": []}

    def run(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        return SimpleNamespace(
            status="completed",
            error=None,
            final_response=json.dumps(self.response),
            usage=SimpleNamespace(
                total=SimpleNamespace(
                    input_tokens=11,
                    cached_input_tokens=2,
                    output_tokens=7,
                    reasoning_output_tokens=3,
                    total_tokens=23,
                )
            ),
        )

    def turn(self, prompt, **kwargs):
        return SimpleNamespace(
            run=lambda: self.run(prompt, **kwargs),
            interrupt=lambda: None,
        )


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


def test_plan_maps_public_settings_and_read_only_sandbox(plan_command):
    sdk = FakeCodex()
    outcome = CodexBackendImpl(sdk).run_turn(plan_command)

    assert outcome["performer_id"] == "thread-1"
    assert len(sdk.started) == 1
    _, kwargs = sdk.thread.calls[0]
    assert kwargs["model"] == "gpt-5.2-codex"
    assert kwargs["effort"] == "high"
    assert kwargs["sandbox"] == "read-only"
    assert kwargs["cwd"] == plan_command["workspace_root"]
    assert kwargs["output_schema"]["required"] == ["summary", "nodes"]
    assert outcome["usage"]["total_tokens"] == 23


def test_work_resumes_exact_id_and_uses_workspace_write(plan_command):
    command = deepcopy(plan_command)
    command.update(
        {
            "turn_kind": "work",
            "work_issue_id": "work-1",
            "performer_id": "opaque-id",
            "body": {
                "root_issue": command["body"]["root_issue"],
                "work_leaf": {"identifier": "SYM-1", "title": "Work", "description": "Edit"},
                "human_inputs": [],
            },
        }
    )
    sdk = FakeCodex(FakeThread("opaque-id", {"summary": "Done"}))

    CodexBackendImpl(sdk).run_turn(command)

    assert sdk.started == []
    assert sdk.resumed[0][0] == "opaque-id"
    assert sdk.thread.calls[0][1]["sandbox"] == "workspace-write"


def test_unresumable_id_never_starts_replacement(plan_command):
    command = deepcopy(plan_command)
    command["performer_id"] = "lost-id"

    class BrokenResume(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise RuntimeError("not found")

    sdk = BrokenResume()
    with pytest.raises(ProviderBackendError, match="could not be resumed"):
        CodexBackendImpl(sdk).run_turn(command)
    assert sdk.started == []


def test_fast_uses_public_service_tier(plan_command):
    command = deepcopy(plan_command)
    command["codex_turn_settings"]["is_fast_mode_enabled"] = True
    sdk = FakeCodex()

    CodexBackendImpl(sdk).run_turn(command)

    assert sdk.thread.calls[0][1]["service_tier"] == "fast"


def test_fast_is_rejected_for_api_key_without_starting_thread(plan_command):
    command = deepcopy(plan_command)
    command["codex_turn_settings"]["is_fast_mode_enabled"] = True
    sdk = FakeCodex()
    sdk.account = lambda refresh_token=False: SimpleNamespace(
        account=SimpleNamespace(root=SimpleNamespace(type="apiKey"))
    )

    with pytest.raises(ProviderBackendError, match="unavailable"):
        CodexBackendImpl(sdk).run_turn(command)

    assert sdk.started == []


def test_fast_is_rejected_when_authentication_cannot_be_verified(plan_command):
    command = deepcopy(plan_command)
    command["codex_turn_settings"]["is_fast_mode_enabled"] = True
    sdk = FakeCodex()
    sdk.account = lambda refresh_token=False: (_ for _ in ()).throw(
        RuntimeError("account unavailable")
    )

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(sdk).run_turn(command)

    assert raised.value.code == "performer_profile_setting_unsupported"
    assert sdk.started == []


def test_invalid_provider_output_fails_closed(plan_command):
    sdk = FakeCodex(FakeThread(response={"provider_raw": "not allowed"}))
    with pytest.raises(ProviderBackendError, match="invalid structured output"):
        CodexBackendImpl(sdk).run_turn(plan_command)


def test_turn_deadline_interrupts_the_public_sdk_handle(plan_command):
    class DeadlineHandle:
        def __init__(self):
            self.interrupted = False

        def run(self):
            from performer.backends.provider_backend_interface import (
                ProviderTurnDeadlineExpired,
            )

            raise ProviderTurnDeadlineExpired

        def interrupt(self):
            self.interrupted = True

    handle = DeadlineHandle()
    thread = FakeThread()
    thread.turn = lambda *_args, **_kwargs: handle
    sdk = FakeCodex(thread)

    from performer.backends.provider_backend_interface import (
        ProviderTurnDeadlineExpired,
    )

    with pytest.raises(ProviderTurnDeadlineExpired):
        CodexBackendImpl(sdk).run_turn(plan_command)

    assert handle.interrupted is True
