from __future__ import annotations

import json
import stat
import threading
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import CodexBackendImpl, _usage
from performer.backends.codex.provider_io_capture import ProviderIoCapture
from performer.backends.provider_backend_interface import (
    ProviderBackendError,
    ProviderTurnCanceled,
    ProviderTurnDeadlineExpired,
)
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


class InvalidSchemaThread(FakeThread):
    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))

        def fail():
            raise RuntimeError('{"error":{"code":"invalid_json_schema","message":"uniqueItems is not permitted"}}')

        return SimpleNamespace(run=fail, interrupt=lambda: None)


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
    assert execute_plan_schema["properties"]["kind"]["type"] == "string"
    revise_tree_schema = next(schema for schema in action_variants if schema.get("properties", {}).get("kind", {}).get("const") == "revise_root_tree")
    tree_operations = revise_tree_schema["properties"]["operations"]["items"]["anyOf"]
    assert "create_relation" not in {
        schema.get("properties", {}).get("kind", {}).get("const") for schema in tree_operations
    }
    assert set(execute_plan_schema["required"]) == {
        "kind",
        "cycle_issue_id",
        "plan_issue_id",
        "plan_goal",
        "required_outputs",
        "prior_plan_result_ids",
        "human_resolution_ids",
    }
    assert "RETURN ONLY THE JSON OBJECT." not in sdk.thread.calls[0][0]
    assert "additionalProperties" not in sdk.thread.calls[0][0]
    comment_replies_schema = sdk.thread.calls[0][1]["output_schema"]["properties"]["comment_replies"]
    assert comment_replies_schema["maxItems"] == 0
    _assert_closed_primitives_are_typed(sdk.thread.calls[0][1]["output_schema"])
    _assert_only_supported_string_and_array_constraints(sdk.thread.calls[0][1]["output_schema"])
    _assert_all_object_properties_are_required(sdk.thread.calls[0][1]["output_schema"])


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
    _assert_only_supported_string_and_array_constraints(schema)
    _assert_all_object_properties_are_required(schema)
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


def test_provider_io_capture_records_exact_turn_input_and_output_before_parsing(tmp_path):
    response = "not-json\nverbatim provider output"
    sdk = FakeCodex(FakeThread(response))
    log_path = tmp_path / "provider-io.jsonl"
    backend = CodexBackendImpl(
        sdk,
        load_role_prompt_catalog(),
        io_capture=ProviderIoCapture(log_path),
    )
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})
    request = {
        "kind": "open_root_reconciler",
        "request_id": "request-1",
        "root_issue_id": "root-1",
        "reconciler_session_id": "session-1",
        "reconciler_turn_id": "turn-1",
        "bootstrap": {
            "root_digest": "tree-1",
            "pending_input_ids": ["input:" + "a" * 64],
            "root_snapshot": {
                "root": {"issue": {"issue_id": "root-1"}},
                "cycles": [],
                "user_comments": [],
                "user_comment_thread_states": [],
            },
        },
    }

    with pytest.raises(ProviderBackendError):
        backend.execute_role_turn(
            session,
            request,
            workspace_root=None,
            cancel_event=threading.Event(),
        )

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    session_input = next(record for record in records if record["event"] == "provider_session_input")
    turn_input = next(record for record in records if record["event"] == "provider_turn_input")
    turn_output = next(record for record in records if record["event"] == "provider_turn_output")
    actual_prompt, actual_options = sdk.thread.calls[0]

    assert session_input["payload"]["options"]["base_instructions"] == load_role_prompt_catalog().for_role("root_reconciler")
    assert turn_input["payload"]["prompt"] == actual_prompt
    assert turn_input["payload"]["options"]["model"] == actual_options["model"]
    assert turn_input["payload"]["options"]["output_schema"] == actual_options["output_schema"]
    assert turn_input["correlation"]["request_id"] == "request-1"
    assert turn_input["correlation"]["root_issue_id"] == "root-1"
    assert turn_input["turn_capture_id"] == turn_output["turn_capture_id"]
    assert turn_output["payload"]["final_response"] == response
    assert stat.S_IMODE(log_path.stat().st_mode) == 0o600


def test_provider_io_capture_records_the_original_sdk_error(tmp_path):
    raw_error = '{"error":{"code":"invalid_json_schema","message":"uniqueItems is not permitted"}}'
    log_path = tmp_path / "provider-io.jsonl"
    backend = CodexBackendImpl(
        FakeCodex(InvalidSchemaThread()),
        load_role_prompt_catalog(),
        io_capture=ProviderIoCapture(log_path),
    )
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    with pytest.raises(ProviderBackendError):
        backend.execute_role_turn(
            session,
            {"request_id": "request-1", "root_issue_id": "root-1"},
            workspace_root=None,
            cancel_event=threading.Event(),
        )

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    turn_error = next(record for record in records if record["event"] == "provider_turn_error")
    assert turn_error["payload"] == {
        "phase": "run",
        "error_type": "RuntimeError",
        "error_text": raw_error,
    }


def test_provider_io_capture_records_a_returned_output_before_cancel_wins_the_race(tmp_path):
    response = '{"kind":"wait"}'
    log_path = tmp_path / "provider-io.jsonl"
    backend = CodexBackendImpl(
        FakeCodex(FakeThread(response)),
        load_role_prompt_catalog(),
        io_capture=ProviderIoCapture(log_path),
    )
    session = backend.open_role_session("plan", {"model": "gpt"})
    cancel_event = threading.Event()
    cancel_event.set()

    with pytest.raises(ProviderTurnCanceled):
        backend.execute_role_turn(
            session,
            {"request_id": "request-1"},
            workspace_root=None,
            cancel_event=cancel_event,
        )

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    turn_output = next(record for record in records if record["event"] == "provider_turn_output")
    assert turn_output["payload"]["final_response"] == response


def test_provider_schema_rejection_is_non_retryable_and_not_accepted():
    backend = backend_for(FakeCodex(InvalidSchemaThread()))
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    with pytest.raises(ProviderBackendError) as raised:
        backend.execute_role_turn(
            session,
            {},
            workspace_root=None,
            cancel_event=threading.Event(),
        )

    assert raised.value.code == "provider_schema_unsupported"
    assert raised.value.retryable is False
    assert raised.value.append_outcome == "not_accepted"


def test_provider_null_placeholders_restore_optional_fields_to_absence():
    sdk = FakeCodex(FakeThread('{"action":{"kind":"acknowledge","continue_execution_id":null}}'))
    backend = backend_for(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    result = backend.execute_role_turn(session, {}, workspace_root=None, cancel_event=threading.Event())

    assert "continue_execution_id" not in result["output"]["action"]


def _assert_closed_primitives_are_typed(value: object) -> None:
    if isinstance(value, dict):
        if "const" in value or "enum" in value:
            assert value.get("type") in {"boolean", "integer", "number", "string"}
        for child in value.values():
            _assert_closed_primitives_are_typed(child)
    elif isinstance(value, list):
        for child in value:
            _assert_closed_primitives_are_typed(child)


def _assert_only_supported_string_and_array_constraints(value: object) -> None:
    if isinstance(value, dict):
        assert not {"minLength", "maxLength", "uniqueItems"}.intersection(value)
        for child in value.values():
            _assert_only_supported_string_and_array_constraints(child)
    elif isinstance(value, list):
        for child in value:
            _assert_only_supported_string_and_array_constraints(child)


def _assert_all_object_properties_are_required(value: object) -> None:
    if isinstance(value, dict):
        if value.get("type") == "object":
            assert set(value.get("required", [])) == set(value.get("properties", {}))
        for child in value.values():
            _assert_all_object_properties_are_required(child)
    elif isinstance(value, list):
        for child in value:
            _assert_all_object_properties_are_required(child)


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
