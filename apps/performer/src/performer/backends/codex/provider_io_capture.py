from __future__ import annotations

import json
import os
import stat
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from threading import Lock
from typing import Any, Mapping


PROVIDER_IO_CAPTURE_PATH_ENVIRONMENT_KEY = "SYMPHONY_PROVIDER_IO_CAPTURE_PATH"
_CORRELATION_KEYS = (
    "request_id",
    "root_issue_id",
    "cycle_issue_id",
    "target_issue_id",
    "reconciler_session_id",
    "reconciler_turn_id",
    "role_session_id",
    "role_turn_id",
    "stage_execution_id",
)


class ProviderIoCapture:
    """Opt-in local capture of the exact model-visible Provider boundary."""

    def __init__(self, path: Path) -> None:
        if not path.is_absolute() or len(str(path)) > 4_096 or any(character in str(path) for character in "\r\n\0"):
            raise ValueError("provider_io_capture_path_invalid")
        self._path = path
        self._lock = Lock()
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = self._open()
        os.close(descriptor)

    def record(
        self,
        event: str,
        *,
        role: str,
        session_capture_id: str,
        payload: Mapping[str, Any],
        turn_capture_id: str | None = None,
        request: Mapping[str, Any] | None = None,
    ) -> None:
        record: dict[str, Any] = {
            "capture_version": 1,
            "recorded_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "event": event,
            "role": role,
            "session_capture_id": session_capture_id,
            "payload": dict(payload),
        }
        if turn_capture_id is not None:
            record["turn_capture_id"] = turn_capture_id
        if request is not None:
            record["correlation"] = {
                key: value
                for key in _CORRELATION_KEYS
                if isinstance((value := request.get(key)), str) and value
            }
        encoded = (json.dumps(
            record,
            ensure_ascii=False,
            separators=(",", ":"),
            default=_json_value,
        ) + "\n").encode("utf-8")
        with self._lock:
            descriptor = self._open()
            try:
                offset = 0
                while offset < len(encoded):
                    written = os.write(descriptor, encoded[offset:])
                    if written < 1:
                        raise OSError("provider_io_capture_write_failed")
                    offset += written
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def _open(self) -> int:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self._path, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError("provider_io_capture_path_invalid")
            os.fchmod(descriptor, 0o600)
            return descriptor
        except Exception:
            os.close(descriptor)
            raise


def provider_io_capture_from_environment(
    environment: Mapping[str, str] | None = None,
) -> ProviderIoCapture | None:
    source = os.environ if environment is None else environment
    value = source.get(PROVIDER_IO_CAPTURE_PATH_ENVIRONMENT_KEY)
    if value is None:
        return None
    return ProviderIoCapture(Path(value))


def _json_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"provider_io_capture_value_invalid:{type(value).__name__}")
