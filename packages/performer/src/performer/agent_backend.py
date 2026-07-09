from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeProfile


class AgentBackend(Protocol):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any:
        """Run one agent turn/session and return backend-owned structured output."""
        ...


class BackendCapability(StrEnum):
    STRUCTURED_OUTPUT = "structured_output"
    SHELL = "shell"
    READ_FILES = "read_files"
    WRITE_PATCH = "write_patch"


@dataclass(frozen=True)
class RoleRequirement:
    requires_workspace: bool
    requires_structured_output: bool = False
    requires_shell: bool = False
    can_write_patch: bool = False

    @classmethod
    def for_role(cls, role: ManagedRunRuntimeRole) -> RoleRequirement:
        if role is ManagedRunRuntimeRole.PLAN:
            return cls(requires_workspace=False, requires_structured_output=True)
        if role is ManagedRunRuntimeRole.WORK_ITEM:
            return cls(requires_workspace=True, requires_shell=True, can_write_patch=True)
        if role is ManagedRunRuntimeRole.VERIFY:
            return cls(requires_workspace=True, requires_shell=True, can_write_patch=False)
        raise ValueError(f"unsupported managed_run role: {role}")


@dataclass(frozen=True)
class RuntimeEnv:
    env: dict[str, str]


class RuntimeBackend:
    name = "unknown"
    capabilities: frozenset[BackendCapability] = frozenset()

    def is_eligible(self, role: ManagedRunRuntimeRole) -> bool:
        requirement = RoleRequirement.for_role(role)
        if requirement.requires_structured_output and BackendCapability.STRUCTURED_OUTPUT not in self.capabilities:
            return False
        if requirement.requires_shell and BackendCapability.SHELL not in self.capabilities:
            return False
        if requirement.can_write_patch and BackendCapability.WRITE_PATCH not in self.capabilities:
            return False
        return True

    def prepare_environment(self, profile: RuntimeProfile, role: ManagedRunRuntimeRole) -> RuntimeEnv:
        if not self.is_eligible(role):
            raise ValueError(f"backend {self.name} is not eligible for {role.value}")
        return RuntimeEnv(env={})


class CodexRuntimeBackend(RuntimeBackend):
    name = "codex"
    capabilities = frozenset(
        {
            BackendCapability.STRUCTURED_OUTPUT,
            BackendCapability.SHELL,
            BackendCapability.READ_FILES,
            BackendCapability.WRITE_PATCH,
        }
    )
