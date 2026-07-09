from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from performer_api.managed_runs_enums import MANAGED_RUN_BACKENDS_BY_ROLE, ManagedRunRuntimeRole
from performer_api.managed_runs_utils import _dict, _int, _jsonable_dict, _optional_int, _runtime_role, sanitize_profile_settings


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    backend: str
    role: ManagedRunRuntimeRole
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "role": self.role.value,
            "settings": _jsonable_dict(self.settings),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeProfile:
        return cls(
            name=str(payload.get("name") or ""),
            backend=str(payload.get("backend") or ""),
            role=_runtime_role(payload.get("role")),
            settings=_dict(payload.get("settings")),
        )

    def sanitized(self) -> RuntimeProfile:
        return replace(self, settings=sanitize_profile_settings(self.settings))


@dataclass(frozen=True)
class ManagedRunCapacity:
    global_limit: int | None = None
    by_role: dict[ManagedRunRuntimeRole, int | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "global": self.global_limit,
            "by_role": {role.value: limit for role, limit in sorted(self.by_role.items(), key=lambda item: item[0].value)},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunCapacity:
        by_role_payload = payload.get("by_role")
        by_role: dict[ManagedRunRuntimeRole, int | None] = {}
        if isinstance(by_role_payload, dict):
            for role, limit in by_role_payload.items():
                by_role[_runtime_role(role)] = _optional_int(limit)
        return cls(global_limit=_optional_int(payload.get("global")), by_role=by_role)

    def remaining_for_role(
        self,
        role: ManagedRunRuntimeRole,
        *,
        active_global: int,
        active_by_role: dict[ManagedRunRuntimeRole, int],
    ) -> int | None:
        available_global = None if self.global_limit is None else max(0, self.global_limit - active_global)
        role_limit = self.by_role.get(role)
        if role_limit is None:
            return available_global
        available_role = max(0, role_limit - int(active_by_role.get(role, 0)))
        if available_global is None:
            return available_role
        return min(available_global, available_role)


@dataclass(frozen=True)
class ManagedRunPolicy:
    policy_id: str
    version: int
    effective_at: str
    capacity: ManagedRunCapacity
    max_rework_attempts: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "effective_at": self.effective_at,
            "capacity": self.capacity.to_dict(),
            "max_rework_attempts": self.max_rework_attempts,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ManagedRunPolicy:
        return cls(
            policy_id=str(payload.get("policy_id") or ""),
            version=_int(payload.get("version"), default=0),
            effective_at=str(payload.get("effective_at") or ""),
            capacity=ManagedRunCapacity.from_dict(_dict(payload.get("capacity"))),
            max_rework_attempts=_int(payload.get("max_rework_attempts"), default=3),
        )

    def accepts_update(self, candidate: ManagedRunPolicy) -> bool:
        return candidate.version > self.version

    def remaining_for_role(
        self,
        role: ManagedRunRuntimeRole,
        *,
        active_global: int,
        active_by_role: dict[ManagedRunRuntimeRole, int],
    ) -> int | None:
        return self.capacity.remaining_for_role(role, active_global=active_global, active_by_role=active_by_role)

    def with_version(self, version: int) -> ManagedRunPolicy:
        return replace(self, version=version)


@dataclass(frozen=True)
class RuntimeConfigEnvelope:
    runtime_group_id: str
    version: int
    managed_run_policy: ManagedRunPolicy
    profiles: dict[ManagedRunRuntimeRole, RuntimeProfile] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_group_id": self.runtime_group_id,
            "version": self.version,
            "managed_run_policy": self.managed_run_policy.to_dict(),
            "profiles": {role.value: profile.to_dict() for role, profile in self.profiles.items()},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfigEnvelope:
        profiles_payload = payload.get("profiles")
        profiles: dict[ManagedRunRuntimeRole, RuntimeProfile] = {}
        if isinstance(profiles_payload, dict):
            for role, profile_payload in profiles_payload.items():
                if isinstance(profile_payload, dict):
                    profiles[_runtime_role(role)] = RuntimeProfile.from_dict({**profile_payload, "role": profile_payload.get("role") or role})
        return cls(
            runtime_group_id=str(payload.get("runtime_group_id") or ""),
            version=_int(payload.get("version"), default=0),
            managed_run_policy=ManagedRunPolicy.from_dict(_dict(payload.get("managed_run_policy"))),
            profiles=profiles,
        )

    def sanitized(self) -> RuntimeConfigEnvelope:
        return replace(self, profiles={role: profile.sanitized() for role, profile in self.profiles.items()})

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.runtime_group_id.strip():
            errors.append("runtime_group_id_required")
        if self.version <= 0:
            errors.append("version_required")
        policy = self.managed_run_policy
        if not policy.policy_id.strip():
            errors.append("managed_run_policy_id_required")
        if policy.version <= 0:
            errors.append("managed_run_policy_version_required")
        if policy.version != self.version:
            errors.append("managed_run_policy_version_mismatch")
        if not policy.effective_at.strip():
            errors.append("managed_run_policy_effective_at_required")
        if policy.max_rework_attempts <= 0:
            errors.append("max_rework_attempts_required")
        if policy.capacity.global_limit is not None and policy.capacity.global_limit < 0:
            errors.append("capacity_global_invalid")
        for role, limit in policy.capacity.by_role.items():
            if role not in set(ManagedRunRuntimeRole):
                errors.append("capacity_role_invalid")
            if limit is not None and limit < 0:
                errors.append(f"capacity_{role.value}_invalid")
        required_roles = set(ManagedRunRuntimeRole)
        if set(self.profiles) != required_roles:
            missing = sorted(role.value for role in required_roles - set(self.profiles))
            extra = sorted(str(role) for role in set(self.profiles) - required_roles)
            if missing:
                errors.append(f"runtime_profiles_missing:{','.join(missing)}")
            if extra:
                errors.append(f"runtime_profiles_unknown:{','.join(extra)}")
        for role, profile in self.profiles.items():
            if profile.role is not role:
                errors.append(f"runtime_profile_role_mismatch:{role.value}")
            if not profile.name.strip():
                errors.append(f"runtime_profile_name_required:{role.value}")
            if not profile.backend.strip():
                errors.append(f"runtime_profile_backend_required:{role.value}")
            elif profile.backend not in MANAGED_RUN_BACKENDS_BY_ROLE.get(role, set()):
                errors.append(f"runtime_profile_backend_unsupported:{role.value}:{profile.backend}")
        return errors

    def validate(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError("invalid runtime config: " + ", ".join(errors))
