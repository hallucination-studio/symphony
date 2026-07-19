from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from performer.turn_protocol.contract_adapter import validate


def turn_event(
    command: dict[str, Any], sequence: int, body: dict[str, Any]
) -> dict[str, Any]:
    event = {
        "protocol_version": command["protocol_version"],
        "turn_id": command["turn_id"],
        "root_issue_id": command["root_issue_id"],
        "sequence": sequence,
        "occurred_at": datetime.now(UTC).isoformat(),
        "body": body,
    }
    if "work_issue_id" in command:
        event["work_issue_id"] = command["work_issue_id"]
    return validate("PerformerTurnEvent", event)
