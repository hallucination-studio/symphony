from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class _ValueEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


class ConnectionState(_ValueEnum):
    NOT_CONNECTED = "not_connected"
    CONNECTED = "connected"
    EXPIRED = "expired"
    ERROR = "error"


class OnboardingStep(_ValueEnum):
    LINEAR_CONNECT = "linear_connect"
    SCOPE_SELECTION = "scope_selection"
    REPOSITORY_MAPPING = "repository_mapping"
    RUNTIME_ENROLLMENT = "runtime_enrollment"
    SMOKE_CHECK = "smoke_check"
    COMPLETE = "complete"


class RepositoryMappingMode(_ValueEnum):
    LOCAL_PATH = "local_path"
    GIT_URL = "git_url"


class ValidationState(_ValueEnum):
    PENDING = "pending"
    VALID = "valid"
    INVALID = "invalid"


class SmokeCheckStatus(_ValueEnum):
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"


def _enum_value(value: Any) -> Any:
    return value.value if isinstance(value, Enum) else value


def _parse_enum(enum: type[_ValueEnum], value: Any) -> Any:
    if isinstance(value, enum):
        return value
    return enum(str(value))


@dataclass(frozen=True)
class SessionIdentity:
    workspace_id: str
    user_id: str
    app_user_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "user_id": self.user_id,
            "app_user_id": self.app_user_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> SessionIdentity:
        return cls(
            workspace_id=str(payload.get("workspace_id") or ""),
            user_id=str(payload.get("user_id") or ""),
            app_user_id=payload.get("app_user_id"),
        )


@dataclass(frozen=True)
class LinearConnectionStatus:
    workspace_id: str
    state: ConnectionState
    scope: Any = None
    app_user_id: str | None = None
    expires_at: str | None = None
    health: str | None = None

    @classmethod
    def from_installation(cls, installation: dict[str, Any] | None) -> LinearConnectionStatus:
        if not installation:
            return cls(workspace_id="", state=ConnectionState.NOT_CONNECTED, health="not_connected")
        expires_at = installation.get("expires_at")
        state = ConnectionState.CONNECTED
        health = "healthy"
        if isinstance(expires_at, str) and expires_at:
            try:
                parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if parsed < datetime.now(timezone.utc):
                    state = ConnectionState.EXPIRED
                    health = "expired"
            except ValueError:
                state = ConnectionState.ERROR
                health = "error"
        return cls(
            workspace_id=str(installation.get("workspace_id") or ""),
            state=state,
            scope=installation.get("scope"),
            app_user_id=installation.get("app_user_id"),
            expires_at=expires_at,
            health=health,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "state": self.state.value,
            "scope": self.scope,
            "app_user_id": self.app_user_id,
            "expires_at": self.expires_at,
            "health": self.health,
        }


@dataclass(frozen=True)
class OnboardingProgress:
    current_step: OnboardingStep
    completed_steps: list[OnboardingStep] = field(default_factory=list)
    next_action: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_step": self.current_step.value,
            "completed_steps": [step.value for step in self.completed_steps],
            "next_action": self.next_action,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> OnboardingProgress:
        return cls(
            current_step=_parse_enum(OnboardingStep, payload.get("current_step") or OnboardingStep.LINEAR_CONNECT),
            completed_steps=[
                _parse_enum(OnboardingStep, step)
                for step in payload.get("completed_steps", [])
            ],
            next_action=payload.get("next_action"),
            metadata=dict(payload.get("metadata") or {}),
        )


@dataclass(frozen=True)
class RepositoryMapping:
    mode: RepositoryMappingMode
    value: str
    validation_state: ValidationState
    validation_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode.value,
            "value": self.value,
            "validation_state": self.validation_state.value,
            "validation_message": self.validation_message,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RepositoryMapping:
        return cls(
            mode=_parse_enum(RepositoryMappingMode, payload.get("mode") or RepositoryMappingMode.LOCAL_PATH),
            value=str(payload.get("value") or ""),
            validation_state=_parse_enum(ValidationState, payload.get("validation_state") or ValidationState.PENDING),
            validation_message=payload.get("validation_message"),
        )


@dataclass(frozen=True)
class RuntimeRecord:
    runtime_id: str
    online: bool
    last_heartbeat: str | None = None
    version: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_id": self.runtime_id,
            "online": self.online,
            "last_heartbeat": self.last_heartbeat,
            "version": self.version,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeRecord:
        return cls(
            runtime_id=str(payload.get("runtime_id") or ""),
            online=bool(payload.get("online")),
            last_heartbeat=payload.get("last_heartbeat"),
            version=payload.get("version"),
            metadata=dict(payload.get("metadata") or {}),
        )


@dataclass(frozen=True)
class SmokeCheckResult:
    status: SmokeCheckStatus
    checks: list[dict[str, Any]]
    recommendations: list[str]
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "checks": self.checks,
            "recommendations": self.recommendations,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> SmokeCheckResult:
        return cls(
            status=_parse_enum(SmokeCheckStatus, payload.get("status") or SmokeCheckStatus.PENDING),
            checks=list(payload.get("checks") or []),
            recommendations=list(payload.get("recommendations") or []),
            timestamp=str(payload.get("timestamp") or ""),
        )

