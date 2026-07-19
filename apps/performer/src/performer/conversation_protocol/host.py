from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from performer.backends.provider_backend_interface import ProviderBackendError
from performer.contracts import validate


class ConversationFileHost:
    def __init__(
        self,
        open_conversation: Callable[[dict[str, Any]], dict[str, Any]],
        *,
        now: Callable[[], str] | None = None,
    ) -> None:
        self._open_conversation = open_conversation
        self._now = now or _now

    def run(self, request_path: Path, result_path: Path) -> dict[str, Any]:
        command = validate(
            "OpenRootConversationCommand",
            json.loads(request_path.read_text(encoding="utf-8")),
        )
        try:
            opened = self._open_conversation(command)
            result = {
                "protocol_version": command["protocol_version"],
                "request_id": command["request_id"],
                "performer_profile_id": command["performer_profile_id"],
                "performer_id": opened["performer_id"],
                "completed_at": self._now(),
            }
        except ProviderBackendError as error:
            result = {
                "protocol_version": command["protocol_version"],
                "request_id": command["request_id"],
                "performer_profile_id": command["performer_profile_id"],
                "error_code": error.code,
                "sanitized_reason": error.sanitized_reason,
                "retryable": error.retryable,
                "action_required": error.action_required,
                "completed_at": self._now(),
            }
        result = validate("OpenRootConversationResult", result)
        temporary = result_path.with_suffix(result_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, result_path)
        return result


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
