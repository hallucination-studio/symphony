from __future__ import annotations

import json
from enum import StrEnum
from typing import Any

from performer_api.managed_runs_enums import ManagedRunRuntimeRole


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None and str(item)]


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in {"", "none", "null", "all"}:
        return None
    return _int(value, default=0)


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _jsonable_dict(value: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _enum(enum: type[StrEnum], value: Any, default: Any) -> Any:
    if isinstance(value, enum):
        return value
    try:
        return enum(str(value))
    except ValueError:
        return default


def _runtime_role(value: Any) -> ManagedRunRuntimeRole:
    try:
        return ManagedRunRuntimeRole(str(value))
    except ValueError:
        return ManagedRunRuntimeRole.PLAN

