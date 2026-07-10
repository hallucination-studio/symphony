from __future__ import annotations

from typing import Any


def managed_run_ack_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "run_id",
            "parent_issue_id",
            "active_work_item_id",
            "managed_run_state",
            "plan_version",
            "backend_session_id",
        )
    }


def linear_payload_is_mutation(payload: dict[str, Any]) -> bool:
    query = str(payload.get("query") or "").lstrip().lower()
    return query.startswith("mutation") or "\nmutation" in query


def linear_installation_actor_is_app(installation: dict[str, Any] | None) -> bool:
    if not isinstance(installation, dict):
        return False
    actor = str(installation.get("actor") or installation.get("token_actor") or "").strip().lower()
    return actor in {"app", "application"}
