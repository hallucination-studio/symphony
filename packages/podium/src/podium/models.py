from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class ConnectionState(str, Enum):
    """Linear connection state."""
    NOT_CONNECTED = "not_connected"
    CONNECTED = "connected"
    EXPIRED = "expired"
    ERROR = "error"


class OnboardingStep(str, Enum):
    """Onboarding flow steps."""
    LINEAR_CONNECT = "linear_connect"
    SCOPE_SELECTION = "scope_selection"
    REPOSITORY_MAPPING = "repository_mapping"
    RUNTIME_ENROLLMENT = "runtime_enrollment"
    SMOKE_CHECK = "smoke_check"
    COMPLETE = "complete"


class RepositoryMappingMode(str, Enum):
    """Repository mapping modes."""
    LOCAL_PATH = "local_path"
    GIT_URL = "git_url"


class ValidationState(str, Enum):
    """Validation states for repository mapping."""
    PENDING = "pending"
    VALID = "valid"
    INVALID = "invalid"


class SmokeCheckStatus(str, Enum):
    """Smoke check result status."""
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"


class RunStatus(str, Enum):
    """Run execution status."""
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class SessionIdentity:
    """User/workspace context for a session."""
    workspace_id: str
    user_id: str | None = None
    app_user_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "user_id": self.user_id,
            "app_user_id": self.app_user_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SessionIdentity:
        return cls(
            workspace_id=str(data.get("workspace_id") or ""),
            user_id=str(data["user_id"]) if data.get("user_id") else None,
            app_user_id=str(data["app_user_id"]) if data.get("app_user_id") else None,
        )


@dataclass(frozen=True)
class LinearConnectionStatus:
    """Linear workspace connection status (UI-safe, no secrets)."""
    workspace_id: str
    state: ConnectionState
    health: str  # "healthy", "expired", "error:message"
    scope: str | None = None
    app_user_id: str | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "state": self.state.value,
            "health": self.health,
            "scope": self.scope,
            "app_user_id": self.app_user_id,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_installation(cls, installation: dict[str, Any]) -> LinearConnectionStatus:
        """Create status from stored installation (filters out secrets)."""
        workspace_id = str(installation.get("workspace_id") or "")
        expires_at = installation.get("expires_at")

        # Determine state based on expiration
        state = ConnectionState.CONNECTED
        health = "healthy"

        if expires_at:
            try:
                exp_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if exp_dt < datetime.now(timezone.utc):
                    state = ConnectionState.EXPIRED
                    health = "expired"
            except (ValueError, AttributeError):
                pass

        return cls(
            workspace_id=workspace_id,
            state=state,
            health=health,
            scope=installation.get("scope"),
            app_user_id=installation.get("app_user_id"),
            expires_at=expires_at,
        )


@dataclass(frozen=True)
class OnboardingProgress:
    """Current onboarding progress state."""
    current_step: OnboardingStep
    completed_steps: list[OnboardingStep]
    next_action: str  # Human-readable action description
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_step": self.current_step.value,
            "completed_steps": [step.value for step in self.completed_steps],
            "next_action": self.next_action,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OnboardingProgress:
        return cls(
            current_step=OnboardingStep(data["current_step"]),
            completed_steps=[OnboardingStep(s) for s in data.get("completed_steps", [])],
            next_action=str(data.get("next_action") or ""),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass(frozen=True)
class RepositoryMapping:
    """Repository mapping configuration."""
    mode: RepositoryMappingMode
    value: str  # local_path or git_url
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
    def from_dict(cls, data: dict[str, Any]) -> RepositoryMapping:
        return cls(
            mode=RepositoryMappingMode(data["mode"]),
            value=str(data.get("value") or ""),
            validation_state=ValidationState(data.get("validation_state", "pending")),
            validation_message=str(data["validation_message"]) if data.get("validation_message") else None,
        )


@dataclass(frozen=True)
class RuntimeRecord:
    """Runtime agent record."""
    runtime_id: str
    online: bool
    last_heartbeat: str | None  # ISO8601 timestamp
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
    def from_dict(cls, data: dict[str, Any]) -> RuntimeRecord:
        return cls(
            runtime_id=str(data.get("runtime_id") or ""),
            online=bool(data.get("online", False)),
            last_heartbeat=str(data["last_heartbeat"]) if data.get("last_heartbeat") else None,
            version=str(data["version"]) if data.get("version") else None,
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass(frozen=True)
class SmokeCheckResult:
    """Smoke check execution result."""
    status: SmokeCheckStatus
    checks: list[dict[str, Any]]  # Individual check results
    recommendations: list[str]
    timestamp: str  # ISO8601 timestamp

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "checks": self.checks,
            "recommendations": self.recommendations,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SmokeCheckResult:
        return cls(
            status=SmokeCheckStatus(data["status"]),
            checks=list(data.get("checks", [])),
            recommendations=list(data.get("recommendations", [])),
            timestamp=str(data.get("timestamp") or ""),
        )


@dataclass(frozen=True)
class RunSummary:
    """Summary of a runtime execution."""
    run_id: str
    issue_identifier: str | None
    runtime_id: str | None
    status: RunStatus
    started_at: str | None  # ISO8601 timestamp
    completed_at: str | None  # ISO8601 timestamp
    duration_seconds: float | None
    failure_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "issue_identifier": self.issue_identifier,
            "runtime_id": self.runtime_id,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "duration_seconds": self.duration_seconds,
            "failure_reason": self.failure_reason,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RunSummary:
        return cls(
            run_id=str(data.get("run_id") or ""),
            issue_identifier=str(data["issue_identifier"]) if data.get("issue_identifier") else None,
            runtime_id=str(data["runtime_id"]) if data.get("runtime_id") else None,
            status=RunStatus(data.get("status", "pending")),
            started_at=str(data["started_at"]) if data.get("started_at") else None,
            completed_at=str(data["completed_at"]) if data.get("completed_at") else None,
            duration_seconds=float(data["duration_seconds"]) if data.get("duration_seconds") is not None else None,
            failure_reason=str(data["failure_reason"]) if data.get("failure_reason") else None,
        )
