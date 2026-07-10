from __future__ import annotations

from typing import Any


def _sdk_event_to_dict(event: Any) -> dict[str, Any] | None:
    raw = _sdk_event_raw(event)
    name = raw.get("event") or raw.get("type") or raw.get("method")
    if not isinstance(name, str):
        return None
    params = raw.get("params") if isinstance(raw.get("params"), dict) else raw
    payload = {**params, "type": name}
    mapped = {"event": f"sdk_{name.replace('.', '_').replace('/', '_')}", "backend": "sdk", "payload": payload}
    for key in ("message", "command", "exit_code", "usage", "turn_id", "thread_id"):
        if key in payload:
            mapped[key] = payload[key]
    return mapped


def _sdk_event_raw(event: Any) -> dict[str, Any]:
    if isinstance(event, dict):
        return dict(event)
    model_dump = getattr(event, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(by_alias=True)
        if isinstance(dumped, dict):
            return dumped
    return {
        key: getattr(event, key)
        for key in ("method", "params", "type", "event", "message", "command", "exit_code", "usage", "turn_id", "thread_id")
        if hasattr(event, key)
    }


__all__ = ["_sdk_event_to_dict"]
