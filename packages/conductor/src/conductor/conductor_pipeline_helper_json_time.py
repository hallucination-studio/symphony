from __future__ import annotations

from .conductor_pipeline_helper_common import *


def _jsonable(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value))
    except TypeError:
        return str(value)

def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))

def _json_loads(payload: str) -> dict[str, Any]:
    value = json.loads(payload)
    return value if isinstance(value, dict) else {}

def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

def _format_time(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")

def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _utc(parsed)

def _recently_observed_process_exit(instance: Any, *, at: datetime) -> bool:
    observed_at = _parse_time(getattr(instance, "updated_at", None))
    if observed_at is None:
        return False
    return (_utc(at) - observed_at).total_seconds() < _PROCESS_EXIT_RESULT_GRACE_SECONDS
