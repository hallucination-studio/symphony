from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal
from uuid import uuid4

from performer_api import LocalRuntimeEnvelope


RepoSourceType = Literal["git", "local_path"]
ProcessStatus = Literal["stopped", "starting", "running", "unhealthy", "exited", "crash_loop"]
_SECRET_IDENTIFIER = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|"
    r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)


@dataclass(frozen=True)
class LocalRuntimeIdentity:
    conductor_id: str
    instance_id: str
    project_id: str
    binding_id: str
    binding_generation: int

    def __post_init__(self) -> None:
        for field_name in ("conductor_id", "instance_id", "project_id", "binding_id"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", value
            ) is None or _SECRET_IDENTIFIER.search(value) is not None:
                raise ValueError(f"{field_name}_invalid")
        if (
            isinstance(self.binding_generation, bool)
            or not isinstance(self.binding_generation, int)
            or self.binding_generation < 1
        ):
            raise ValueError("binding_generation_invalid")


@dataclass(frozen=True)
class LocalRuntimeBootstrap:
    podium_ipc_fd: int
    identity: LocalRuntimeIdentity
    handshake_correlation_id: str

    def __post_init__(self) -> None:
        if (
            isinstance(self.podium_ipc_fd, bool)
            or not isinstance(self.podium_ipc_fd, int)
            or self.podium_ipc_fd < 0
        ):
            raise ValueError("podium_ipc_fd_invalid")
        if self.identity.instance_id in {".", ".."}:
            raise ValueError("instance_id_invalid")
        if (
            not isinstance(self.handshake_correlation_id, str)
            or _SECRET_IDENTIFIER.search(self.handshake_correlation_id) is not None
        ):
            raise ValueError("handshake_correlation_id_invalid")
        self.handshake

    @property
    def handshake(self) -> LocalRuntimeEnvelope:
        identity = self.identity
        return LocalRuntimeEnvelope(
            1,
            identity.instance_id,
            identity.project_id,
            identity.binding_generation,
            self.handshake_correlation_id,
            "handshake",
        )


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class ConductorSettings:
    podium_url: str = ""
    podium_runtime_id: str = ""
    podium_runtime_token: str = ""
    podium_proxy_token: str = ""
    managed_mode: bool = False
    conductor_id: str = field(default_factory=lambda: uuid4().hex)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_public_dict(self) -> dict[str, Any]:
        podium_proxy_configured = bool(self.podium_url.strip() and self.podium_proxy_token.strip())
        return {
            "linear_application_connected": podium_proxy_configured,
            "podium_url": self.podium_url,
            "podium_runtime_id": self.podium_runtime_id,
            "podium_runtime_token_configured": bool(self.podium_runtime_token.strip()),
            "podium_proxy_token_configured": bool(self.podium_proxy_token.strip()),
            "runtime_group_id": f"group_{self.conductor_id}",
            "managed_mode": self.managed_mode,
            "conductor_id": self.conductor_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ConductorSettings:
        return cls(
            podium_url=str(payload.get("podium_url") or ""),
            podium_runtime_id=str(payload.get("podium_runtime_id") or ""),
            podium_runtime_token=str(payload.get("podium_runtime_token") or ""),
            podium_proxy_token=str(payload.get("podium_proxy_token") or ""),
            managed_mode=bool(payload.get("managed_mode") or False),
            conductor_id=str(payload.get("conductor_id") or uuid4().hex),
        )


@dataclass(frozen=True)
class InstanceRecord:
    id: str
    name: str
    repo_source_type: RepoSourceType
    repo_source_value: str
    resolved_repo_path: str
    instance_dir: str
    workspace_root: str
    persistence_path: str
    log_path: str
    http_port: int
    linear_project: str
    linear_filters: dict[str, Any]
    process_status: ProcessStatus = "stopped"
    pid: int | None = None
    last_exit_code: int | None = None
    last_error: str | None = None
    restart_count: int = 0
    restart_window_started_at: str | None = None
    restart_next_at: str | None = None
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def create(
        cls,
        *,
        name: str,
        repo_source_type: RepoSourceType,
        repo_source_value: str,
        resolved_repo_path: str,
        instance_dir: str,
        workspace_root: str,
        persistence_path: str,
        log_path: str,
        http_port: int,
        linear_project: str,
        linear_filters: dict[str, Any],
        id: str | None = None,
    ) -> InstanceRecord:
        now = utc_now_iso()
        return cls(
            id=id or uuid4().hex,
            name=name,
            repo_source_type=repo_source_type,
            repo_source_value=repo_source_value,
            resolved_repo_path=resolved_repo_path,
            instance_dir=instance_dir,
            workspace_root=workspace_root,
            persistence_path=persistence_path,
            log_path=log_path,
            http_port=http_port,
            linear_project=linear_project,
            linear_filters=linear_filters,
            created_at=now,
            updated_at=now,
        )

    def with_updates(self, **changes: Any) -> InstanceRecord:
        if "updated_at" not in changes:
            changes["updated_at"] = utc_now_iso()
        return replace(self, **changes)

    def to_public_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class InstanceCreateRequest:
    name: str
    repo_source_type: RepoSourceType
    repo_source_value: str
    linear_project: str
    linear_filters: dict[str, Any]
    http_port: int | None = None
    instance_dir: str | None = None
    workspace_root: str | None = None
    persistence_path: str | None = None
    log_path: str | None = None

@dataclass(frozen=True)
class InstancePatchRequest:
    name: str | None = None
    linear_project: str | None = None
    linear_filters: dict[str, Any] | None = None


class RunState(StrEnum):
    PLANNING = "planning"
    AWAITING_APPROVAL = "awaiting_approval"
    EXECUTING = "executing"
    BLOCKED = "blocked"
    FAILED = "failed"
    DONE = "done"


class TaskState(StrEnum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    BLOCKED = "blocked"
    DONE = "done"


class AttemptState(StrEnum):
    RUNNING = "running"
    WAITING = "waiting"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STALE = "stale"


class StaleAttemptError(RuntimeError):
    pass


class ConductorServiceError(Exception):
    def __init__(self, code: str, message: str, *, diagnostics: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or []


__all__ = [
    "AttemptState",
    "ConductorServiceError",
    "ConductorSettings",
    "InstanceCreateRequest",
    "InstancePatchRequest",
    "InstanceRecord",
    "LocalRuntimeIdentity",
    "ProcessStatus",
    "RepoSourceType",
    "RunState",
    "StaleAttemptError",
    "TaskState",
    "utc_now_iso",
]
