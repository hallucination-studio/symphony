from __future__ import annotations

import hashlib
import json

import pytest

from performer_api.performer_control import (
    CONTROL_OPERATIONS,
    PerformerAccountState,
    PerformerCapabilities,
    PerformerCheckOutcome,
    PerformerConfigurationSnapshot,
    PerformerControlError,
    PerformerControlEvent,
    PerformerControlRequest,
    PerformerControlResult,
    PerformerLoginState,
    PerformerReadinessState,
    PerformerSecretInput,
)
from performer_api.runtime_policy import RuntimePolicyError
from performer_api.turns import (
    PerformerTurnEvent,
    PerformerTurnRequest,
    PerformerTurnResult,
    RuntimeWait,
    TurnContext,
)
from performer_api.workflow import Plan


EXECUTION_POLICY = {
    "version": 1,
    "model": "gpt-5.4",
    "model_provider": "openai",
    "approval_mode": "auto_review",
    "reasoning_effort": "high",
    "reasoning_summary": "auto",
    "sandbox": {
        "plan": "read_only",
        "execute": "workspace_write",
        "gate": "read_only",
    },
    "initialize_timeout_ms": 5_000,
    "turn_timeout_ms": 3_600_000,
    "initialize_max_attempts": 4,
    "overload_max_attempts": 5,
}
TURN_POLICY = {"max_turns": 4}


def _hash(value: dict[str, object]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _capabilities() -> PerformerCapabilities:
    return PerformerCapabilities(
        protocol_version=1,
        capability_version=1,
        performer_kind="codex",
        display_name="Codex",
        turn_kinds=("plan", "execute", "gate"),
        login_methods=("device_code", "api_key"),
        supports_session_delete=True,
        editable_settings=("api_base_url",),
        config_source_visible=True,
        check_supported=True,
    )


def _readiness(status: str = "unchecked") -> PerformerReadinessState:
    error = (
        PerformerControlError(
            error_code="performer_check_failed",
            sanitized_reason="The backend Check failed.",
            action_required=True,
            retryable=False,
            attempt_number=1,
            next_action="Correct the backend configuration and run Check again.",
        )
        if status == "failed"
        else None
    )
    return PerformerReadinessState(
        performer_kind="codex",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
        status=status,
        last_check_status=(
            "none" if status in {"unchecked", "checking"} else status.replace("ready", "passed")
        ),
        error=error,
    )


def test_control_operation_set_is_closed_and_provider_neutral() -> None:
    assert CONTROL_OPERATIONS == frozenset(
        {
            "performer.status",
            "performer.login",
            "performer.session.delete",
            "performer.config.read",
            "performer.config.write",
            "performer.check",
        }
    )
    assert all("codex" not in operation and "claude" not in operation for operation in CONTROL_OPERATIONS)


def test_capabilities_round_trip_without_sdk_shapes() -> None:
    capabilities = _capabilities()

    assert PerformerCapabilities.from_dict(capabilities.to_dict()) == capabilities
    assert capabilities.to_dict() == {
        "protocol_version": 1,
        "capability_version": 1,
        "performer_kind": "codex",
        "display_name": "Codex",
        "turn_kinds": ["plan", "execute", "gate"],
        "login_methods": ["device_code", "api_key"],
        "supports_session_delete": True,
        "editable_settings": ["api_base_url"],
        "config_source_visible": True,
        "check_supported": True,
    }


@pytest.mark.parametrize(
    "mutation",
    [
        {"unknown": True},
        {"performer_kind": "unknown"},
        {"turn_kinds": ["plan", "shell"]},
        {"login_methods": ["oauth_refresh_token"]},
        {"editable_settings": ["raw_json_rpc"]},
    ],
)
def test_capabilities_reject_unknown_fields_and_values(mutation: dict[str, object]) -> None:
    payload = {**_capabilities().to_dict(), **mutation}

    with pytest.raises(ValueError):
        PerformerCapabilities.from_dict(payload)


@pytest.mark.parametrize(
    "payload",
    [
        {**_capabilities().to_dict(), "display_name": 123},
        {
            "protocol_version": 1,
            "request_id": 123,
            "operation": "performer.status",
            "performer_kind": "codex",
            "arguments": {},
            "secret_input": None,
        },
        {
            "protocol_version": 1,
            "request_id": "control-typed",
            "operation": "performer.login",
            "sequence": 1,
            "event_kind": "login.pending",
            "message": 123,
            "verification_url": "https://example.test/device",
            "user_code": "ABCD-EFGH",
            "expires_at": None,
        },
    ],
)
def test_control_contracts_reject_string_type_coercion(payload: dict[str, object]) -> None:
    parser = (
        PerformerCapabilities.from_dict
        if "display_name" in payload
        else PerformerControlEvent.from_dict
        if "event_kind" in payload
        else PerformerControlRequest.from_dict
    )
    with pytest.raises(ValueError):
        parser(payload)


def test_api_key_login_request_declares_only_secret_metadata() -> None:
    request = PerformerControlRequest(
        protocol_version=1,
        request_id="control-1",
        operation="performer.login",
        performer_kind="codex",
        arguments={"method": "api_key"},
        secret_input=PerformerSecretInput(kind="api_key", length=51),
    )

    restored = PerformerControlRequest.from_dict(request.to_dict())

    assert restored == request
    assert request.to_dict()["secret_input"] == {"kind": "api_key", "length": 51}
    assert "api_key_value" not in json.dumps(request.to_dict())

    with pytest.raises(ValueError, match="secret input"):
        PerformerControlRequest(
            protocol_version=1,
            request_id="control-raw-secret",
            operation="performer.login",
            performer_kind="codex",
            arguments={"method": "api_key"},
            secret_input={"kind": "api_key", "length": 51},  # type: ignore[arg-type]
        )


def test_device_login_request_must_not_declare_secret_input() -> None:
    with pytest.raises(ValueError, match="secret"):
        PerformerControlRequest.from_dict(
            {
                "protocol_version": 1,
                "request_id": "control-1",
                "operation": "performer.login",
                "performer_kind": "codex",
                "arguments": {"method": "device_code"},
                "secret_input": {"kind": "api_key", "length": 20},
            }
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "protocol_version": 1,
            "request_id": "control-1",
            "operation": "performer.codex.login",
            "performer_kind": "codex",
            "arguments": {},
            "secret_input": None,
        },
        {
            "protocol_version": 1,
            "request_id": "control-1",
            "operation": "performer.status",
            "performer_kind": "codex",
            "arguments": {"api_key": "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"},
            "secret_input": None,
        },
        {
            "protocol_version": 1,
            "request_id": "control-1",
            "operation": "performer.status",
            "performer_kind": "codex",
            "arguments": {},
            "secret_input": None,
            "sdk_response": {},
        },
    ],
)
def test_control_request_rejects_unknown_operation_secret_payload_and_sdk_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        PerformerControlRequest.from_dict(payload)


def test_config_write_uses_logical_setting_and_rejects_url_userinfo() -> None:
    request = PerformerControlRequest.from_dict(
        {
            "protocol_version": 1,
            "request_id": "control-2",
            "operation": "performer.config.write",
            "performer_kind": "codex",
            "arguments": {"setting": "api_base_url", "value": "https://api.example.test/v1"},
            "secret_input": None,
        }
    )

    assert request.arguments == {
        "setting": "api_base_url",
        "value": "https://api.example.test/v1",
    }
    with pytest.raises(ValueError, match="api_base_url"):
        PerformerControlRequest.from_dict(
            {
                **request.to_dict(),
                "arguments": {
                    "setting": "api_base_url",
                    "value": "https://user:password@example.test/v1",
                },
            }
        )


def test_check_request_validates_policy_and_hash() -> None:
    request = PerformerControlRequest.from_dict(
        {
            "protocol_version": 1,
            "request_id": "control-3",
            "operation": "performer.check",
            "performer_kind": "codex",
            "arguments": {
                "binding_generation": 7,
                "execution_policy": EXECUTION_POLICY,
                "execution_policy_sha256": _hash(EXECUTION_POLICY),
            },
            "secret_input": None,
        }
    )

    assert request.arguments["execution_policy"] == EXECUTION_POLICY
    with pytest.raises(RuntimePolicyError, match="hash"):
        PerformerControlRequest.from_dict(
            {
                **request.to_dict(),
                "arguments": {
                    **request.arguments,
                    "execution_policy_sha256": "0" * 64,
                },
            }
        )


def test_control_event_is_closed_and_drops_no_raw_provider_payload() -> None:
    event = PerformerControlEvent(
        protocol_version=1,
        request_id="control-4",
        operation="performer.login",
        sequence=1,
        event_kind="login.pending",
        message="Complete sign-in in the browser.",
        verification_url="https://example.test/device",
        user_code="ABCD-EFGH",
        expires_at="2026-07-13T01:00:00Z",
    )

    assert PerformerControlEvent.from_dict(event.to_dict()) == event
    with pytest.raises(ValueError):
        PerformerControlEvent.from_dict({**event.to_dict(), "sdk_notification": {"raw": True}})


@pytest.mark.parametrize(
    ("status", "method"),
    [
        ("idle", "device_code"),
        ("lost", "api_key"),
        ("succeeded", None),
        ("failed", None),
    ],
)
def test_login_state_requires_a_method_only_for_active_or_terminal_login(
    status: str, method: str | None
) -> None:
    with pytest.raises(ValueError):
        PerformerLoginState(status=status, method=method)


@pytest.mark.parametrize("event_kind", ["login.succeeded", "login.failed"])
def test_terminal_login_events_must_belong_to_login_operation(event_kind: str) -> None:
    with pytest.raises(ValueError):
        PerformerControlEvent(
            protocol_version=1,
            request_id="control-terminal-event",
            operation="performer.status",
            sequence=1,
            event_kind=event_kind,
            message="Login event",
            verification_url=None,
            user_code=None,
            expires_at=None,
        )


def test_readiness_is_bound_to_backend_binding_capability_and_policy() -> None:
    readiness = _readiness("ready")

    assert PerformerReadinessState.from_dict(readiness.to_dict()) == readiness
    assert readiness.is_compatible(
        performer_kind="codex",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
    )
    assert not readiness.is_compatible(
        performer_kind="codex",
        binding_generation=8,
        capability_version=1,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
    )
    assert not readiness.is_compatible(
        performer_kind="other",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
    )
    assert not readiness.is_compatible(
        performer_kind="codex",
        binding_generation=7,
        capability_version=2,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
    )
    assert not readiness.is_compatible(
        performer_kind="codex",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256="0" * 64,
    )

    with pytest.raises(ValueError, match="failed readiness"):
        PerformerReadinessState(
            performer_kind="codex",
            binding_generation=7,
            capability_version=1,
            execution_policy_sha256=_hash(EXECUTION_POLICY),
            status="failed",
            last_check_status="failed",
            error=None,
        )


def test_status_result_round_trips_only_normalized_fields() -> None:
    result = PerformerControlResult(
        protocol_version=1,
        request_id="control-5",
        operation="performer.status",
        status="succeeded",
        capabilities=_capabilities(),
        readiness=_readiness(),
        account=PerformerAccountState(status="authenticated", display_label="workspace-user"),
        login=PerformerLoginState(status="idle", method=None),
        configuration=None,
        check=None,
        error=None,
    )

    assert PerformerControlResult.from_dict(result.to_dict()) == result


def test_config_result_supports_logical_setting_and_bounded_redacted_source() -> None:
    snapshot = PerformerConfigurationSnapshot(
        settings={"api_base_url": "https://api.example.test/v1"},
        source_format="text",
        source_text='model = "gpt-5.4"\napi_key = "[REDACTED]"\n',
    )
    result = PerformerControlResult(
        protocol_version=1,
        request_id="control-6",
        operation="performer.config.read",
        status="succeeded",
        capabilities=None,
        readiness=None,
        account=None,
        login=None,
        configuration=snapshot,
        check=None,
        error=None,
    )

    assert PerformerControlResult.from_dict(result.to_dict()) == result
    with pytest.raises(ValueError, match="path"):
        PerformerConfigurationSnapshot.from_dict(
            {
                "settings": {"api_base_url": None},
                "source_format": "text",
                "source_text": "config = /Users/example/.codex/config.toml",
            }
        )


@pytest.mark.parametrize(
    "source_text",
    [
        'client_secret = "opaque-value"',
        'config = "/var/lib/symphony/config.toml"',
        "QUJD" * 50 + "_-",
    ],
)
def test_config_source_rejects_secret_assignments_private_paths_and_urlsafe_base64(
    source_text: str,
) -> None:
    with pytest.raises(ValueError):
        PerformerConfigurationSnapshot(
            settings={"api_base_url": None},
            source_format="text",
            source_text=source_text,
        )


@pytest.mark.parametrize(
    "source_text",
    [
        'http_headers = { "X-Api-Key" = "sentinel-secret-value" }',
        'env = { "OPENAI_API_KEY" = "sentinel-secret-value" }',
        "headers = { authorization = 'Bearer sentinel-secret-value' }",
    ],
)
def test_config_source_rejects_quoted_and_nested_secret_assignments(
    source_text: str,
) -> None:
    with pytest.raises(ValueError):
        PerformerConfigurationSnapshot(
            settings={"api_base_url": None},
            source_format="text",
            source_text=source_text,
        )


def test_config_source_accepts_explicitly_redacted_nested_secret_assignment() -> None:
    snapshot = PerformerConfigurationSnapshot(
        settings={"api_base_url": None},
        source_format="text",
        source_text='http_headers = { "X-Api-Key" = "[REDACTED]" }',
    )

    assert snapshot.source_text == 'http_headers = { "X-Api-Key" = "[REDACTED]" }'


def test_wire_safety_accepts_a_redacted_assignment_before_shell_words() -> None:
    from performer_api._wire_safety import safe_text

    command = "OPENAI_API_KEY=[REDACTED] pytest -q"

    assert safe_text(command, "gate command", max_bytes=500) == command


def test_check_result_and_failure_result_use_closed_errors() -> None:
    check = PerformerCheckOutcome(
        status="passed",
        started_at="2026-07-13T00:00:00Z",
        finished_at="2026-07-13T00:00:02Z",
        summary="Structured read-only Check passed.",
    )
    success = PerformerControlResult(
        protocol_version=1,
        request_id="control-7",
        operation="performer.check",
        status="succeeded",
        capabilities=None,
        readiness=_readiness("ready"),
        account=None,
        login=None,
        configuration=None,
        check=check,
        error=None,
    )
    failure = PerformerControlResult(
        protocol_version=1,
        request_id="control-8",
        operation="performer.check",
        status="failed",
        capabilities=None,
        readiness=_readiness("failed"),
        account=None,
        login=None,
        configuration=None,
        check=None,
        error=PerformerControlError(
            error_code="performer_check_failed",
            sanitized_reason="The backend rejected the structured Check.",
            action_required=True,
            retryable=False,
            attempt_number=1,
            next_action="Correct backend configuration and run Check again.",
        ),
    )

    assert PerformerControlResult.from_dict(success.to_dict()) == success
    assert PerformerControlResult.from_dict(failure.to_dict()) == failure
    with pytest.raises(ValueError, match="path"):
        PerformerControlError.from_dict(
            {
                **failure.error.to_dict(),
                "sanitized_reason": "Read /Users/example/.codex/auth.json",
            }
        )
    with pytest.raises(ValueError, match="control error"):
        PerformerControlResult(
            protocol_version=1,
            request_id="control-raw-error",
            operation="performer.check",
            status="failed",
            capabilities=None,
            readiness=_readiness("failed"),
            account=None,
            login=None,
            configuration=None,
            check=None,
            error="raw-provider-error",  # type: ignore[arg-type]
        )


def test_plan_turn_request_and_result_round_trip_as_closed_contracts(tmp_path, minimal_task) -> None:
    context = TurnContext(
        run_id="run-1",
        task_id="",
        attempt_id="attempt-1",
        fencing_token=3,
        turn_kind="plan",
    )
    request = PerformerTurnRequest(
        protocol_version=1,
        context=context,
        performer_kind="codex",
        performer_binding_id="performer-binding-1",
        binding_generation=7,
        execution_policy=EXECUTION_POLICY,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
        turn_policy_sha256=_hash(TURN_POLICY),
        workspace_path=str(tmp_path),
        thread_id="",
        issue_description="Implement the approved feature.",
        task=None,
        evidence=None,
    )
    result = PerformerTurnResult(
        protocol_version=1,
        context=context,
        thread_id="thread-1",
        plan=Plan(summary="Plan", tasks=[minimal_task]),
        execute_result=None,
        gate_result=None,
        runtime_wait=None,
        events=(
            PerformerTurnEvent(
                protocol_version=1,
                kind="progress",
                message="Planning complete.",
                sequence=1,
            ),
        ),
    )

    assert PerformerTurnRequest.from_dict(request.to_dict()) == request
    assert PerformerTurnResult.from_dict(result.to_dict()) == result


def test_turn_contract_rejects_unknown_fields_hash_mismatch_and_raw_events(tmp_path) -> None:
    request = {
        "protocol_version": 1,
        "context": {
            "run_id": "run-1",
            "task_id": "",
            "attempt_id": "attempt-1",
            "fencing_token": 3,
            "turn_kind": "plan",
        },
        "performer_kind": "codex",
        "performer_binding_id": "performer-binding-1",
        "binding_generation": 7,
        "execution_policy": EXECUTION_POLICY,
        "execution_policy_sha256": "0" * 64,
        "turn_policy_sha256": _hash(TURN_POLICY),
        "workspace_path": str(tmp_path),
        "thread_id": "",
        "issue_description": "Implement the approved feature.",
        "task": None,
        "evidence": None,
    }

    with pytest.raises(ValueError, match="hash"):
        PerformerTurnRequest.from_dict(request)
    with pytest.raises(ValueError):
        PerformerTurnRequest.from_dict({**request, "sdk_config": {}})
    with pytest.raises(ValueError):
        PerformerTurnEvent.from_dict(
            {
                "kind": "progress",
                "message": "running",
                "sequence": 1,
                "sdk_notification": {"raw": True},
            }
        )


def test_turn_result_rejects_nested_unknown_task_and_sdk_rubric_fields(minimal_task) -> None:
    plan_context = TurnContext(
        run_id="run-1",
        task_id="",
        attempt_id="attempt-plan",
        fencing_token=1,
        turn_kind="plan",
    )
    plan_payload = {
        "protocol_version": 1,
        "context": plan_context.to_dict(),
        "thread_id": "thread-1",
        "plan": {
            "summary": "Plan",
            "tasks": [{**minimal_task.to_dict(), "sdk_payload": {"raw": True}}],
            "risks": [],
            "architecture_decisions": [],
            "open_questions": [],
            "approval_required": False,
        },
        "execute_result": None,
        "gate_result": None,
        "runtime_wait": None,
        "events": [],
    }
    with pytest.raises(ValueError):
        PerformerTurnResult.from_dict(plan_payload)

    gate_context = TurnContext(
        run_id="run-1",
        task_id="task-1",
        attempt_id="attempt-gate",
        fencing_token=2,
        turn_kind="gate",
    )
    gate_payload = {
        "protocol_version": 1,
        "context": gate_context.to_dict(),
        "thread_id": "thread-1",
        "plan": None,
        "execute_result": None,
        "gate_result": {
            "passed": False,
            "score": 0,
            "threshold": 3,
            "rubric": {"correctness": {"sdk_payload": {"raw": True}}},
            "provenance": [],
            "findings": ["Review failed."],
            "artifact_refs": [],
        },
        "runtime_wait": None,
        "events": [],
    }
    with pytest.raises(ValueError):
        PerformerTurnResult.from_dict(gate_payload)

    gate_payload["gate_result"]["rubric"] = {"correctness": {"score": float("nan")}}
    with pytest.raises(ValueError):
        PerformerTurnResult.from_dict(gate_payload)

    large_text = ("word " * 12_000).strip()
    gate_payload["gate_result"]["rubric"] = {
        f"axis_{index}": {"summary": large_text} for index in range(5)
    }
    with pytest.raises(ValueError, match="large"):
        PerformerTurnResult.from_dict(gate_payload)


def test_turn_contracts_reject_nested_type_coercion(tmp_path, minimal_task) -> None:
    request = PerformerTurnRequest(
        protocol_version=1,
        context=TurnContext(
            run_id="run-1",
            task_id="",
            attempt_id="attempt-1",
            fencing_token=1,
            turn_kind="plan",
        ),
        performer_kind="codex",
        performer_binding_id="performer-binding-1",
        binding_generation=7,
        execution_policy=EXECUTION_POLICY,
        execution_policy_sha256=_hash(EXECUTION_POLICY),
        turn_policy_sha256=_hash(TURN_POLICY),
        workspace_path=str(tmp_path),
        thread_id="",
        issue_description="Implement the approved feature.",
        task=None,
        evidence=None,
    ).to_dict()
    request["performer_binding_id"] = 123
    with pytest.raises(ValueError):
        PerformerTurnRequest.from_dict(request)

    plan_result = {
        "protocol_version": 1,
        "context": request["context"],
        "thread_id": "thread-1",
        "plan": {
            "summary": "Plan",
            "tasks": [{**minimal_task.to_dict(), "title": 123}],
            "risks": [],
            "architecture_decisions": [],
            "open_questions": [],
            "approval_required": False,
        },
        "execute_result": None,
        "gate_result": None,
        "runtime_wait": None,
        "events": [],
    }
    with pytest.raises(ValueError):
        PerformerTurnResult.from_dict(plan_result)

    gate_result = {
        **plan_result,
        "context": {
            **request["context"],
            "task_id": "task-1",
            "attempt_id": "attempt-gate",
            "turn_kind": "gate",
        },
        "plan": None,
        "gate_result": {
            "passed": "false",
            "score": "0",
            "threshold": 3,
            "rubric": {},
            "provenance": [],
            "findings": [],
            "artifact_refs": [],
        },
    }
    with pytest.raises(ValueError):
        PerformerTurnResult.from_dict(gate_result)


@pytest.mark.parametrize(
    "unsafe_message",
    [
        "Read /Users/example/.codex/auth.json",
        "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "A" * 200,
    ],
)
def test_turn_event_rejects_private_paths_secrets_and_base64(unsafe_message: str) -> None:
    if unsafe_message == "A" * 200:
        unsafe_message = ("QUJD" * 50) + "=="
    with pytest.raises(ValueError):
        PerformerTurnEvent(
            protocol_version=1,
            kind="progress",
            message=unsafe_message,
            sequence=1,
        )


def test_direct_turn_context_and_wait_result_still_fail_closed(tmp_path) -> None:
    with pytest.raises(ValueError):
        TurnContext(
            run_id="run-1\nraw",
            task_id="",
            attempt_id="attempt-1",
            fencing_token=1,
            turn_kind="plan",
        )

    context = TurnContext(
        run_id="run-1",
        task_id="",
        attempt_id="attempt-1",
        fencing_token=1,
        turn_kind="plan",
    )
    with pytest.raises(ValueError, match="runtime_wait"):
        PerformerTurnResult(
            protocol_version=1,
            context=context,
            thread_id="",
            plan=None,
            execute_result=None,
            gate_result=None,
            runtime_wait="raw-provider-wait",  # type: ignore[arg-type]
            events=(),
        )

    with pytest.raises(ValueError):
        PerformerTurnRequest(
            protocol_version=1,
            context=context,
            performer_kind="codex",
            performer_binding_id="performer-binding-1",
            binding_generation=7,
            execution_policy=EXECUTION_POLICY,
            execution_policy_sha256=_hash(EXECUTION_POLICY),
            turn_policy_sha256=_hash(TURN_POLICY),
            workspace_path=str(tmp_path),
            thread_id="",
            issue_description="sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            task=None,
            evidence=None,
        )


def test_wait_turn_result_cannot_also_carry_a_business_result() -> None:
    context = TurnContext(
        run_id="run-1",
        task_id="",
        attempt_id="attempt-1",
        fencing_token=3,
        turn_kind="plan",
    )
    with pytest.raises(ValueError, match="runtime_wait"):
        PerformerTurnResult(
            protocol_version=1,
            context=context,
            thread_id="thread-1",
            plan=Plan(summary="Plan", tasks=[]),
            execute_result=None,
            gate_result=None,
            runtime_wait=RuntimeWait(kind="approval_requested", reason="Approve the action."),
            events=(),
        )


@pytest.mark.parametrize("version", [0, 2, False])
def test_turn_contracts_reject_unknown_protocol_versions(tmp_path, version: object) -> None:
    context = TurnContext(
        run_id="run-1",
        task_id="",
        attempt_id="attempt-1",
        fencing_token=1,
        turn_kind="plan",
    )
    with pytest.raises(ValueError, match="protocol_version"):
        PerformerTurnRequest(
            protocol_version=version,  # type: ignore[arg-type]
            context=context,
            performer_kind="codex",
            performer_binding_id="performer-binding-1",
            binding_generation=7,
            execution_policy=EXECUTION_POLICY,
            execution_policy_sha256=_hash(EXECUTION_POLICY),
            turn_policy_sha256=_hash(TURN_POLICY),
            workspace_path=str(tmp_path),
            thread_id="",
            issue_description="Implement the approved feature.",
            task=None,
            evidence=None,
        )
