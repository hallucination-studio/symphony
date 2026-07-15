from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any, ClassVar

from performer_api._wire_safety import exact_keys, identifier, positive_int
from performer_api.turns import PerformerTurnEvent, TurnContext

LOCAL_RUNTIME_PROTOCOL_VERSION = 1
MAX_LOCAL_RUNTIME_PAYLOAD_BYTES = 64 * 1024
LOCAL_RUNTIME_PAYLOAD_KINDS = frozenset(
    {
        "handshake",
        "dispatch",
        "configure",
        "drain.request",
        "drain.ack",
        "dispatch.lease",
        "dispatch.ack",
        "report",
        "gateway.request",
        "gateway.response",
        "performer_event",
    }
)
_CONTEXT_FIELDS = frozenset(
    {
        "protocol_version",
        "conductor_id",
        "instance_id",
        "project_id",
        "binding_id",
        "binding_generation",
        "correlation_id",
    }
)


def _version(value: Any) -> int:
    if isinstance(value, bool) or value != LOCAL_RUNTIME_PROTOCOL_VERSION:
        raise ValueError("protocol_version is unsupported")
    return value


def _non_negative(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be non-negative")
    return value


def _optional_code(value: Any, field: str = "error_code") -> str:
    return "" if value == "" else identifier(value, field)


def _bounded(payload: Any) -> Any:
    try:
        encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError):
        raise ValueError("local runtime payload is not JSON") from None
    if len(encoded) > MAX_LOCAL_RUNTIME_PAYLOAD_BYTES:
        raise ValueError("local runtime payload is too large")
    return payload


@dataclass(frozen=True)
class LocalRuntimeContext:
    protocol_version: int
    conductor_id: str
    instance_id: str
    project_id: str
    binding_id: str
    binding_generation: int
    correlation_id: str

    def __post_init__(self) -> None:
        _version(self.protocol_version)
        for field in (
            "conductor_id",
            "instance_id",
            "project_id",
            "binding_id",
            "correlation_id",
        ):
            identifier(getattr(self, field), field)
        positive_int(self.binding_generation, "binding_generation")

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "conductor_id": self.conductor_id,
            "instance_id": self.instance_id,
            "project_id": self.project_id,
            "binding_id": self.binding_id,
            "binding_generation": self.binding_generation,
            "correlation_id": self.correlation_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> LocalRuntimeContext:
        exact_keys(payload, _CONTEXT_FIELDS, "local runtime context")
        return cls(**payload)


@dataclass(frozen=True)
class LocalRuntimeMessage:
    context: LocalRuntimeContext
    KIND: ClassVar[str]
    FIELDS: ClassVar[frozenset[str]]

    def _base(self) -> dict[str, Any]:
        return {"kind": self.KIND, "context": self.context.to_dict()}

    def _validate_context(self) -> None:
        if not isinstance(self.context, LocalRuntimeContext):
            raise ValueError("context is invalid")

    @classmethod
    def _parse(cls, payload: dict[str, Any]) -> LocalRuntimeContext:
        exact_keys(payload, cls.FIELDS, cls.KIND)
        if payload.get("kind") != cls.KIND or not isinstance(
            payload.get("context"), dict
        ):
            raise ValueError(f"{cls.KIND} is invalid")
        _bounded(payload)
        return LocalRuntimeContext.from_dict(payload["context"])


@dataclass(frozen=True)
class ConfigureCommand(LocalRuntimeMessage):
    repository_path: str
    profile_id: str
    policy_revision: int
    KIND = "configure"
    FIELDS = frozenset(
        {
            "kind",
            "context",
            "repository_path",
            "profile_id",
            "policy_revision",
        }
    )

    def __post_init__(self) -> None:
        self._validate_context()
        if (
            not isinstance(self.repository_path, str)
            or not PurePath(self.repository_path).is_absolute()
            or "\x00" in self.repository_path
            or len(self.repository_path.encode()) > 4096
        ):
            raise ValueError("repository_path is invalid")
        identifier(self.profile_id, "profile_id")
        positive_int(self.policy_revision, "policy_revision")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "repository_path": self.repository_path,
                "profile_id": self.profile_id,
                "policy_revision": self.policy_revision,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ConfigureCommand:
        context = cls._parse(payload)
        return cls(
            context,
            payload.get("repository_path"),
            payload.get("profile_id"),
            payload.get("policy_revision"),
        )


@dataclass(frozen=True)
class DrainRequest(LocalRuntimeMessage):
    deadline_at: int
    KIND = "drain.request"
    FIELDS = frozenset({"kind", "context", "deadline_at"})

    def __post_init__(self) -> None:
        self._validate_context()
        positive_int(self.deadline_at, "deadline_at")

    def to_dict(self) -> dict[str, Any]:
        return _bounded({**self._base(), "deadline_at": self.deadline_at})

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> DrainRequest:
        return cls(cls._parse(payload), payload.get("deadline_at"))


@dataclass(frozen=True)
class DrainAck(LocalRuntimeMessage):
    deadline_at: int
    status: str
    error_code: str
    next_action: str
    KIND = "drain.ack"
    FIELDS = frozenset(
        {"kind", "context", "deadline_at", "status", "error_code", "next_action"}
    )

    def __post_init__(self) -> None:
        self._validate_context()
        positive_int(self.deadline_at, "deadline_at")
        if self.status not in {"drained", "failed"}:
            raise ValueError("drain status is invalid")
        _optional_code(self.error_code)
        identifier(self.next_action, "next_action")
        if (self.status == "drained") != (
            self.error_code == "" and self.next_action == "none"
        ):
            raise ValueError("drain transition is invalid")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "deadline_at": self.deadline_at,
                "status": self.status,
                "error_code": self.error_code,
                "next_action": self.next_action,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> DrainAck:
        return cls(
            cls._parse(payload),
            payload.get("deadline_at"),
            payload.get("status"),
            payload.get("error_code"),
            payload.get("next_action"),
        )


@dataclass(frozen=True)
class DispatchLease(LocalRuntimeMessage):
    dispatch_id: str
    issue_id: str
    lease_id: str
    fencing_token: int
    leased_until: int
    KIND = "dispatch.lease"
    FIELDS = frozenset(
        {
            "kind",
            "context",
            "dispatch_id",
            "issue_id",
            "lease_id",
            "fencing_token",
            "leased_until",
        }
    )

    def __post_init__(self) -> None:
        self._validate_context()
        for field in ("dispatch_id", "issue_id", "lease_id"):
            identifier(getattr(self, field), field)
        positive_int(self.fencing_token, "fencing_token")
        positive_int(self.leased_until, "leased_until")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "dispatch_id": self.dispatch_id,
                "issue_id": self.issue_id,
                "lease_id": self.lease_id,
                "fencing_token": self.fencing_token,
                "leased_until": self.leased_until,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> DispatchLease:
        return cls(
            cls._parse(payload),
            *(
                payload.get(k)
                for k in (
                    "dispatch_id",
                    "issue_id",
                    "lease_id",
                    "fencing_token",
                    "leased_until",
                )
            ),
        )


@dataclass(frozen=True)
class DispatchAck(LocalRuntimeMessage):
    dispatch_id: str
    lease_id: str
    fencing_token: int
    status: str
    error_code: str
    KIND = "dispatch.ack"
    FIELDS = frozenset(
        {
            "kind",
            "context",
            "dispatch_id",
            "lease_id",
            "fencing_token",
            "status",
            "error_code",
        }
    )

    def __post_init__(self) -> None:
        self._validate_context()
        identifier(self.dispatch_id, "dispatch_id")
        identifier(self.lease_id, "lease_id")
        positive_int(self.fencing_token, "fencing_token")
        if self.status not in {"accepted", "rejected"}:
            raise ValueError("dispatch ACK status is invalid")
        _optional_code(self.error_code)
        if (self.status == "accepted") != (self.error_code == ""):
            raise ValueError("dispatch ACK transition is invalid")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "dispatch_id": self.dispatch_id,
                "lease_id": self.lease_id,
                "fencing_token": self.fencing_token,
                "status": self.status,
                "error_code": self.error_code,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> DispatchAck:
        return cls(
            cls._parse(payload),
            *(
                payload.get(k)
                for k in (
                    "dispatch_id",
                    "lease_id",
                    "fencing_token",
                    "status",
                    "error_code",
                )
            ),
        )


@dataclass(frozen=True)
class RuntimeReportMessage(LocalRuntimeMessage):
    status: str
    heartbeat_at: int
    error_code: str
    retry_count: int
    next_action: str
    KIND = "report"
    FIELDS = frozenset(
        {
            "kind",
            "context",
            "status",
            "heartbeat_at",
            "error_code",
            "retry_count",
            "next_action",
        }
    )

    def __post_init__(self) -> None:
        self._validate_context()
        if self.status not in {"starting", "ready", "degraded", "stopped"}:
            raise ValueError("runtime status is invalid")
        _non_negative(self.heartbeat_at, "heartbeat_at")
        _optional_code(self.error_code)
        _non_negative(self.retry_count, "retry_count")
        identifier(self.next_action, "next_action")
        if self.status in {"starting", "ready", "stopped"} and (
            self.error_code or self.retry_count or self.next_action != "none"
        ):
            raise ValueError("runtime report transition is invalid")
        if self.status == "degraded" and (
            not self.error_code or self.next_action == "none"
        ):
            raise ValueError("runtime report transition is invalid")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "status": self.status,
                "heartbeat_at": self.heartbeat_at,
                "error_code": self.error_code,
                "retry_count": self.retry_count,
                "next_action": self.next_action,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeReportMessage:
        return cls(
            cls._parse(payload),
            *(
                payload.get(k)
                for k in (
                    "status",
                    "heartbeat_at",
                    "error_code",
                    "retry_count",
                    "next_action",
                )
            ),
        )


@dataclass(frozen=True)
class GatewayRequest(LocalRuntimeMessage):
    operation: str
    resource_id: str
    KIND = "gateway.request"
    FIELDS = frozenset({"kind", "context", "operation", "resource_id"})

    def __post_init__(self) -> None:
        self._validate_context()
        if self.operation not in {"issue.read", "issue.comment.create", "issue.update"}:
            raise ValueError("gateway operation is unsupported")
        identifier(self.resource_id, "resource_id")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "operation": self.operation,
                "resource_id": self.resource_id,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GatewayRequest:
        return cls(
            cls._parse(payload), payload.get("operation"), payload.get("resource_id")
        )


@dataclass(frozen=True)
class GatewayResponse(LocalRuntimeMessage):
    operation: str
    resource_id: str
    status: str
    error_code: str
    KIND = "gateway.response"
    FIELDS = frozenset(
        {"kind", "context", "operation", "resource_id", "status", "error_code"}
    )

    def __post_init__(self) -> None:
        self._validate_context()
        GatewayRequest(self.context, self.operation, self.resource_id)
        if self.status not in {"ok", "failed"}:
            raise ValueError("gateway status is invalid")
        _optional_code(self.error_code)
        if (self.status == "ok") != (self.error_code == ""):
            raise ValueError("gateway response transition is invalid")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                **self._base(),
                "operation": self.operation,
                "resource_id": self.resource_id,
                "status": self.status,
                "error_code": self.error_code,
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> GatewayResponse:
        return cls(
            cls._parse(payload),
            *(
                payload.get(k)
                for k in ("operation", "resource_id", "status", "error_code")
            ),
        )


@dataclass(frozen=True)
class PerformerEventMessage:
    context: TurnContext
    performer_kind: str
    performer_binding_id: str
    binding_generation: int
    event: PerformerTurnEvent
    TYPE = "performer_event"
    FIELDS = frozenset({"type", "protocol_version", "context", "source", "event"})

    def __post_init__(self) -> None:
        if not isinstance(self.context, TurnContext):
            raise ValueError("performer event context is invalid")
        if self.performer_kind != "codex":
            raise ValueError("performer_kind is unsupported")
        identifier(self.performer_binding_id, "performer_binding_id")
        positive_int(self.binding_generation, "binding_generation")
        if not isinstance(self.event, PerformerTurnEvent):
            raise ValueError("performer event is invalid")

    def to_dict(self) -> dict[str, Any]:
        return _bounded(
            {
                "type": self.TYPE,
                "protocol_version": LOCAL_RUNTIME_PROTOCOL_VERSION,
                "context": self.context.to_dict(),
                "source": {
                    "performer_kind": self.performer_kind,
                    "performer_binding_id": self.performer_binding_id,
                    "binding_generation": self.binding_generation,
                },
                "event": {
                    "kind": self.event.kind,
                    "message": self.event.message,
                    "sequence": self.event.sequence,
                },
            }
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> PerformerEventMessage:
        exact_keys(payload, cls.FIELDS, "performer_event")
        if payload.get("type") != cls.TYPE:
            raise ValueError("performer_event is invalid")
        _version(payload.get("protocol_version"))
        _bounded(payload)
        source = payload.get("source")
        context = payload.get("context")
        event = payload.get("event")
        exact_keys(
            source,
            {"performer_kind", "performer_binding_id", "binding_generation"},
            "performer event source",
        )
        if not isinstance(context, dict) or not isinstance(event, dict):
            raise ValueError("performer event fields are invalid")
        exact_keys(event, {"kind", "message", "sequence"}, "performer event")
        return cls(
            TurnContext.from_dict(context),
            source.get("performer_kind"),
            source.get("performer_binding_id"),
            source.get("binding_generation"),
            PerformerTurnEvent.from_dict(
                {"protocol_version": LOCAL_RUNTIME_PROTOCOL_VERSION, **event}
            ),
        )


LOCAL_RUNTIME_MESSAGE_TYPES = {
    value.KIND: value
    for value in (
        ConfigureCommand,
        DrainRequest,
        DrainAck,
        DispatchLease,
        DispatchAck,
        RuntimeReportMessage,
        GatewayRequest,
        GatewayResponse,
    )
}


def parse_local_runtime_message(
    payload: dict[str, Any],
) -> LocalRuntimeMessage | PerformerEventMessage:
    _bounded(payload)
    if isinstance(payload, dict) and payload.get("type") == PerformerEventMessage.TYPE:
        return PerformerEventMessage.from_dict(payload)
    kind = payload.get("kind") if isinstance(payload, dict) else None
    message_type = LOCAL_RUNTIME_MESSAGE_TYPES.get(kind)
    if message_type is None:
        raise ValueError("local runtime kind is unsupported")
    return message_type.from_dict(payload)


@dataclass(frozen=True)
class LocalRuntimeHandshake:
    protocol_version: int
    instance_id: str
    project_id: str
    binding_generation: int

    def __post_init__(self) -> None:
        _version(self.protocol_version)
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
        exact_keys(
            payload,
            {"protocol_version", "instance_id", "project_id", "binding_generation"},
            "local runtime handshake",
        )
        return cls(
            payload.get("protocol_version"),
            payload.get("instance_id"),
            payload.get("project_id"),
            payload.get("binding_generation"),
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
        exact_keys(
            payload,
            {
                "protocol_version",
                "instance_id",
                "project_id",
                "binding_generation",
                "correlation_id",
                "payload_kind",
            },
            "local runtime envelope",
        )
        return cls(
            *(
                payload.get(key)
                for key in (
                    "protocol_version",
                    "instance_id",
                    "project_id",
                    "binding_generation",
                    "correlation_id",
                    "payload_kind",
                )
            )
        )
