from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .pipeline_enums import GateStep, RuntimeMode, SECRET_SETTING_KEYS


def sanitize_profile_settings(settings: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, value in settings.items():
        lowered = str(key).lower()
        if lowered in SECRET_SETTING_KEYS or any(secret in lowered for secret in ("token", "secret", "password", "cookie")):
            continue
        sanitized[str(key)] = value
    return sanitized


def _has_cycle(node_ids: set[str], edges: list[tuple[str, str]]) -> bool:
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    for source, target in edges:
        if source in node_ids and target in node_ids:
            adjacency[source].append(target)
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in visiting:
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        for target in adjacency.get(node_id, []):
            if visit(target):
                return True
        visiting.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in node_ids)


def _mode(value: Any) -> RuntimeMode:
    return value if isinstance(value, RuntimeMode) else RuntimeMode(str(value or RuntimeMode.EXECUTE.value))


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _merged_intent_payload(payload: dict[str, Any]) -> dict[str, Any]:
    base = _dict(payload.get("pipeline_intent"))
    override = _dict(payload.get("intent"))
    return _merge_non_empty_values(base, override)


def _merge_non_empty_values(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if _is_empty_intent_value(value):
            continue
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = _merge_non_empty_values(existing, value)
            continue
        merged[key] = value
    return merged


def _is_empty_intent_value(value: Any) -> bool:
    return value is None or value == {} or value == [] or value == ""


def _jsonable_dict(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None and str(item)]


def _gate_steps(value: Any) -> list[GateStep]:
    if not isinstance(value, list):
        return []
    return [GateStep.from_obj(item) for item in value if item is not None]


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_time(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
