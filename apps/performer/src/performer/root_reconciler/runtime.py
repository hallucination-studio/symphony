from __future__ import annotations

from typing import Any
from uuid import uuid4

from performer.role_execution.runtime import RoleExecutionRuntime
from performer.session_runtime.manager import SessionManager


class RootReconcilerRuntime:
    def __init__(self, sessions: SessionManager, roles: RoleExecutionRuntime) -> None:
        self._sessions = sessions
        self._roles = roles

    def open(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = f"root-reconciler-{uuid4()}"
        root_issue_id = _text(request, "root_issue_id")
        record = self._sessions.open(
            session_id=session_id,
            role="root_reconciler",
            root_issue_id=root_issue_id,
            cycle_issue_id=None,
            settings=_settings(request),
        )
        return {
            "reconciler_session_id": record.session_id,
            "root_issue_id": record.root_issue_id,
        }

    def advance(self, request: dict[str, Any]) -> dict[str, Any]:
        result = self._roles.execute_root_reconciler(request)
        directive = result.get("directive")
        if not isinstance(directive, dict):
            raise ValueError("root_directive_missing")
        if directive.get("protocol_version") == 1 and isinstance(directive.get("root_directive_id"), str):
            return result
        return {
            **result,
            "directive": {
                "protocol_version": "1",
                "request_id": request["request_id"],
                "root_directive_id": f"{request['root_issue_id']}:{request['role_turn_id']}",
                "reconciler_session_id": request["role_session_id"],
                "reconciler_turn_id": request["role_turn_id"],
                "based_on_root_tree_digest": request["observed_root_tree_digest"],
                "rationale": str(directive.get("rationale", "Provider returned a Root directive.")),
                "evidence_refs": directive.get("evidence_refs", []),
                "comment_dispositions": directive.get("comment_dispositions", []),
                "external_change_dispositions": directive.get("external_change_dispositions", []),
                "action": directive.get("action", directive),
            },
        }

    def close(self, request: dict[str, Any]) -> dict[str, Any]:
        root_issue_id = _text(request, "root_issue_id")
        self._sessions.close_root(root_issue_id=root_issue_id)
        return {"root_issue_id": root_issue_id, "closed": True}


def _settings(request: dict[str, Any]) -> dict[str, Any]:
    value = request.get("model_settings", {})
    if not isinstance(value, dict):
        raise ValueError("model_settings_invalid")
    return value


def _text(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key}_invalid")
    return value
