from __future__ import annotations

import pytest

from performer_api.local_runtime import (
    ConfigureCommand,
    DispatchAck,
    DispatchLease,
    DrainAck,
    DrainRequest,
    GatewayRequest,
    GatewayResponse,
    LOCAL_RUNTIME_PROTOCOL_VERSION,
    LocalRuntimeContext,
    LocalRuntimeEnvelope,
    LocalRuntimeHandshake,
    PerformerEventMessage,
    RuntimeReportMessage,
    parse_local_runtime_message,
)
from performer_api.runtime_policy import PerformerProfileConfig
from performer_api.turns import PerformerTurnEvent, TurnContext


def context() -> LocalRuntimeContext:
    return LocalRuntimeContext(
        1,
        "conductor-1",
        "instance-1",
        "project-1",
        "binding-1",
        2,
        "correlation-1",
    )


def profile(*, binding_id: str = "binding-1", generation: int = 2) -> PerformerProfileConfig:
    return PerformerProfileConfig.create(
        binding_id=binding_id,
        binding_config_version=generation,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        execution_policy={
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
        },
        turn_policy={"max_turns": 4},
    )


def configure() -> ConfigureCommand:
    return ConfigureCommand(
        context(),
        "/workspace/repo",
        "project-slug",
        "Symphony Project",
        "app-user-1",
        3,
        profile(),
    )


def test_handshake_and_envelope_round_trip_exact_identity() -> None:
    handshake = LocalRuntimeHandshake.from_dict(
        {
            "protocol_version": LOCAL_RUNTIME_PROTOCOL_VERSION,
            "instance_id": "instance-1",
            "project_id": "project-1",
            "binding_generation": 2,
        }
    )
    assert LocalRuntimeHandshake.from_dict(handshake.to_dict()) == handshake
    envelope = LocalRuntimeEnvelope.from_dict(
        {
            **handshake.to_dict(),
            "correlation_id": "correlation-1",
            "payload_kind": "handshake",
        }
    )
    assert LocalRuntimeEnvelope.from_dict(envelope.to_dict()) == envelope
    legacy_dispatch = LocalRuntimeEnvelope(
        1, "instance-1", "project-1", 2, "correlation-1", "dispatch"
    )
    assert LocalRuntimeEnvelope.from_dict(legacy_dispatch.to_dict()) == legacy_dispatch


@pytest.mark.parametrize(
    "field,value",
    [
        ("token", "secret"),
        ("headers", {}),
        ("url", "http://127.0.0.1"),
        ("provider", "codex"),
        ("payload", {}),
    ],
)
def test_contract_rejects_unapproved_or_arbitrary_fields(
    field: str, value: object
) -> None:
    payload = {
        "protocol_version": 1,
        "instance_id": "instance-1",
        "project_id": "project-1",
        "binding_generation": 1,
        field: value,
    }
    with pytest.raises(ValueError, match="fields are invalid"):
        LocalRuntimeHandshake.from_dict(payload)


def test_envelope_rejects_unknown_kind_and_stale_version() -> None:
    base = {
        "protocol_version": 1,
        "instance_id": "instance-1",
        "project_id": "project-1",
        "binding_generation": 1,
        "correlation_id": "correlation-1",
        "payload_kind": "unknown",
    }
    with pytest.raises(ValueError, match="payload_kind"):
        LocalRuntimeEnvelope.from_dict(base)
    with pytest.raises(ValueError, match="protocol_version"):
        LocalRuntimeEnvelope.from_dict(
            {**base, "protocol_version": 2, "payload_kind": "handshake"}
        )


def test_all_closed_runtime_messages_round_trip() -> None:
    turn = TurnContext("run-1", "task-1", "attempt-1", 4, "execute")
    messages = [
        configure(),
        DrainRequest(context(), 100),
        DrainAck(context(), 100, "drained", "", "none"),
        DispatchLease(context(), "dispatch-1", "issue-1", "lease-1", 5, 100),
        DispatchAck(context(), "dispatch-1", "lease-1", 5, "accepted", ""),
        RuntimeReportMessage(context(), "ready", 90, "", 0, "none"),
        GatewayRequest(context(), "issue.read", "issue-1"),
        GatewayResponse(context(), "issue.read", "issue-1", "ok", ""),
        PerformerEventMessage(
            turn,
            "codex",
            "performer-binding-1",
            3,
            PerformerTurnEvent(1, "progress", "Checking tests", 1),
        ),
    ]

    for message in messages:
        assert parse_local_runtime_message(message.to_dict()) == message


def test_configure_uses_one_exact_complete_secret_free_shape() -> None:
    command = configure()

    assert command.to_dict() == {
        "kind": "configure",
        "context": context().to_dict(),
        "repository_path": "/workspace/repo",
        "project_slug": "project-slug",
        "project_name": "Symphony Project",
        "app_user_id": "app-user-1",
        "policy_revision": 3,
        "profile": profile().to_dict(),
    }


@pytest.mark.parametrize(
    "command,error",
    [
        (
            lambda: ConfigureCommand(
                context(),
                "/workspace/repo",
                "project-slug",
                "Symphony Project",
                "app-user-1",
                3,
                profile(binding_id="binding-2"),
            ),
            "binding_id",
        ),
        (
            lambda: ConfigureCommand(
                context(),
                "/workspace/repo",
                "project-slug",
                "Symphony Project",
                "app-user-1",
                3,
                profile(generation=3),
            ),
            "binding_config_version",
        ),
    ],
)
def test_configure_rejects_profile_context_mismatch(command, error: str) -> None:
    with pytest.raises(ValueError, match=error):
        command()


@pytest.mark.parametrize("field", ["performer_kind", "runtime_kind"])
def test_configure_rejects_non_codex_profile_provenance(field: str) -> None:
    payload = configure().to_dict()
    payload["profile"][field] = "other"

    with pytest.raises(ValueError, match=field):
        parse_local_runtime_message(payload)


def test_configure_rejects_the_incomplete_old_shape() -> None:
    payload = {
        "kind": "configure",
        "context": context().to_dict(),
        "repository_path": "/workspace/repo",
        "profile_id": "profile-1",
        "policy_revision": 3,
    }

    with pytest.raises(ValueError, match="fields are invalid"):
        parse_local_runtime_message(payload)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload.update(
            {"app_user_id": "abcdefghij.abcdefghij.abcdefghij"}
        ),
        lambda payload: payload["profile"].update(
            {"performer_profile_id": "sk-abcdefghijklmnopqrstuvwxyz123456"}
        ),
        lambda payload: payload.update({"project_name": "authorization=secret-value"}),
    ],
)
def test_configure_rejects_secret_like_identity_or_metadata(mutation) -> None:
    payload = configure().to_dict()
    mutation(payload)

    with pytest.raises(ValueError, match="secret material"):
        parse_local_runtime_message(payload)


@pytest.mark.parametrize(
    "message",
    [
        lambda: DrainAck(context(), 100, "drained", "failure", "none"),
        lambda: DispatchAck(
            context(), "dispatch-1", "lease-1", 1, "accepted", "failure"
        ),
        lambda: RuntimeReportMessage(context(), "ready", 1, "failure", 1, "retry"),
        lambda: RuntimeReportMessage(context(), "starting", 1, "failure", 1, "retry"),
        lambda: RuntimeReportMessage(context(), "degraded", 1, "", 1, "retry"),
        lambda: RuntimeReportMessage(context(), "degraded", 1, "failure", 1, "none"),
        lambda: GatewayResponse(context(), "issue.read", "issue-1", "ok", "failure"),
    ],
)
def test_invalid_state_transitions_fail_closed(message) -> None:
    with pytest.raises(ValueError, match="transition"):
        message()


def test_performer_event_source_is_codex_provenance_not_a_selector() -> None:
    payload = PerformerEventMessage(
        TurnContext("run-1", "task-1", "attempt-1", 2, "execute"),
        "codex",
        "performer-binding-1",
        3,
        PerformerTurnEvent(1, "heartbeat", "Still running", 1),
    ).to_dict()
    payload["source"]["performer_kind"] = "claude"

    with pytest.raises(ValueError, match="performer_kind"):
        parse_local_runtime_message(payload)


def test_performer_event_uses_the_canonical_exact_envelope() -> None:
    message = PerformerEventMessage(
        TurnContext("run-1", "task-1", "attempt-1", 2, "execute"),
        "codex",
        "performer-binding-1",
        3,
        PerformerTurnEvent(1, "progress", "Checking the current task.", 4),
    )

    assert message.to_dict() == {
        "type": "performer_event",
        "protocol_version": 1,
        "context": {
            "run_id": "run-1",
            "task_id": "task-1",
            "attempt_id": "attempt-1",
            "turn_kind": "execute",
            "fencing_token": 2,
        },
        "source": {
            "performer_kind": "codex",
            "performer_binding_id": "performer-binding-1",
            "binding_generation": 3,
        },
        "event": {
            "kind": "progress",
            "message": "Checking the current task.",
            "sequence": 4,
        },
    }


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload.update({"turn_context": payload["context"]}),
        lambda payload: payload["source"].pop("performer_binding_id"),
        lambda payload: payload["source"].update({"provider_id": "raw"}),
        lambda payload: payload["event"].update({"tool_name": "shell"}),
    ],
)
def test_performer_event_rejects_parallel_or_arbitrary_fields(mutation) -> None:
    payload = PerformerEventMessage(
        TurnContext("run-1", "task-1", "attempt-1", 2, "execute"),
        "codex",
        "performer-binding-1",
        3,
        PerformerTurnEvent(1, "heartbeat", "Still working", 1),
    ).to_dict()
    mutation(payload)

    with pytest.raises(ValueError, match="fields are invalid"):
        parse_local_runtime_message(payload)


@pytest.mark.parametrize("field", ["token", "headers", "url", "database", "provider"])
def test_closed_messages_reject_secret_transport_and_arbitrary_fields(
    field: str,
) -> None:
    payload = DrainRequest(context(), 100).to_dict()
    payload[field] = "secret-sentinel"

    with pytest.raises(ValueError, match="fields are invalid"):
        parse_local_runtime_message(payload)


def test_unknown_kind_version_and_oversize_fail_closed() -> None:
    base = DrainRequest(context(), 100).to_dict()
    with pytest.raises(ValueError, match="kind"):
        parse_local_runtime_message({**base, "kind": "unknown"})
    with pytest.raises(ValueError, match="protocol_version"):
        parse_local_runtime_message(
            {**base, "context": {**base["context"], "protocol_version": 2}}
        )
    with pytest.raises(ValueError, match="too large"):
        parse_local_runtime_message({**base, "extra": "x" * 70_000})
