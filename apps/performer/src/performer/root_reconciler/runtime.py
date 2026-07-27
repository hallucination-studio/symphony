from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from contracts import SCHEMA_REGISTRY, decode_contract
from performer.contracts import validate
from performer.role_execution.runtime import RoleExecutionRuntime
from performer.root_reconciler.comment_replies import pending_comment_reply_sources_from_snapshot
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
            canonical_facts = _bootstrap_facts(bootstrap)
            result = self._roles.execute_root_reconciler(request)
            turn_result = _reconciler_turn_result(result, request, root_digest, canonical_facts)
            if turn_result.get("kind") == "root_reconciler_failed":
                self._sessions.close(record.session_id)
                return {
                    "reconciler_session_id": record.session_id,
                    "bootstrap_root_digest": root_digest,
                    "initial_result": turn_result,
                }
            self._baselines[record.session_id] = RootSessionBaseline(
                root_issue_id=root_issue_id,
                root_digest=root_digest,
                canonical_facts=canonical_facts,
                previous_root_digest=None,
            )
            return {
                "reconciler_session_id": record.session_id,
                "bootstrap_root_digest": root_digest,
                "initial_result": turn_result,
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
            if result.get("kind") == "root_reconciler_failed":
                turn_result = _reconciler_turn_result(result, execution_request, target_digest, baseline.canonical_facts)
            else:
                next_facts = _apply_delta(baseline.canonical_facts, delta)
                turn_result = _reconciler_turn_result(result, execution_request, target_digest, next_facts)
            if turn_result.get("kind") == "root_reconciler_failed":
                self._discard(session_id)
                return turn_result
            baseline.canonical_facts = next_facts
            baseline.previous_root_digest = baseline.root_digest
            baseline.root_digest = target_digest
            return turn_result
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


def _reconciler_turn_result(
    result: dict[str, Any],
    request: dict[str, Any],
    expected_digest: str,
    canonical_facts: dict[str, Any],
) -> dict[str, Any]:
    if result.get("kind") == "root_reconciler_failed":
        return _validate_failure_result(result, request, expected_digest)
    try:
        return _successful_directive(result, request, expected_digest, canonical_facts)
    except RootReconcilerTurnError as error:
        return _failure_from_invalid_directive(result, request, expected_digest, error)


def _successful_directive(
    directive: dict[str, Any],
    request: dict[str, Any],
    expected_digest: str,
    canonical_facts: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(directive, dict):
        raise RootReconcilerTurnError("root_directive_missing", "The Root Reconciler turn did not produce a directive.")
    validated = _validate_directive(directive)
    if validated["reconciler_session_id"] != request["reconciler_session_id"]:
        raise RootReconcilerTurnError("root_directive_session_mismatch", "The Root directive session does not match the request.")
    if validated["reconciler_turn_id"] != request["reconciler_turn_id"]:
        raise RootReconcilerTurnError("root_directive_turn_mismatch", "The Root directive turn does not match the request.")
    if validated["based_on_target_root_digest"] != expected_digest:
        raise RootReconcilerTurnError("root_directive_digest_mismatch", "The Root directive does not match the requested facts.")
    _validate_comment_replies(validated, canonical_facts)
    return validated


def _validate_comment_replies(directive: dict[str, Any], canonical_facts: dict[str, Any]) -> None:
    snapshot = canonical_facts.get("root_snapshot")
    pending = canonical_facts.get("pending_input_ids")
    if not isinstance(snapshot, dict) or not isinstance(pending, list):
        raise RootReconcilerTurnError("root_pending_inputs_invalid", "The Root turn inputs are invalid.")
    expected = {
        source["source_input_id"]: source["source"]
        for source in pending_comment_reply_sources_from_snapshot(snapshot, pending)
    }
    replies = directive["comment_replies"]
    actual = [reply.get("source_input_id") for reply in replies]
    if len(actual) != len(expected) or len(set(actual)) != len(actual):
        raise RootReconcilerTurnError(
            "root_directive_comment_replies_invalid",
            "The Root directive comment replies do not match the pending user comment inputs.",
        )
    for reply in replies:
        source_input_id = reply.get("source_input_id")
        if expected.get(source_input_id) != reply.get("source"):
            raise RootReconcilerTurnError(
                "root_directive_comment_replies_invalid",
                "The Root directive comment replies do not match the pending user comment inputs.",
            )


def _validate_failure_result(value: dict[str, Any], request: dict[str, Any], expected_digest: str) -> dict[str, Any]:
    try:
        validated = validate("RootReconcilerTurnFailure", value)
    except ValueError as error:
        raise RootReconcilerTurnError(
            "root_reconciler_failure_contract_invalid",
            "The Root Reconciler failure did not match its closed contract.",
        ) from error
    failure = validated["failure"]
    turn = failure["model_turn"]
    if (
        validated["root_issue_id"] != request["root_issue_id"] or
        failure["reconciler_session_id"] != request["reconciler_session_id"] or
        failure["reconciler_turn_id"] != request["reconciler_turn_id"] or
        failure["target_root_digest"] != expected_digest or
        turn["root_issue_id"] != request["root_issue_id"] or
        turn["reconciler_session_id"] != request["reconciler_session_id"] or
        turn["reconciler_turn_id"] != request["reconciler_turn_id"] or
        turn["turn_record_id"] != f"{request['root_issue_id']}:{request['reconciler_turn_id']}" or
        turn["outcome"] != failure["category"] or
        turn["terminal_at"] != failure["failed_at"] or
        (turn["invocation_state"] == "ambiguous" and turn["usage"]["status"] != "unavailable")
    ):
        raise RootReconcilerTurnError(
            "root_reconciler_failure_correlation_invalid",
            "The Root Reconciler failure does not match the requested turn.",
        )
    return validated


def _failure_from_invalid_directive(
    directive: dict[str, Any],
    request: dict[str, Any],
    expected_digest: str,
    error: RootReconcilerTurnError,
) -> dict[str, Any]:
    model_turn = directive.get("model_turn")
    if not isinstance(model_turn, dict):
        raise error
    try:
        validated_turn = validate("RootReconcilerModelTurnRecord", model_turn)
    except ValueError:
        raise error
    category = "stale_output" if error.code.endswith(("session_mismatch", "turn_mismatch", "digest_mismatch")) else "schema_invalid"
    failed_turn = {**validated_turn, "outcome": category}
    return _validate_failure_result({
        "protocol_version": "1",
        "request_id": request["request_id"],
        "kind": "root_reconciler_failed",
        "root_issue_id": request["root_issue_id"],
        "failure": {
            "failure_id": f"{request['root_issue_id']}:{request['reconciler_turn_id']}:failure",
            "reconciler_session_id": request["reconciler_session_id"],
            "reconciler_turn_id": request["reconciler_turn_id"],
            "target_root_digest": expected_digest,
            "attempted_input_ids": _attempted_input_ids(request),
            "model_turn": failed_turn,
            "category": category,
            "sanitized_reason": error.sanitized_reason,
            "failed_at": failed_turn["terminal_at"],
        },
    }, request, expected_digest)


def _attempted_input_ids(request: dict[str, Any]) -> list[str]:
    if request.get("kind") == "open_root_reconciler":
        source = request.get("bootstrap")
    else:
        source = request.get("delta")
    if not isinstance(source, dict):
        raise RootReconcilerTurnError("root_pending_inputs_invalid", "The Root turn inputs are invalid.")
    pending = source.get("pending_input_ids")
    if not isinstance(pending, list) or any(not isinstance(input_id, str) or not input_id for input_id in pending):
        raise RootReconcilerTurnError("root_pending_inputs_invalid", "The Root turn inputs are invalid.")
    return pending


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
        if kind == "worktree_gate_current_value":
            snapshot["worktree_gate"] = deepcopy(change["worktree_gate"])
            continue
        if kind == "mechanical_violations_current_value":
            snapshot["mechanical_violations"] = deepcopy(change["mechanical_violations"])
            continue
        if kind == "convergence_current_value":
            root = snapshot.get("root")
            convergence = change.get("convergence")
            if not isinstance(root, dict) or not isinstance(convergence, dict):
                raise RootReconcilerTurnError("root_delta_fact_set_invalid", "The Root delta cannot advance the session fact set.")
            root["convergence"] = deepcopy(convergence)
            continue
        if kind == "comment_removed":
            comment_id = _text(change, "source_id")
            _remove_comment_facts(snapshot, comment_id)
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
    _refresh_cycles(snapshot)
    next_facts["pending_input_ids"] = deepcopy(delta["pending_input_ids"])
    return next_facts


def _remove_comment_facts(snapshot: dict[str, Any], comment_id: str) -> None:
    for collection in ("user_comments", "user_comment_thread_states"):
        items = snapshot.get(collection)
        if not isinstance(items, list):
            raise RootReconcilerTurnError("root_delta_fact_set_invalid", "The Root delta cannot advance the session fact set.")
        items[:] = [item for item in items if item.get("comment_id") != comment_id]


def _refresh_cycles(snapshot: dict[str, Any]) -> None:
    issues = snapshot.get("issues")
    relations = snapshot.get("relations")
    if not isinstance(issues, list) or not isinstance(relations, list):
        raise RootReconcilerTurnError("root_delta_fact_set_invalid", "The Root delta cannot advance the session fact set.")
    by_id = {issue.get("issue_id"): issue for issue in issues if isinstance(issue, dict)}
    cycles: list[dict[str, Any]] = []
    for cycle in issues:
        if not isinstance(cycle, dict) or cycle.get("issue_kind") != "cycle":
            continue
        cycle_id = cycle.get("issue_id")
        descendants: set[str] = set()
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            current = issue.get("parent_issue_id")
            visited: set[str] = set()
            while isinstance(current, str) and current not in visited:
                visited.add(current)
                if current == cycle_id:
                    descendants.add(_text(issue, "issue_id"))
                    break
                parent = by_id.get(current)
                current = parent.get("parent_issue_id") if isinstance(parent, dict) else None
        cycles.append({
            "cycle_issue": deepcopy(cycle),
            "cycle_status": _text(cycle, "status"),
            "is_archived": cycle.get("is_archived"),
            "issues": [deepcopy(issue) for issue in issues if isinstance(issue, dict) and issue.get("issue_id") in descendants],
            "relations": [deepcopy(relation) for relation in relations if isinstance(relation, dict) and relation.get("source_issue_id") in descendants and relation.get("target_issue_id") in descendants],
        })
    snapshot["cycles"] = cycles


def _change_target(kind: str) -> tuple[str, str, str | None]:
    if kind in {"issue_current_value", "issue_detached"}:
        return "issues", "issue_id", "issue" if kind.endswith("current_value") else None
    if kind in {"comment_current_value", "comment_removed"}:
        return "user_comments", "comment_id", "user_input" if kind.endswith("current_value") else None
    if kind == "comment_thread_state_current_value":
        return "user_comment_thread_states", "comment_id", "thread_state"
    if kind in {"relation_current_value", "relation_removed"}:
        return "relations", "relation_id", "relation" if kind.endswith("current_value") else None
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
