from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class RuntimeStatus(StrEnum):
    STARTING = "starting"
    READY = "ready"
    DEGRADED = "degraded"
    STOPPED = "stopped"


_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def _identifier(value: str, error_code: str) -> None:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(error_code)


def _positive_int(value: int, error_code: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(error_code)


@dataclass(frozen=True)
class DesiredBinding:
    binding_id: str
    project_id: str
    conductor_id: str
    generation: int
    active: bool = True

    def __post_init__(self) -> None:
        _identifier(self.binding_id, "binding_id_invalid")
        _identifier(self.project_id, "binding_project_id_invalid")
        _identifier(self.conductor_id, "binding_conductor_id_invalid")
        _positive_int(self.generation, "binding_generation_invalid")
        if not isinstance(self.active, bool):
            raise ValueError("binding_active_invalid")

    @property
    def desired_revision(self) -> int:
        return self.generation


@dataclass(frozen=True)
class RuntimeReport:
    binding_id: str
    generation: int
    instance_id: str
    status: RuntimeStatus
    heartbeat_at: int
    error_code: str | None = None

    def __post_init__(self) -> None:
        _identifier(self.binding_id, "binding_id_invalid")
        _positive_int(self.generation, "binding_generation_invalid")
        _identifier(self.instance_id, "runtime_instance_id_invalid")
        if len(self.instance_id) > 128:
            raise ValueError("runtime_instance_id_invalid")
        if (
            isinstance(self.heartbeat_at, bool)
            or not isinstance(self.heartbeat_at, int)
            or self.heartbeat_at < 0
        ):
            raise ValueError("runtime_heartbeat_invalid")
        if self.error_code is not None and (
            len(self.error_code) > 128
            or re.fullmatch(r"[a-z][a-z0-9_]*", self.error_code) is None
        ):
            raise ValueError("runtime_error_code_invalid")
