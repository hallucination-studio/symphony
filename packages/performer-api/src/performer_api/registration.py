from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


class RegistrationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ConductorRegistrationRequest:
    conductor_id: str
    name: str | None = None
    callback_url: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ConductorRegistrationRequest:
        if not isinstance(payload, dict):
            raise RegistrationError("invalid_json", "Registration payload must be a JSON object")
        conductor_id = str(payload.get("conductor_id") or "").strip()
        if not conductor_id:
            raise RegistrationError("missing_conductor_id", "conductor_id is required")
        metadata = payload.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise RegistrationError("invalid_metadata", "metadata must be an object")
        name = payload.get("name")
        callback_url = payload.get("callback_url")
        return cls(
            conductor_id=conductor_id,
            name=str(name).strip() if name is not None else None,
            callback_url=str(callback_url).strip() if callback_url is not None else None,
            metadata=metadata,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ConductorRegistrationResponse:
    status: str
    conductor_id: str
    message: str = "accepted"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
