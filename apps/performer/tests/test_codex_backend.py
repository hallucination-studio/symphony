from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import (
    GATE_SCHEMA,
    PLAN_SCHEMA,
    WORK_SCHEMA,
    CodexBackendImpl,
    ProviderBackendError,
)
from performer.backends.provider_backend_interface import ProviderConversationUnavailable


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


def test_open_conversation_starts_no_turn_and_receives_no_business_context():
    sdk = FakeCodex()
    outcome = CodexBackendImpl(sdk).open_conversation(
        {
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
    )

    assert outcome == {"performer_id": "thread-1"}
    assert sdk.started == [{"model": "gpt-5.2-codex", "service_tier": None}]
    assert sdk.thread.calls == []


def test_resume_preserves_explicit_conversation_loss_signal(plan_command):
    command = deepcopy(plan_command)
    command["performer_id"] = "lost-id"

    class LostConversation(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise ProviderConversationUnavailable("conversation_not_found")

    with pytest.raises(ProviderConversationUnavailable) as raised:
        CodexBackendImpl(LostConversation()).run_turn(command)
    assert raised.value.code == "conversation_not_found"


def test_plan_maps_public_settings_and_read_only_sandbox(plan_command):
    sdk = FakeCodex()
    outcome = CodexBackendImpl(sdk).run_turn(plan_command)

    assert outcome["performer_id"] == "thread-1"
    assert len(sdk.started) == 1
    prompt, kwargs = sdk.thread.calls[0]
    assert kwargs["model"] == "gpt-5.2-codex"
    assert kwargs["effort"] == "high"
    assert kwargs["sandbox"] == "read-only"
    assert kwargs["cwd"] == plan_command["workspace_root"]
    assert kwargs["output_schema"]["required"] == ["summary", "nodes"]
    assert "must target that work node" in prompt
    assert outcome["usage"]["total_tokens"] == 23


def test_provider_output_schemas_use_the_supported_strict_subset():
    for schema in (PLAN_SCHEMA, WORK_SCHEMA, GATE_SCHEMA):
        _assert_strict_schema(schema)


def test_plan_drops_nullable_provider_fields_before_returning_business_body(plan_command):
    response = {
        "summary": "Planned",
        "nodes": [
            {
                "client_node_key": "work-1",
                "parent_client_node_key": None,
                "kind": "work",
                "order": 1,
                "title": "Implement",
                "description": "Make the change.",
                "existing_issue_id": None,
                "target_client_node_key": None,
            }
        ],
    }

    outcome = CodexBackendImpl(FakeCodex(FakeThread(response=response))).run_turn(
        plan_command
    )

    assert outcome["body"]["nodes"] == [
        {
            "client_node_key": "work-1",
            "kind": "work",
            "order": 1,
            "title": "Implement",
            "description": "Make the change.",
        }
    ]


def test_plan_rejects_human_node_without_a_work_target(plan_command):
    response = {
        "summary": "Ask a human to implement the Root.",
        "nodes": [
            {
                "client_node_key": "human-1",
                "parent_client_node_key": None,
                "kind": "human",
                "order": 1,
                "title": "Implement the Root",
                "description": "Complete the requested work.",
                "existing_issue_id": None,
                "target_client_node_key": None,
            }
        ],
    }

    with pytest.raises(ProviderBackendError, match="invalid structured output"):
        CodexBackendImpl(FakeCodex(FakeThread(response=response))).run_turn(
            plan_command
        )


@pytest.mark.parametrize(
    ("turn_kind", "response", "expected"),
    [
        ("work", {"summary": "Done", "sanitized_prompt": None}, {"summary": "Done"}),
        (
            "work",
            {"summary": None, "sanitized_prompt": "Choose a target."},
            {"sanitized_prompt": "Choose a target."},
        ),
        (
            "root_gate",
            {"summary": "Passed", "findings": None},
            {"summary": "Passed"},
        ),
    ],
)
def test_nullable_provider_variants_are_closed_before_business_validation(
    plan_command, turn_kind, response, expected
):
    command = deepcopy(plan_command)
    command["turn_kind"] = turn_kind
    command["performer_id"] = "thread-1"

    outcome = CodexBackendImpl(FakeCodex(FakeThread(response=response))).run_turn(
        command
    )

    assert outcome["body"] == expected


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


@pytest.mark.parametrize(
    ("sandbox_mode", "expected"),
    [
        ("read_only", "read-only"),
        ("workspace_write", "workspace-write"),
        ("unrestricted", "full-access"),
    ],
)
def test_execution_policy_maps_public_sandbox_on_start_and_turn(
    plan_command, sandbox_mode, expected
):
    command = deepcopy(plan_command)
    command["execution_policy"] = {
        "sandbox_mode": sandbox_mode,
        "command_allowlist": [],
        "command_denylist": [],
    }
    sdk = FakeCodex()

    CodexBackendImpl(sdk).run_turn(command)

    assert sdk.started[0]["sandbox"] == expected
    assert sdk.thread.calls[0][1]["sandbox"] == expected


def test_execution_policy_maps_public_sandbox_on_resume(plan_command):
    command = deepcopy(plan_command)
    command["performer_id"] = "opaque-id"
    command["execution_policy"] = {
        "sandbox_mode": "read_only",
        "command_allowlist": [],
        "command_denylist": [],
    }
    sdk = FakeCodex(FakeThread("opaque-id"))

    CodexBackendImpl(sdk).run_turn(command)

    assert sdk.resumed[0][1]["sandbox"] == "read-only"
    assert sdk.thread.calls[0][1]["sandbox"] == "read-only"


@pytest.mark.parametrize("list_name", ["command_allowlist", "command_denylist"])
def test_nonempty_command_rules_fail_before_provider_work(plan_command, list_name):
    command = deepcopy(plan_command)
    command["execution_policy"] = {
        "sandbox_mode": "workspace_write",
        "command_allowlist": [],
        "command_denylist": [],
    }
    command["execution_policy"][list_name] = [
        {"executable": "git", "argv_prefix": ["status"]}
    ]
    sdk = FakeCodex()

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(sdk).run_turn(command)

    assert raised.value.code == "performer_profile_setting_unsupported"
    assert sdk.started == []
    assert sdk.resumed == []


def test_unresumable_id_never_starts_replacement(plan_command):
    command = deepcopy(plan_command)
    command["performer_id"] = "lost-id"

    class BrokenResume(FakeCodex):
        def thread_resume(self, thread_id, **kwargs):
            raise RuntimeError("not found")

    sdk = BrokenResume()
    with pytest.raises(ProviderBackendError, match="could not be resumed") as raised:
        CodexBackendImpl(sdk).run_turn(command)
    assert type(raised.value) is ProviderBackendError
    assert raised.value.code == "performer_conversation_unresumable"
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


def test_provider_failure_preserves_bounded_sanitized_sdk_reason(plan_command):
    class FailedHandle:
        def run(self):
            raise RuntimeError(
                "unexpected status 401 for Authorization: Bearer private-token "
                + "x" * 5_000
            )

        def interrupt(self):
            pass

    thread = FakeThread()
    thread.turn = lambda *_args, **_kwargs: FailedHandle()

    with pytest.raises(ProviderBackendError) as raised:
        CodexBackendImpl(FakeCodex(thread)).run_turn(plan_command)

    assert raised.value.code == "provider_turn_failed"
    assert "RuntimeError" in raised.value.sanitized_reason
    assert "401" in raised.value.sanitized_reason
    assert "private-token" not in raised.value.sanitized_reason
    assert len(raised.value.sanitized_reason) <= 1_024


def _assert_strict_schema(value):
    if isinstance(value, list):
        for item in value:
            _assert_strict_schema(item)
        return
    if not isinstance(value, dict):
        return
    assert not ({"oneOf", "allOf", "not", "maxLength", "maxItems"} & set(value))
    if value.get("type") == "object":
        assert value.get("additionalProperties") is False
        assert set(value.get("required", [])) == set(value.get("properties", {}))
    for item in value.values():
        _assert_strict_schema(item)
