from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from performer.role_execution.runtime import RoleExecutionRuntime
from performer.session_runtime.manager import SessionManager
from contracts import SCHEMA_REGISTRY, decode_contract
from performer.contracts import validate


class RootReconcilerTurnError(ValueError):
    def __init__(self, code: str, sanitized_reason: str) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.sanitized_reason = sanitized_reason


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
        if directive.get("kind") in {"execution_failed", "canceled"}:
            code = directive.get("error_code")
            if not isinstance(code, str) or not code:
                code = "root_reconciler_turn_canceled" if directive["kind"] == "canceled" else "root_reconciler_turn_failed"
            reason = directive.get("sanitized_reason")
            if not isinstance(reason, str) or not reason:
                reason = "The Root Reconciler turn did not produce a directive."
            raise RootReconcilerTurnError(code, reason)
        root_issue_id = request["root"]["issue"]["issue_id"]
        if directive.get("protocol_version") == "1" and isinstance(directive.get("root_directive_id"), str):
            return _validate_directive(directive)
        return _validate_directive(
            {
                "protocol_version": "1",
                "request_id": request["request_id"],
                "root_directive_id": f"{root_issue_id}:{request['reconciler_turn_id']}",
                "reconciler_session_id": request["reconciler_session_id"],
                "reconciler_turn_id": request["reconciler_turn_id"],
                "based_on_root_tree_digest": request["observed_root_tree_digest"],
                "rationale": str(directive.get("rationale", "Provider returned a Root directive.")),
                "evidence_refs": directive.get("evidence_refs", []),
                "comment_dispositions": directive.get("comment_dispositions", []),
                "external_change_dispositions": directive.get("external_change_dispositions", []),
                "action": directive.get("action", directive),
            },
        )

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


def _validate_directive(value: dict[str, Any]) -> dict[str, Any]:
    try:
        return validate("RootDirective", value)
    except ValueError as error:
        raise RootReconcilerTurnError(_root_directive_contract_code(value, error), "The Root directive did not match its closed contract.") from error


def _root_directive_contract_code(value: dict[str, Any], error: ValueError) -> str:
    detail = str(error.__cause__ or error)
    if "expected exactly one union variant" in detail:
        action = value.get("action")
        kind = action.get("kind") if isinstance(action, dict) else None
        if not isinstance(kind, str):
            return "root_directive_action_kind_invalid"
        action_definition = _action_definition_name(kind)
        if action_definition is None:
            return "root_directive_action_kind_invalid"
        try:
            decode_contract(
                f"https://symphony.local/contracts/conductor-performer.schema.json#/$defs/{action_definition}",
                action,
            )
        except ValueError as action_error:
            return _action_contract_code(kind, str(action_error))
        return "root_directive_action_union_invalid"
    if "unknown field" in detail:
        return "root_directive_unknown_field"
    if "missing required field" in detail:
        return "root_directive_required_field_missing"
    return "root_directive_contract_invalid"


def _action_definition_name(kind: str) -> str | None:
    schema = SCHEMA_REGISTRY["https://symphony.local/contracts/conductor-performer.schema.json"]
    for name, definition in schema["$defs"].items():
        if not isinstance(definition, dict):
            continue
        properties = definition.get("properties")
        action_kind = properties.get("kind", {}).get("const") if isinstance(properties, dict) else None
        if action_kind == kind:
            return name
    return None


def _action_contract_code(kind: str, detail: str) -> str:
    prefix = f"root_directive_{kind}"
    missing = re.search(r"missing required field ([A-Za-z0-9_]+)", detail)
    if missing:
        return f"{prefix}_missing_{missing.group(1)}"
    if "unknown field" in detail:
        return f"{prefix}_unknown_field"
    if "expected constant" in detail or "closed enum" in detail:
        return f"{prefix}_value_invalid"
    field_type = re.search(r"\$\.([A-Za-z0-9_]+): expected (object|array|string|boolean|number|integer)", detail)
    if field_type:
        return f"{prefix}_{field_type.group(1)}_type_invalid"
    return f"{prefix}_invalid"
