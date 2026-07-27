from __future__ import annotations

import hashlib
import json
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
        canonical_facts = _bootstrap_facts(bootstrap)
        record = self._sessions.open(
            session_id=session_id,
            role="root_reconciler",
            root_issue_id=root_issue_id,
            cycle_issue_id=None,
            settings=_settings(request),
        )
        try:
            result = self._roles.execute_root_reconciler(request)
            turn_result = _reconciler_turn_result(result, request, root_digest, canonical_facts)
            if turn_result.get("kind") == "root_reconciler_failed":
                continuity = _failure_continuity(turn_result)
                if continuity["kind"] == "closed":
                    self._sessions.close(record.session_id)
                elif continuity["append_outcome"] == "accepted":
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
            next_facts = _apply_delta(baseline.canonical_facts, delta)
            result = self._roles.execute_root_reconciler(execution_request)
            turn_result = _reconciler_turn_result(result, execution_request, target_digest, next_facts)
            if turn_result.get("kind") == "root_reconciler_failed":
                continuity = _failure_continuity(turn_result)
                if continuity["kind"] == "closed":
                    self._discard(session_id)
                elif continuity["append_outcome"] == "accepted":
                    _advance_baseline(baseline, next_facts, target_digest)
                return turn_result
            _advance_baseline(baseline, next_facts, target_digest)
            return turn_result
        except Exception:
            self._discard(session_id)
            raise

    def close(self, request: dict[str, Any]) -> dict[str, Any]:
        root_issue_id = _text(request, "root_issue_id")
        closed = self._sessions.close_root(root_issue_id=root_issue_id)
        for session_id in closed:
            self._baselines.pop(session_id, None)
        return {"root_issue_id": root_issue_id}

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
            "continuity": {
                "kind": "retained",
                "append_outcome": "accepted",
                "provider_visible_context_digest": expected_digest,
            },
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
    facts = {
        "root_snapshot": deepcopy(bootstrap["root_snapshot"]),
        "source_manifest": deepcopy(bootstrap["source_manifest"]),
        "coverage": deepcopy(bootstrap["coverage"]),
        "pending_input_ids": deepcopy(bootstrap["pending_input_ids"]),
    }
    _validate_manifest(facts["source_manifest"])
    if _root_digest(facts["source_manifest"]) != bootstrap["root_digest"]:
        raise RootReconcilerTurnError(
            "root_bootstrap_digest_invalid",
            "The Root bootstrap digest does not match its canonical source manifest.",
        )
    return facts


def _apply_delta(facts: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    next_facts = deepcopy(facts)
    snapshot = next_facts["root_snapshot"]
    manifest = _manifest_by_identity(next_facts["source_manifest"])
    changes = delta.get("changes")
    if not isinstance(changes, list):
        raise RootReconcilerTurnError("root_delta_invalid", "The Root delta changes are invalid.")
    identities = [_change_identity(change) for change in changes]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise RootReconcilerTurnError("root_delta_change_order_invalid", "The Root delta changes are not canonical.")
    for change, identity in zip(changes, identities, strict=True):
        operation = change.get("kind")
        current = manifest.get(identity)
        if operation == "current_value":
            if current is not None:
                raise RootReconcilerTurnError("root_delta_precondition_invalid", "The Root delta current-value precondition failed.")
        elif operation == "replacement":
            if current is None or change.get("replaces_source_version_or_digest") != current["source_version_or_digest"]:
                raise RootReconcilerTurnError("root_delta_precondition_invalid", "The Root delta replacement precondition failed.")
        elif operation == "tombstone":
            if current is None or change.get("removes_source_version_or_digest") != current["source_version_or_digest"]:
                raise RootReconcilerTurnError("root_delta_precondition_invalid", "The Root delta tombstone precondition failed.")
            _apply_tombstone(snapshot, change)
            manifest.pop(identity)
            continue
        else:
            raise RootReconcilerTurnError("root_delta_change_invalid", "The Root delta contains an unsupported operation.")
        value = change.get("value")
        if not isinstance(value, dict) or value.get("kind") != change.get("source_kind"):
            raise RootReconcilerTurnError("root_delta_value_invalid", "The Root delta value does not match its source kind.")
        _apply_current_value(snapshot, change, value)
        manifest[identity] = {
            "source_kind": change["source_kind"],
            "source_id": change["source_id"],
            "source_version_or_digest": change["source_version_or_digest"],
            "actor_kind": change["actor_kind"],
        }
    next_facts["source_manifest"] = [manifest[key] for key in sorted(manifest)]
    if _root_digest(next_facts["source_manifest"]) != delta.get("target_root_digest"):
        raise RootReconcilerTurnError("root_delta_digest_invalid", "The Root delta target digest is invalid.")
    _refresh_cycles(snapshot)
    next_facts["pending_input_ids"] = deepcopy(delta["pending_input_ids"])
    return next_facts


def _failure_continuity(result: dict[str, Any]) -> dict[str, Any]:
    failure = result.get("failure")
    continuity = failure.get("continuity") if isinstance(failure, dict) else None
    if not isinstance(continuity, dict):
        raise RootReconcilerTurnError("root_reconciler_failure_contract_invalid", "The Root failure continuity is invalid.")
    return continuity


def _advance_baseline(baseline: RootSessionBaseline, facts: dict[str, Any], target_digest: str) -> None:
    baseline.canonical_facts = facts
    baseline.previous_root_digest = baseline.root_digest
    baseline.root_digest = target_digest


def _validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, list):
        raise RootReconcilerTurnError("root_manifest_invalid", "The Root source manifest is invalid.")
    identities = [_manifest_identity(entry) for entry in manifest]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise RootReconcilerTurnError("root_manifest_invalid", "The Root source manifest is not canonical.")


def _manifest_by_identity(manifest: Any) -> dict[tuple[str, str], dict[str, Any]]:
    _validate_manifest(manifest)
    return {_manifest_identity(entry): deepcopy(entry) for entry in manifest}


def _manifest_identity(entry: Any) -> tuple[str, str]:
    if not isinstance(entry, dict):
        raise RootReconcilerTurnError("root_manifest_invalid", "The Root source manifest is invalid.")
    return (_text(entry, "source_kind"), _text(entry, "source_id"))


def _change_identity(change: Any) -> tuple[str, str]:
    if not isinstance(change, dict):
        raise RootReconcilerTurnError("root_delta_change_invalid", "The Root delta change is invalid.")
    return (_text(change, "source_kind"), _text(change, "source_id"))


def _root_digest(manifest: list[dict[str, Any]]) -> str:
    fragments = [
        [
            _text(entry, "source_kind"),
            _text(entry, "source_id"),
            _text(entry, "source_version_or_digest"),
            _text(entry, "actor_kind"),
        ]
        for entry in manifest
    ]
    fragments.sort(key=lambda fragment: (fragment[0], fragment[1]))
    encoded = json.dumps(fragments, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _apply_current_value(snapshot: dict[str, Any], change: dict[str, Any], value: dict[str, Any]) -> None:
    source_kind = change["source_kind"]
    source_id = change["source_id"]
    if source_kind == "git":
        snapshot["worktree_gate"] = deepcopy(value["worktree_gate"])
        return
    if source_kind == "mechanical_violation":
        snapshot["mechanical_violations"] = deepcopy(value["mechanical_violations"])
        snapshot["root"]["convergence"] = deepcopy(value["convergence"])
        return
    collection, id_key, value_key = {
        "issue": ("issues", "issue_id", "issue"),
        "comment": ("user_comments", "comment_id", "user_input"),
        "comment_thread": ("user_comment_thread_states", "comment_id", "thread_state"),
        "relation": ("relations", "relation_id", "relation"),
        "attachment": ("attachments", "attachment_id", "attachment"),
        "activity": ("activities", "activity_id", "activity"),
    }.get(source_kind, (None, None, None))
    if collection is None or id_key is None or value_key is None:
        raise RootReconcilerTurnError("root_delta_value_invalid", "The Root delta value source kind is invalid.")
    items = snapshot.get(collection)
    item = value.get(value_key)
    if not isinstance(items, list) or not isinstance(item, dict) or item.get(id_key) != source_id:
        raise RootReconcilerTurnError("root_delta_value_invalid", "The Root delta value identity is invalid.")
    items[:] = [existing for existing in items if isinstance(existing, dict) and existing.get(id_key) != source_id]
    items.append(deepcopy(item))
    if source_kind == "issue" and source_id == snapshot["root"]["issue"]["issue_id"]:
        snapshot["root"]["issue"] = deepcopy(item)


def _apply_tombstone(snapshot: dict[str, Any], change: dict[str, Any]) -> None:
    source_kind = change["source_kind"]
    source_id = change["source_id"]
    if source_kind in {"git", "mechanical_violation"}:
        raise RootReconcilerTurnError("root_delta_value_invalid", "Required Root context cannot be tombstoned.")
    collection, id_key = {
        "issue": ("issues", "issue_id"),
        "comment": ("user_comments", "comment_id"),
        "comment_thread": ("user_comment_thread_states", "comment_id"),
        "relation": ("relations", "relation_id"),
        "attachment": ("attachments", "attachment_id"),
        "activity": ("activities", "activity_id"),
    }.get(source_kind, (None, None))
    if collection is None or id_key is None:
        raise RootReconcilerTurnError("root_delta_value_invalid", "The Root tombstone source kind is invalid.")
    if source_kind == "issue" and source_id == snapshot["root"]["issue"]["issue_id"]:
        raise RootReconcilerTurnError("root_delta_value_invalid", "The Root Issue cannot be tombstoned.")
    items = snapshot.get(collection)
    if not isinstance(items, list):
        raise RootReconcilerTurnError("root_delta_fact_set_invalid", "The Root delta cannot advance the session fact set.")
    items[:] = [item for item in items if isinstance(item, dict) and item.get(id_key) != source_id]


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
