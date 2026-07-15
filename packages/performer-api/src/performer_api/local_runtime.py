from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from performer_api._wire_safety import exact_keys, identifier, positive_int

LOCAL_RUNTIME_PROTOCOL_VERSION = 1
LOCAL_RUNTIME_PAYLOAD_KINDS = frozenset({"handshake", "configure", "dispatch", "report"})
_HANDSHAKE_FIELDS = frozenset(
    {"protocol_version", "instance_id", "project_id", "binding_generation"}
)
_ENVELOPE_FIELDS = _HANDSHAKE_FIELDS | {"correlation_id", "payload_kind"}


def _protocol_version(value: Any) -> int:
    if value != LOCAL_RUNTIME_PROTOCOL_VERSION or isinstance(value, bool):
        raise ValueError("protocol_version is unsupported")
    return value


@dataclass(frozen=True)
class LocalRuntimeHandshake:
    protocol_version: int
    instance_id: str
    project_id: str
    binding_generation: int

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        identifier(self.instance_id, "instance_id")
        identifier(self.project_id, "project_id")
        positive_int(self.binding_generation, "binding_generation")

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "instance_id": self.instance_id,
            "project_id": self.project_id,
            "binding_generation": self.binding_generation,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LocalRuntimeHandshake:
        exact_keys(payload, _HANDSHAKE_FIELDS, "local runtime handshake")
        return cls(
            protocol_version=_protocol_version(payload.get("protocol_version")),
            instance_id=identifier(payload.get("instance_id"), "instance_id"),
            project_id=identifier(payload.get("project_id"), "project_id"),
            binding_generation=positive_int(
                payload.get("binding_generation"), "binding_generation"
            ),
        )


@dataclass(frozen=True)
class LocalRuntimeEnvelope(LocalRuntimeHandshake):
    correlation_id: str
    payload_kind: str

    def __post_init__(self) -> None:
        super().__post_init__()
        identifier(self.correlation_id, "correlation_id")
        if self.payload_kind not in LOCAL_RUNTIME_PAYLOAD_KINDS:
            raise ValueError("payload_kind is unsupported")

    def to_dict(self) -> dict[str, Any]:
        return {
            **super().to_dict(),
            "correlation_id": self.correlation_id,
            "payload_kind": self.payload_kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LocalRuntimeEnvelope:
        exact_keys(payload, _ENVELOPE_FIELDS, "local runtime envelope")
        return cls(
            protocol_version=_protocol_version(payload.get("protocol_version")),
            instance_id=identifier(payload.get("instance_id"), "instance_id"),
            project_id=identifier(payload.get("project_id"), "project_id"),
            binding_generation=positive_int(
                payload.get("binding_generation"), "binding_generation"
            ),
            correlation_id=identifier(payload.get("correlation_id"), "correlation_id"),
            payload_kind=payload.get("payload_kind"),
        )
