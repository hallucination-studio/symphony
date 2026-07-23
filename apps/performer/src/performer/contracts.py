from __future__ import annotations

from typing import Any

from contracts import decode_contract

BASE = "https://symphony.local/contracts/conductor-performer.schema.json#/$defs/"


def validate(name: str, value: Any) -> Any:
    try:
        return decode_contract(f"{BASE}{name}", value)
    except (TypeError, ValueError) as exc:
        labels = {
            "PerformerProfileControlMetadata": "Performer Profile control metadata",
            "PerformerProfileControlResult": "Performer Profile control result",
            "RootReconcilerObservation": "Root Reconciler observation",
            "RootDirective": "Root directive",
            "PlanResult": "Plan result",
            "WorkResult": "Work result",
            "VerifyResult": "Verify result",
        }
        raise ValueError(f"invalid {labels.get(name, name)}") from exc
