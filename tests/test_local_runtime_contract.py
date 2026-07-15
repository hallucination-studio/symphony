from __future__ import annotations

import pytest

from performer_api.local_runtime import (
    LOCAL_RUNTIME_PROTOCOL_VERSION,
    LocalRuntimeEnvelope,
    LocalRuntimeHandshake,
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
def test_contract_rejects_unapproved_or_arbitrary_fields(field: str, value: object) -> None:
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
