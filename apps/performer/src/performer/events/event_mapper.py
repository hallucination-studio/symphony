from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from performer.contracts import validate


def root_turn_event(
    command: dict[str, Any], sequence: int, body: dict[str, Any]
) -> dict[str, Any]:
    return validate(
        "RootTurnEvent",
        {
            "protocol_version": command["protocol_version"],
            "turn_id": command["turn_id"],
            "root_issue_id": command["root_issue_id"],
            "performer_profile_id": command["performer_profile_id"],
            "performer_id": command["performer_id"],
            "context_digest": command["context_digest"],
            "sequence": sequence,
            "occurred_at": datetime.now(UTC).isoformat(),
            "body": body,
        },
    )
