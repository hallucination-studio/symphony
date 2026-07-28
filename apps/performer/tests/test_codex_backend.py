from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, _usage
from performer.backends.provider_backend_interface import ProviderBackendError, ProviderTurnDeadlineExpired
from performer.prompt_resources import load_role_prompt_catalog


class FakeThread:
    id = "thread-1"

    def __init__(self, response: str = '{"kind":"wait"}') -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))
        result = SimpleNamespace(
            status="completed",
            error=None,
            final_response=self.response,
            usage=SimpleNamespace(total=SimpleNamespace(total_tokens=3)),
        )
        return SimpleNamespace(run=lambda: result, interrupt=lambda: None)


class FakeCodex:
    def __init__(self, thread: FakeThread | None = None) -> None:
        self.thread = thread or FakeThread()
        self.started: list[dict[str, object]] = []
        self.archived: list[str] = []

    def thread_start(self, **kwargs: object):
        self.started.append(kwargs)
        return self.thread

    def thread_archive(self, thread_id: str) -> None:
        self.archived.append(thread_id)

    def account(self, refresh_token: bool = False):
        return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))


def backend_for(sdk: FakeCodex) -> CodexBackendImpl:
    return CodexBackendImpl(sdk, load_role_prompt_catalog())


class BlockingTurn:
    def __init__(self) -> None:
        self.interrupted = threading.Event()
        self.interrupt_calls = 0

    def run(self):
        self.interrupted.wait(timeout=1)
        return SimpleNamespace(
            status="completed",
            error=None,
            final_response='{"kind":"wait"}',
            usage=SimpleNamespace(total=SimpleNamespace(total_tokens=3)),
        )

    def interrupt(self) -> None:
        self.interrupt_calls += 1
        self.interrupted.set()


class BlockingThread(FakeThread):
    def __init__(self) -> None:
        super().__init__()
        self.turn_handle = BlockingTurn()

    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))
        return self.turn_handle


@pytest.mark.parametrize("value", [True, 1.5, "1"])
def test_provider_usage_rejects_non_integer_token_counts(value: object):
    usage = SimpleNamespace(total=SimpleNamespace(
        input_tokens=value,
        cached_input_tokens=0,
        output_tokens=1,
        reasoning_output_tokens=0,
        total_tokens=1,
    ))

    assert _usage(usage) == {"status": "unavailable", "reason": "invalid_provider_usage"}


def test_role_session_uses_role_specific_instructions_and_returns_json():
    sdk = FakeCodex(FakeThread('{"action":{"kind":"wait"}}'))
    backend = backend_for(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    result = backend.execute_role_turn(
        session,
        {
            "kind": "open_root_reconciler",
            "root_issue_id": "root-1",
            "bootstrap": {
                "root_digest": "tree-1",
                "root_snapshot": {
                    "root": {"issue": {"issue_id": "root-1"}},
                    "cycles": [{
                        "cycle_issue": {"issue_id": "cycle-1"},
                        "issues": [{"issue_id": "plan-1", "issue_kind": "plan"}],
                    }],
                },
            },
        },
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )

    assert result["output"]["action"]["kind"] == "wait"
    assert sdk.started[0]["base_instructions"] == load_role_prompt_catalog().for_role("root_reconciler")
    assert "root-1" in sdk.thread.calls[0][0]
    assert "ROOT TARGET IDS:" in sdk.thread.calls[0][0]
    assert "ROOT ACTION REQUIRED FIELDS:" not in sdk.thread.calls[0][0]
    assert "ROOT ACTION FIELD SHAPES:" not in sdk.thread.calls[0][0]
    assert "ROOT ACTION CLOSED VALUES:" not in sdk.thread.calls[0][0]
    assert "plan-1" in sdk.thread.calls[0][0]
    assert "ROOT COMMENT REPLY RULE:" in sdk.thread.calls[0][0]
    assert "No comment source is pending in this turn, so comment_replies must be []." in sdk.thread.calls[0][0]
    assert sdk.thread.calls[0][1]["output_schema"]["required"] == [
        "rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "action",
    ]
    assert set(sdk.thread.calls[0][1]["output_schema"]["properties"]) == {
        "rationale", "evidence_refs", "consumed_input_ids", "comment_replies", "action",
    }
    action_schema = sdk.thread.calls[0][1]["output_schema"]["properties"]["action"]
    assert "oneOf" not in action_schema
    assert '"oneOf"' not in json.dumps(sdk.thread.calls[0][1]["output_schema"])
    action_variants = action_schema["anyOf"]
    execute_plan_schema = next(schema for schema in action_variants if schema.get("properties", {}).get("kind", {}).get("const") == "execute_plan")
    assert execute_plan_schema["required"] == [
        "kind",
        "cycle_issue_id",
        "plan_issue_id",
        "plan_goal",
        "required_outputs",
        "prior_plan_result_ids",
        "human_resolution_ids",
    ]
    assert "RETURN ONLY THE JSON OBJECT." not in sdk.thread.calls[0][0]
    assert "additionalProperties" not in sdk.thread.calls[0][0]
    comment_replies_schema = sdk.thread.calls[0][1]["output_schema"]["properties"]["comment_replies"]
    assert comment_replies_schema["maxItems"] == 0


@pytest.mark.parametrize("role", ["root_reconciler", "plan", "work", "verify"])
def test_live_role_session_uses_the_packaged_prompt_as_its_only_base_instructions(role: str):
    sdk = FakeCodex()
    catalog = load_role_prompt_catalog()
    backend = CodexBackendImpl(sdk, catalog)

    backend.open_role_session(role, {"model": "gpt"})

    assert sdk.started[0]["base_instructions"] == catalog.for_role(role)


def test_live_root_turn_appends_only_the_delta_after_the_initial_turn():
    sdk = FakeCodex(FakeThread('{"action":{"kind":"wait"}}'))
    backend = backend_for(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})
    initial = {
        "kind": "open_root_reconciler",
        "root_issue_id": "root-1",
        "bootstrap": {
            "root_digest": "root-v1",
            "root_snapshot": {"root": {"issue": {"issue_id": "root-1"}}, "cycles": []},
        },
    }
    delta = {
        "kind": "advance_root_reconciler",
        "root_issue_id": "root-1",
        "delta": {
            "base_root_digest": "root-v1",
            "target_root_digest": "root-v2",
            "changes": [{"kind": "tombstone", "source_id": "comment-1"}],
        },
    }

    backend.execute_role_turn(session, initial, workspace_root=None, cancel_event=threading.Event())
    backend.execute_role_turn(session, delta, workspace_root=None, cancel_event=threading.Event())

    first_prompt, second_prompt = (call[0] for call in sdk.thread.calls)
    assert '"bootstrap"' in first_prompt
    assert '"delta"' in second_prompt
    assert '"bootstrap"' not in second_prompt
    assert "root-v1" in second_prompt
    assert "root_snapshot" not in second_prompt


@pytest.mark.parametrize("role", ["plan", "work", "verify"])
def test_live_stage_turn_appends_only_changed_fragments_after_initial(role: str):
    sdk = FakeCodex()
    backend = backend_for(sdk)
    session = backend.open_role_session(role, {"model": "gpt"})
    initial = {
        "role": role,
        "role_context_update": {
            "kind": "initial",
            "target_context_digest": "context-v1",
            "sources": [{"kind": "current_value", "source_id": "initial-only"}],
        },
    }
    delta = {
        "role": role,
        "role_context_update": {
            "kind": "delta",
            "base_context_digest": "context-v1",
            "target_context_digest": "context-v2",
            "changes": [{"kind": "replacement", "source_id": "changed-only"}],
        },
    }

    backend.execute_role_turn(session, initial, workspace_root=None, cancel_event=threading.Event())
    backend.execute_role_turn(session, delta, workspace_root=None, cancel_event=threading.Event())

    first_prompt, second_prompt = (call[0] for call in sdk.thread.calls)
    assert "initial-only" in first_prompt
    assert "changed-only" in second_prompt
    assert "initial-only" not in second_prompt
    assert '"kind":"initial"' not in second_prompt


def test_work_role_receives_workspace_and_is_archived():
    sdk = FakeCodex()
    backend = backend_for(sdk)
    session = backend.open_role_session("work", {"model": "gpt"})
    backend.execute_role_turn(
        session,
        {"role": "work", "target_issue_id": "work-1"},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )
    backend.close_role_session(session)

    assert sdk.started[0]["sandbox"].value == "workspace-write"
    assert sdk.archived == ["thread-1"]


def test_root_reconciler_prompt_exposes_the_pending_comment_reply_source():
    body = "Please start planning."
    body_digest = sha256(body.encode("utf-8")).hexdigest()
    source_input_id = "input:" + sha256(f"comment_body:comment-1\0{body_digest}".encode("utf-8")).hexdigest()
    sdk = FakeCodex(FakeThread('{"action":{"kind":"wait"}}'))
    backend = backend_for(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    backend.execute_role_turn(
        session,
        {
            "kind": "open_root_reconciler",
            "root_issue_id": "root-1",
            "bootstrap": {
                "root_digest": "tree-1",
                "pending_input_ids": [source_input_id],
                "root_snapshot": {
                    "root": {"issue": {"issue_id": "root-1"}},
                    "cycles": [],
                    "user_comments": [{
                        "comment_id": "comment-1",
                        "body": body,
                    }],
                    "user_comment_thread_states": [],
                },
            },
        },
        workspace_root=None,
        cancel_event=threading.Event(),
    )

    prompt, options = sdk.thread.calls[0]
    assert source_input_id in prompt
    assert '"comment_body_digest":"' + body_digest in prompt
    assert options["output_schema"]["properties"]["comment_replies"]["maxItems"] == 256


@pytest.mark.parametrize("role", ["plan", "work", "verify"])
def test_stage_roles_use_the_complete_outcome_contract(role: str):
    sdk = FakeCodex()
    backend = backend_for(sdk)
    session = backend.open_role_session(role, {"model": "gpt"})

    backend.execute_role_turn(
        session,
        {"role": role},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )

    schema = sdk.thread.calls[0][1]["output_schema"]
    assert "oneOf" not in schema
    assert '"oneOf"' not in json.dumps(schema)
    assert len(schema["anyOf"]) >= 5
    assert all("kind" in variant["properties"] for variant in schema["anyOf"])
    assert all(len(variant["required"]) > 1 for variant in schema["anyOf"])
    assert "STAGE OUTCOME REQUIRED FIELDS:" not in sdk.thread.calls[0][0]
    assert "STAGE OUTCOME FIELD SHAPES:" not in sdk.thread.calls[0][0]
    assert "STAGE OUTCOME NESTED CONTRACT SHAPES:" not in sdk.thread.calls[0][0]


def test_invalid_provider_json_is_sanitized():
    sdk = FakeCodex(FakeThread("not-json"))
    backend = backend_for(sdk)
    session = backend.open_role_session("plan", {"model": "gpt"})

    with pytest.raises(ProviderBackendError) as raised:
        backend.execute_role_turn(
            session,
            {},
            workspace_root=None,
            cancel_event=__import__("threading").Event(),
        )

    assert raised.value.code == "provider_output_invalid_json"
    assert raised.value.append_outcome == "accepted"
    assert "not-json" not in raised.value.sanitized_reason


def test_role_turn_interrupts_a_blocked_provider_at_its_deadline():
    thread = BlockingThread()
    backend = backend_for(FakeCodex(thread))
    session = backend.open_role_session("plan", {"model": "gpt"})

    with pytest.raises(ProviderTurnDeadlineExpired):
        backend.execute_role_turn(
            session,
            {"limits": {"deadline_at": (datetime.now(UTC) + timedelta(milliseconds=50)).isoformat()}},
            workspace_root=None,
            cancel_event=threading.Event(),
        )

    assert thread.turn_handle.interrupted.is_set()
    assert thread.turn_handle.interrupt_calls == 1
