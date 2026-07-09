from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .pipeline_enums import RUNTIME_BACKENDS_BY_MODE, RuntimeMode
from .pipeline_utils import _dict, _int, _jsonable_dict, _mode, _optional_int, sanitize_profile_settings


@dataclass(frozen=True)
class RuntimeProfile:
    name: str
    backend: str
    mode: RuntimeMode
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "mode": self.mode.value,
            "settings": _jsonable_dict(self.settings),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeProfile:
        return cls(
            name=str(payload.get("name") or ""),
            backend=str(payload.get("backend") or ""),
            mode=_mode(payload.get("mode")),
            settings=_dict(payload.get("settings")),
        )

    def sanitized(self) -> RuntimeProfile:
        return replace(self, settings=sanitize_profile_settings(self.settings))


@dataclass(frozen=True)
class SchedulerCapacity:
    global_limit: int | None = None
    by_mode: dict[RuntimeMode, int | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "global": self.global_limit,
            "by_mode": {mode.value: limit for mode, limit in sorted(self.by_mode.items(), key=lambda item: item[0].value)},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> SchedulerCapacity:
        by_mode_payload = payload.get("by_mode")
        by_mode: dict[RuntimeMode, int | None] = {}
        if isinstance(by_mode_payload, dict):
            for mode, limit in by_mode_payload.items():
                by_mode[_mode(mode)] = _optional_int(limit)
        return cls(global_limit=_optional_int(payload.get("global")), by_mode=by_mode)

    def remaining_for_mode(
        self,
        mode: RuntimeMode,
        *,
        active_global: int,
        active_by_mode: dict[RuntimeMode, int],
    ) -> int | None:
        available_global = None if self.global_limit is None else max(0, self.global_limit - active_global)
        mode_limit = self.by_mode.get(mode)
        if mode_limit is None:
            return available_global
        available_mode = max(0, mode_limit - int(active_by_mode.get(mode, 0)))
        if available_global is None:
            return available_mode
        return min(available_global, available_mode)


@dataclass(frozen=True)
class SchedulerPolicy:
    policy_id: str
    version: int
    effective_at: str
    capacity: SchedulerCapacity
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
    def from_dict(cls, payload: dict[str, Any]) -> SchedulerPolicy:
        return cls(
            policy_id=str(payload.get("policy_id") or ""),
            version=_int(payload.get("version"), default=0),
            effective_at=str(payload.get("effective_at") or ""),
            capacity=SchedulerCapacity.from_dict(_dict(payload.get("capacity"))),
            max_rework_attempts=_int(payload.get("max_rework_attempts"), default=3),
        )

    def accepts_update(self, candidate: SchedulerPolicy) -> bool:
        return candidate.version > self.version

    def remaining_for_mode(
        self,
        mode: RuntimeMode,
        *,
        active_global: int,
        active_by_mode: dict[RuntimeMode, int],
    ) -> int | None:
        return self.capacity.remaining_for_mode(mode, active_global=active_global, active_by_mode=active_by_mode)

    def with_version(self, version: int) -> SchedulerPolicy:
        return replace(self, version=version)


@dataclass(frozen=True)
class RuntimeConfigEnvelope:
    runtime_group_id: str
    version: int
    scheduler_policy: SchedulerPolicy
    profiles: dict[RuntimeMode, RuntimeProfile] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime_group_id": self.runtime_group_id,
            "version": self.version,
            "scheduler_policy": self.scheduler_policy.to_dict(),
            "profiles": {mode.value: profile.to_dict() for mode, profile in self.profiles.items()},
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RuntimeConfigEnvelope:
        profiles_payload = payload.get("profiles")
        profiles: dict[RuntimeMode, RuntimeProfile] = {}
        if isinstance(profiles_payload, dict):
            for mode, profile_payload in profiles_payload.items():
                if isinstance(profile_payload, dict):
                    profiles[_mode(mode)] = RuntimeProfile.from_dict({**profile_payload, "mode": profile_payload.get("mode") or mode})
        return cls(
            runtime_group_id=str(payload.get("runtime_group_id") or ""),
            version=_int(payload.get("version"), default=0),
            scheduler_policy=SchedulerPolicy.from_dict(_dict(payload.get("scheduler_policy"))),
            profiles=profiles,
        )

    def sanitized(self) -> RuntimeConfigEnvelope:
        return replace(self, profiles={mode: profile.sanitized() for mode, profile in self.profiles.items()})

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if not self.runtime_group_id.strip():
            errors.append("runtime_group_id_required")
        if self.version <= 0:
            errors.append("version_required")
        policy = self.scheduler_policy
        if not policy.policy_id.strip():
            errors.append("scheduler_policy_id_required")
        if policy.version <= 0:
            errors.append("scheduler_policy_version_required")
        if policy.version != self.version:
            errors.append("scheduler_policy_version_mismatch")
        if not policy.effective_at.strip():
            errors.append("scheduler_policy_effective_at_required")
        if policy.max_rework_attempts <= 0:
            errors.append("max_rework_attempts_required")
        if policy.capacity.global_limit is not None and policy.capacity.global_limit < 0:
            errors.append("capacity_global_invalid")
        for mode, limit in policy.capacity.by_mode.items():
            if mode not in set(RuntimeMode):
                errors.append("capacity_mode_invalid")
            if limit is not None and limit < 0:
                errors.append(f"capacity_{mode.value}_invalid")
        required_modes = set(RuntimeMode)
        if set(self.profiles) != required_modes:
            missing = sorted(mode.value for mode in required_modes - set(self.profiles))
            extra = sorted(str(mode) for mode in set(self.profiles) - required_modes)
            if missing:
                errors.append(f"runtime_profiles_missing:{','.join(missing)}")
            if extra:
                errors.append(f"runtime_profiles_unknown:{','.join(extra)}")
        for mode, profile in self.profiles.items():
            if profile.mode is not mode:
                errors.append(f"runtime_profile_mode_mismatch:{mode.value}")
            if not profile.name.strip():
                errors.append(f"runtime_profile_name_required:{mode.value}")
            if not profile.backend.strip():
                errors.append(f"runtime_profile_backend_required:{mode.value}")
            elif profile.backend not in RUNTIME_BACKENDS_BY_MODE.get(mode, set()):
                errors.append(f"runtime_profile_backend_unsupported:{mode.value}:{profile.backend}")
        return errors

    def validate(self) -> None:
        errors = self.validation_errors()
        if errors:
            raise ValueError("invalid runtime config: " + ", ".join(errors))
