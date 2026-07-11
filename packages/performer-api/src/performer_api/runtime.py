from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class RuntimeRole(StrEnum):
    PLAN = "plan"
    EXECUTE = "execute"
    GATE = "gate"


ManagedRunRuntimeRole = RuntimeRole


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    backend: str
    role: RuntimeRole
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "role": self.role.value,
            "settings": dict(self.settings),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeProfile:
        return cls(
            name=str(payload.get("name") or ""),
            backend=str(payload.get("backend") or ""),
            role=_runtime_role(payload.get("role")),
            settings=dict(payload.get("settings") or {}) if isinstance(payload.get("settings"), dict) else {},
        )


@dataclass(frozen=True)
class ManagedRunPolicy:
    policy_id: str
    version: int
    effective_at: str
    max_rework_attempts: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "effective_at": self.effective_at,
            "max_rework_attempts": self.max_rework_attempts,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunPolicy:
        return cls(
            policy_id=str(payload.get("policy_id") or ""),
            version=int(payload.get("version") or 0),
            effective_at=str(payload.get("effective_at") or ""),
            max_rework_attempts=int(payload.get("max_rework_attempts") or 1),
        )


@dataclass(frozen=True)
class RuntimeConfig:
    runtime_group_id: str
    version: int
    managed_run_policy: ManagedRunPolicy
    profiles: dict[RuntimeRole, RuntimeProfile]

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_group_id": self.runtime_group_id,
            "version": self.version,
            "managed_run_policy": self.managed_run_policy.to_dict(),
            "profiles": {role.value: profile.to_dict() for role, profile in self.profiles.items()},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfig:
        profiles_payload = payload.get("profiles")
        profiles: dict[RuntimeRole, RuntimeProfile] = {}
        if isinstance(profiles_payload, dict):
            for key, value in profiles_payload.items():
                if isinstance(value, dict):
                    role = _runtime_role(value.get("role") or key)
                    profiles[role] = RuntimeProfile.from_dict({**value, "role": role.value})
        return cls(
            runtime_group_id=str(payload.get("runtime_group_id") or ""),
            version=int(payload.get("version") or 0),
            managed_run_policy=ManagedRunPolicy.from_dict(
                payload.get("managed_run_policy") if isinstance(payload.get("managed_run_policy"), dict) else {}
            ),
            profiles=profiles,
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.runtime_group_id.strip():
            errors.append("runtime_group_id_required")
        if self.version <= 0:
            errors.append("version_required")
        if not self.managed_run_policy.policy_id.strip():
            errors.append("managed_run_policy_id_required")
        if self.managed_run_policy.version != self.version:
            errors.append("managed_run_policy_version_mismatch")
        if not self.managed_run_policy.effective_at.strip():
            errors.append("managed_run_policy_effective_at_required")
        if self.managed_run_policy.max_rework_attempts != 1:
            errors.append("max_rework_attempts_must_equal_one")
        for role in RuntimeRole:
            profile = self.profiles.get(role)
            if profile is None:
                errors.append(f"runtime_profile_missing:{role.value}")
                continue
            if profile.role is not role:
                errors.append(f"runtime_profile_role_mismatch:{role.value}")
            if not profile.name.strip():
                errors.append(f"runtime_profile_name_required:{role.value}")
            if not profile.backend.strip():
                errors.append(f"runtime_profile_backend_required:{role.value}")
        return errors

    def validate(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError("invalid runtime config: " + ", ".join(errors))


RuntimeConfigEnvelope = RuntimeConfig


def _runtime_role(value: Any) -> RuntimeRole:
    normalized = str(value or "").strip().lower()
    if normalized == "work_item":
        normalized = RuntimeRole.EXECUTE.value
    elif normalized == "verify":
        normalized = RuntimeRole.GATE.value
    try:
        return RuntimeRole(normalized)
    except ValueError as exc:
        raise ValueError(f"unknown runtime role: {normalized}") from exc


__all__ = [
    "ManagedRunPolicy",
    "ManagedRunRuntimeRole",
    "RuntimeConfig",
    "RuntimeConfigEnvelope",
    "RuntimeProfile",
    "RuntimeRole",
]
