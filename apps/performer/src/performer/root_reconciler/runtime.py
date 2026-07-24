from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from contracts import SCHEMA_REGISTRY, decode_contract
from performer.contracts import validate
from performer.role_execution.runtime import RoleExecutionRuntime
from performer.session_runtime.manager import SessionError, SessionManager


class RootReconcilerTurnError(ValueError):
    def __init__(self, code: str, sanitized_reason: str) -> None:
        super().__init__(sanitized_reason)
        self.code = code
        self.sanitized_reason = sanitized_reason


@dataclass
class RootSessionBaseline:
    root_issue_id: str
    root_digest: str
    canonical_facts: dict[str, Any]
    previous_root_digest: str | None


class RootReconcilerRuntime:
    def __init__(self, sessions: SessionManager, roles: RoleExecutionRuntime) -> None:
        self._sessions = sessions
        self._roles = roles
        self._baselines: dict[str, RootSessionBaseline] = {}

    def open(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = _text(request, "reconciler_session_id")
        root_issue_id = _text(request, "root_issue_id")
        bootstrap = request.get("bootstrap")
        if not isinstance(bootstrap, dict):
            raise RootReconcilerTurnError("root_bootstrap_invalid", "The Root bootstrap is invalid.")
        root_digest = _text(bootstrap, "root_digest")
        record = self._sessions.open(
            session_id=session_id,
            role="root_reconciler",
            root_issue_id=root_issue_id,
            cycle_issue_id=None,
            settings=_settings(request),
        )
        try:
            result = self._roles.execute_root_reconciler(request)
            directive = _successful_directive(result, request, root_digest)
            self._baselines[record.session_id] = RootSessionBaseline(
                root_issue_id=root_issue_id,
                root_digest=root_digest,
                canonical_facts=_bootstrap_facts(bootstrap),
                previous_root_digest=None,
            )
            return {
                "reconciler_session_id": record.session_id,
                "bootstrap_root_digest": root_digest,
                "initial_directive": directive,
            }
        except Exception:
            self._sessions.close(record.session_id)
            raise

    def advance(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = _text(request, "reconciler_session_id")
        baseline = self._baselines.get(session_id)
        if baseline is None:
            raise RootReconcilerTurnError(
                "root_reconciler_bootstrap_required",
                "The Root Reconciler session baseline is unavailable; open a fresh session with a complete bootstrap.",
            )
        try:
            self._sessions.get(
                session_id,
                role="root_reconciler",
                root_issue_id=baseline.root_issue_id,
                cycle_issue_id=None,
            )
        except SessionError as error:
            self._baselines.pop(session_id, None)
            raise RootReconcilerTurnError(
                "root_reconciler_bootstrap_required",
                "The Root Reconciler Provider session is unavailable; open a fresh session with a complete bootstrap.",
            ) from error

        delta = request.get("delta")
        if not isinstance(delta, dict):
            raise RootReconcilerTurnError("root_delta_invalid", "The Root delta is invalid.")
        base_digest = _text(delta, "base_root_digest")
        target_digest = _text(delta, "target_root_digest")
        if base_digest != baseline.root_digest:
            code = "root_delta_stale" if base_digest == baseline.previous_root_digest else "root_delta_discontinuous"
            self._discard(session_id)
            raise RootReconcilerTurnError(
                code,
                "The Root delta does not continue the active session baseline; open a fresh session with a complete bootstrap.",
            )

        execution_request = {**request, "root_issue_id": baseline.root_issue_id}
        try:
            result = self._roles.execute_root_reconciler(execution_request)
            directive = _successful_directive(result, execution_request, target_digest)
            baseline.canonical_facts = _apply_delta(baseline.canonical_facts, delta)
            baseline.previous_root_digest = baseline.root_digest
            baseline.root_digest = target_digest
            return directive
        except Exception:
            self._discard(session_id)
            raise

    def close(self, request: dict[str, Any]) -> dict[str, Any]:
        root_issue_id = _text(request, "root_issue_id")
        closed = self._sessions.close_root(root_issue_id=root_issue_id)
        for session_id in closed:
            self._baselines.pop(session_id, None)
        return {"root_issue_id": root_issue_id, "closed": True}

    def _discard(self, session_id: str) -> None:
        self._baselines.pop(session_id, None)
        self._sessions.close(session_id)


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


def _successful_directive(result: dict[str, Any], request: dict[str, Any], expected_digest: str) -> dict[str, Any]:
    directive = result.get("directive")
    if not isinstance(directive, dict):
        raise RootReconcilerTurnError("root_directive_missing", "The Root Reconciler turn did not produce a directive.")
    if directive.get("kind") in {"execution_failed", "canceled"}:
        code = directive.get("error_code")
        if not isinstance(code, str) or not code:
            code = "root_reconciler_turn_canceled" if directive["kind"] == "canceled" else "root_reconciler_turn_failed"
        reason = directive.get("sanitized_reason")
        if not isinstance(reason, str) or not reason:
            reason = "The Root Reconciler turn did not produce a directive."
        raise RootReconcilerTurnError(code, reason)
    validated = _validate_directive(directive)
    if validated["reconciler_session_id"] != request["reconciler_session_id"]:
        raise RootReconcilerTurnError("root_directive_session_mismatch", "The Root directive session does not match the request.")
    if validated["reconciler_turn_id"] != request["reconciler_turn_id"]:
        raise RootReconcilerTurnError("root_directive_turn_mismatch", "The Root directive turn does not match the request.")
    if validated["based_on_target_root_digest"] != expected_digest:
        raise RootReconcilerTurnError("root_directive_digest_mismatch", "The Root directive does not match the requested facts.")
    return validated


def _bootstrap_facts(bootstrap: dict[str, Any]) -> dict[str, Any]:
    return {
        "root_snapshot": deepcopy(bootstrap["root_snapshot"]),
        "source_manifest": deepcopy(bootstrap["source_manifest"]),
        "coverage": deepcopy(bootstrap["coverage"]),
        "pending_input_ids": deepcopy(bootstrap["pending_input_ids"]),
    }


def _apply_delta(facts: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    next_facts = deepcopy(facts)
    snapshot = next_facts["root_snapshot"]
    for change in delta["changes"]:
        kind = change["kind"]
        if kind == "git_facts_current_value":
            snapshot["git_facts"] = deepcopy(change["git_facts"])
            continue
        if kind == "mechanical_violations_current_value":
            snapshot["mechanical_violations"] = deepcopy(change["mechanical_violations"])
            continue
        collection, nested_key, nested_value = _change_target(kind)
        items = snapshot.get(collection)
        if not isinstance(items, list):
            raise RootReconcilerTurnError("root_delta_fact_set_invalid", "The Root delta cannot advance the session fact set.")
        source_id = change["source_id"]
        items[:] = [item for item in items if item.get(nested_key) != source_id]
        if nested_value is not None:
            items.append(deepcopy(change[nested_value]))
        if collection == "issues" and source_id == snapshot["root"]["issue"]["issue_id"] and nested_value is not None:
            snapshot["root"]["issue"] = deepcopy(change[nested_value])
    next_facts["pending_input_ids"] = deepcopy(delta["pending_input_ids"])
    return next_facts


def _change_target(kind: str) -> tuple[str, str, str | None]:
    if kind in {"issue_current_value", "issue_detached"}:
        return "issues", "issue_id", "issue" if kind.endswith("current_value") else None
    if kind in {"comment_current_value", "comment_removed"}:
        return "user_comments", "comment_id", "comment" if kind.endswith("current_value") else None
    if kind in {"relation_current_value", "relation_removed"}:
        return "relations", "relation_id", "relation" if kind.endswith("current_value") else None
    if kind in {"managed_record_current_value", "managed_record_removed"}:
        return "managed_records", "record_id", "record" if kind.endswith("current_value") else None
    if kind == "git_facts_current_value":
        return "git_facts", "source_id", "git_facts"
    if kind == "mechanical_violations_current_value":
        return "mechanical_violations", "source_id", "mechanical_violations"
    raise RootReconcilerTurnError("root_delta_change_invalid", "The Root delta contains an unsupported fact change.")


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
    field = re.search(r"\$\.([A-Za-z0-9_]+)", detail)
    if field:
        return f"{prefix}_{field.group(1)}_invalid"
    return f"{prefix}_invalid"
