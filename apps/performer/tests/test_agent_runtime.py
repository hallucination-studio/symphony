from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

from performer.agent_protocol.host import AgentProtocolHost
from performer.backends.provider_backend_interface import (
    ProviderSession,
    ProviderTurnAcceptanceUnknown,
    ProviderTurnAcceptedInvalid,
    ProviderTurnAcceptedValid,
    ProviderTurnFailure,
    ProviderTurnNotAccepted,
)
from performer.contracts import validate
from performer.root_reconciler.comment_replies import pending_comment_reply_sources_from_request

EMPTY_CONTEXT_DIGEST = sha256(b"[]").hexdigest()


def accepted(output: dict[str, object]) -> ProviderTurnAcceptedValid:
    return ProviderTurnAcceptedValid(
        output=output,
        usage={"status": "unavailable", "reason": "provider_omitted"},
    )


def provider_failure(code: str, reason: str, *, retryable: bool) -> ProviderTurnFailure:
    return ProviderTurnFailure(
        code=code,
        sanitized_reason=reason,
        retryable=retryable,
        action_required="Fresh-read native facts before deciding the next turn.",
    )


class FakeBackend:
    def __init__(self) -> None:
        self.opened: list[str] = []
        self.turns: list[tuple[str, dict[str, object], Path | None]] = []
        self.closed: list[str] = []

    def open_role_session(self, role: str, settings: dict[str, object]) -> ProviderSession:
        handle = f"provider-{len(self.opened) + 1}"
        self.opened.append(f"{role}:{handle}")
        return ProviderSession(role, handle, settings)

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        self.turns.append((session.provider_handle, request, workspace_root))
        if session.role == "root_reconciler":
            return accepted({
                "rationale": "The Root requirement is already defined.",
                "evidence_refs": [{"reference_id": "fact-1", "source_kind": "result"}],
                "consumed_input_ids": [],
                "comment_dispositions": [],
                "intent": {"kind": "answer_comments", "reason": "no_requirement_change"},
            })
        return ProviderTurnAcceptedValid(
            output={"kind": "canceled", "sanitized_reason": "test cancellation"},
            usage={
                "status": "measured",
                "input_tokens": 1,
                "cached_input_tokens": 0,
                "output_tokens": 1,
                "reasoning_output_tokens": 0,
                "total_tokens": 2,
            },
        )

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


class RootFailureBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return ProviderTurnAcceptanceUnknown(
                provider_failure("provider_turn_failed", "provider turn failed", retryable=True),
            )
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class RootSchemaFailureBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return ProviderTurnNotAccepted(
                provider_failure(
                    "provider_schema_unsupported",
                    "The Provider rejected the structured response schema.",
                    retryable=False,
                ),
            )
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class RootAppendFailureBackend(FakeBackend):
    def __init__(self, append_outcome: str) -> None:
        super().__init__()
        self.append_outcome = append_outcome

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler" and request.get("kind") == "advance_root_reconciler":
            failure = provider_failure(
                f"provider_append_{self.append_outcome}",
                "provider append failed",
                retryable=True,
            )
            if self.append_outcome == "not_accepted":
                return ProviderTurnNotAccepted(failure)
            if self.append_outcome == "accepted":
                return ProviderTurnAcceptedInvalid(failure)
            return ProviderTurnAcceptanceUnknown(failure)
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class InvalidRootDirectiveBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return accepted({
                "rationale": "Missing evidence.",
                "evidence_refs": [],
                "consumed_input_ids": [],
                "comment_dispositions": [],
                "intent": {"kind": "answer_comments"},
            })
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class CreateRootWorkspaceBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return accepted({
                "rationale": "The Root needs its deterministic workspace.",
                "evidence_refs": [],
                "consumed_input_ids": [],
                "comment_replies": [],
                "action": {
                    "kind": "create_root_workspace",
                    "root_issue_id": "root-1",
                    "expected_root_remote_version": "root-v1",
                    "expected_worktree_gate": {
                        "kind": "fresh_missing",
                        "repository_identity": "repository-1",
                        "base_branch": "main",
                        "base_revision": "base-1",
                    },
                },
            })
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class UnexpectedCommentReplyBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return accepted({
                "rationale": "Start planning.",
                "evidence_refs": [],
                "consumed_input_ids": [],
                "comment_dispositions": [{
                    "kind": "answer_only",
                    "source_input_id": "input:" + "0" * 64,
                    "source": {
                        "kind": "comment_body",
                        "comment_id": "comment-1",
                        "comment_body_digest": "0" * 64,
                    },
                    "answer": "Planning will begin.",
                }],
                "intent": {"kind": "answer_comments", "reason": "no_requirement_change"},
            })
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class MatchingCommentReplyBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            source = pending_comment_reply_sources_from_request(request)[0]
            return accepted({
                "rationale": "The comment is accepted.",
                "evidence_refs": [],
                "consumed_input_ids": [source["source_input_id"]],
                "comment_dispositions": [{
                    "kind": "answer_only",
                    "source_input_id": source["source_input_id"],
                    "source": source["source"],
                    "answer": "Planning will begin.",
                }],
                "intent": {"kind": "answer_comments", "reason": "no_requirement_change"},
            })
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


def envelope(request_id: str, kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"protocol_version": "1", "request_id": request_id, "kind": kind, **payload}


def fragment_digest(manifest: list[dict[str, object]]) -> str:
    fragments = sorted([
        [entry["source_kind"], entry["source_id"], entry["source_version_or_digest"], entry["actor_kind"]]
        for entry in manifest
    ])
    return sha256(json.dumps(fragments, separators=(",", ":")).encode()).hexdigest()


def root_manifest(version: str = "root-v1") -> list[dict[str, object]]:
    return [{
        "source_kind": "issue",
        "source_id": "root-1",
        "source_version_or_digest": version,
        "actor_kind": "human",
    }]


def root_bootstrap(root_digest: str | None = None) -> dict[str, object]:
    manifest = root_manifest()
    return {
        "root_snapshot": {
            "root": {
                "issue": {
                    "issue_id": "root-1", "identifier": "SYM-1", "issue_kind": "root",
                    "title": "Root", "description": "Root description", "status": "Todo",
                    "order": 0, "is_archived": False, "labels": [], "remote_version": "root-v1",
                    "created_at": "2026-07-23T00:00:00Z",
                },
                "objective": "Complete the root objective",
                "scope": "The requested root scope",
                "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The objective is complete", "verification_method": "automated test"}],
                "constraints": [],
                "root_status": "Todo",
                "convergence": convergence_snapshot(),
            },
            "cycles": [],
            "issues": [],
            "relations": [],
            "attachments": [],
            "activities": [],
            "user_comments": [],
            "user_comment_thread_states": [],
            "worktree_gate": {
                "kind": "valid",
                "repository_identity": "repository-1",
                "branch": "symphony/root-1",
                "head_revision": "head-1",
                "is_clean": True,
                "changed_paths": [],
            },
            "mechanical_violations": [],
        },
        "source_manifest": manifest,
        "coverage": {"is_complete": True, "omissions": []},
        "root_digest": root_digest or fragment_digest(manifest),
    }


def requirement_command(pending_input_ids: list[str] | None = None) -> dict[str, object]:
    return {
        "semantic_gate": "requirement_and_comment",
        "trigger": "human_comment" if pending_input_ids else "initial_definition",
        "pending_input_refs": [
            {
                "source_kind": "comment_body",
                "input_id": input_id,
                "native_source_identity": input_id,
                "source_version_or_digest": "pending-v1",
            }
            for input_id in (pending_input_ids or [])
        ],
        "expected_output_contract": "requirement_and_comment_intent.v1",
        "subject": {
            "root_definition_version_or_digest": "root-v1",
            "active_cycle_state": "absent",
        },
    }


def open_root_request(request_id: str = "open", session_id: str = "root-session", turn_id: str = "turn-1") -> dict[str, object]:
    return {
        "protocol_version": "1",
        "request_id": request_id,
        "kind": "open_root_reconciler",
        "reconciler_session_id": session_id,
        "reconciler_turn_id": turn_id,
        "observed_at": "2026-07-23T00:00:00Z",
        "root_issue_id": "root-1",
        "performer_profile_id": "profile-1",
        "model_settings": {"model": "gpt", "reasoning_effort": "medium", "is_fast_mode_enabled": False},
        "execution_policy": {"sandbox_mode": "read_only", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "command": requirement_command(),
        "bootstrap": root_bootstrap(),
        "limits": {
            "max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1,
            "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2027-07-23T00:00:00Z",
        },
    }


def root_delta(request_id: str, session_id: str, turn_id: str, base: str, target: str) -> dict[str, object]:
    return {
        "protocol_version": "1",
        "request_id": request_id,
        "kind": "advance_root_reconciler",
        "reconciler_session_id": session_id,
        "reconciler_turn_id": turn_id,
        "observed_at": "2026-07-23T00:00:00Z",
        "command": requirement_command(),
        "delta": {"base_root_digest": base, "target_root_digest": target, "changes": []},
        "limits": {
            "max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1,
            "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2027-07-23T00:00:00Z",
        },
    }


def convergence_snapshot() -> dict[str, object]:
    return {
        "policy": {
            "max_cycles_per_root": 3,
            "max_same_open_finding_cycles": 2,
            "max_cycle_repair_attempts": 0,
            "deadline_at": "2027-07-24T00:00:00Z",
        },
        "view": {
            "cycle_count": 0,
            "open_finding_persistence": [],
            "active_cycle_repair_attempts": 0,
            "is_deadline_exceeded": False,
            "root_is_canceled": False,
        },
    }


def issue_change(description: str = "Updated root description") -> dict[str, object]:
    return {
        "kind": "replacement",
        "source_kind": "issue",
        "source_id": "root-1",
        "source_version_or_digest": "root-v2",
        "replaces_source_version_or_digest": "root-v1",
        "actor_kind": "human",
        "observed_at": "2026-07-23T00:00:01Z",
        "value": {
            "kind": "issue",
            "issue": {
                "issue_id": "root-1", "identifier": "SYM-1", "issue_kind": "root",
                "title": "Root", "description": description, "status": "Todo", "order": 0,
                "is_archived": False, "labels": [], "remote_version": "root-v2",
                "created_at": "2026-07-23T00:00:00Z",
            },
        },
    }


def issue_snapshot(kind: str) -> dict[str, object]:
    return {
        "issue_id": f"{kind}-1", "identifier": f"SYM-{kind}-1", "issue_kind": kind,
        "title": kind.title(), "description": f"{kind} description", "status": "Todo",
        "order": 0, "is_archived": False, "labels": [], "remote_version": f"{kind}-v1",
        "created_at": "2026-07-23T00:00:00Z",
    }


def plan_contract() -> dict[str, object]:
    return {
        "objective": "Complete the cycle objective", "included_scope": ["the selected work"], "excluded_scope": [],
        "assumptions": [], "constraints": [],
        "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The work is complete", "verification_method": "automated test"}],
        "verification_requirements": ["automated test"],
    }


def plan_dag() -> dict[str, object]:
    return {
        "work_nodes": [{"proposal_key": "work-1", "title": "Work", "description": "Work description", "expected_outcome": "Work complete", "required_checks": ["test"], "dependency_proposal_keys": []}],
        "dependency_edges": [],
        "verify_node": {"title": "Verify", "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The work is complete", "verification_method": "automated test"}], "required_checks": ["test"]},
    }


def cycle_snapshot() -> dict[str, object]:
    return {
        "cycle_issue": issue_snapshot("cycle"),
        "cycle_status": "Todo",
        "is_archived": False,
        "issues": [issue_snapshot("plan")],
        "relations": [],
    }


def stage_context(role: str) -> dict[str, object]:
    if role == "plan":
        return {
            "root_contract": {"objective": "Complete the root objective", "requested_scope": "the requested scope", "constraints": [], "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The objective is complete", "verification_method": "automated test"}]},
            "cycle": {"cycle_issue_id": "cycle-1", "trigger": "initial"},
            "current_plan_issue": issue_snapshot("plan"), "prior_plan_attempt_facts": [], "prior_approved_plan_facts": [],
            "unresolved_finding_issue_facts": [], "human_action_thread_facts": [],
            "current_git_facts": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
            "required_output": "return a PlanResult",
        }
    if role == "work":
        return {
            "approved_plan_contract": plan_contract(), "current_active_work_dag": plan_dag(), "selected_work": issue_snapshot("work"),
            "completed_work_evidence": [], "prior_work_attempt_facts": [], "human_action_thread_facts": [],
            "git_baseline": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
            "workspace_capability": "workspace_write",
        }
    return {
        "approved_plan_contract": plan_contract(), "complete_active_cycle_dag": plan_dag(), "archived_cycle_nodes": [],
        "completed_work_issue_facts": [], "unresolved_finding_issue_facts": [], "human_action_thread_facts": [], "verification_requirements": ["automated test"],
        "immutable_target_revision": "head-1", "repository_snapshot": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
    }


def test_host_keeps_root_session_and_returns_gate_specific_intent():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)

    opened = host.handle(open_root_request())

    assert opened["kind"] == "root_reconciler_opened"
    assert opened["initial_result"]["kind"] == "requirement_and_comment_intent"
    assert opened["initial_result"]["intent"]["kind"] == "answer_comments"
    model_turn = opened["initial_result"]["model_turn"]
    assert model_turn["turn_record_id"] == "root-1:turn-1"
    assert model_turn["role"] == "root_reconciler"
    assert model_turn["model"] == "gpt"
    assert model_turn["outcome"] == "intent_accepted"
    assert model_turn["usage"] == {"status": "unavailable", "reason": "provider_omitted"}
    assert opened["bootstrap_root_digest"] == fragment_digest(root_manifest())
    assert backend.turns[0][0] == "provider-1"
    assert backend.turns[0][1]["kind"] == "open_root_reconciler"


def test_host_accepts_multiple_continuous_deltas_in_one_root_session():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    digest = fragment_digest(root_manifest())

    first = host.handle(root_delta("advance-1", "root-session", "turn-2", digest, digest))
    second = host.handle(root_delta("advance-2", "root-session", "turn-3", digest, digest))

    assert first["based_on_target_root_digest"] == digest
    assert second["based_on_target_root_digest"] == digest
    assert [turn[1]["kind"] for turn in backend.turns] == ["open_root_reconciler", "advance_root_reconciler", "advance_root_reconciler"]


def test_host_rejects_stale_and_discontinuous_deltas():
    stale_host = AgentProtocolHost(FakeBackend())
    stale_host.handle(open_root_request())
    initial_digest = fragment_digest(root_manifest())
    changed_digest = fragment_digest(root_manifest("root-v2"))
    first = root_delta("advance-1", "root-session", "turn-2", initial_digest, changed_digest)
    first["delta"]["changes"] = [issue_change()]
    stale_host.handle(first)

    stale = stale_host.handle(root_delta("stale", "root-session", "turn-3", initial_digest, changed_digest))

    discontinuous_host = AgentProtocolHost(FakeBackend())
    discontinuous_host.handle(open_root_request())
    discontinuous = discontinuous_host.handle(root_delta("gap", "root-session", "turn-2", "unknown", initial_digest))

    assert stale["code"] == "root_delta_stale"
    assert discontinuous["code"] == "root_delta_discontinuous"
    assert stale_host.handle(root_delta("after-stale", "root-session", "turn-4", initial_digest, initial_digest))["code"] == "root_reconciler_bootstrap_required"


def test_host_rejects_full_snapshot_and_implicit_root_turn_on_advance():
    host = AgentProtocolHost(FakeBackend())
    host.handle(open_root_request())
    digest = fragment_digest(root_manifest())
    full_snapshot = root_delta("full", "root-session", "turn-2", digest, digest)
    full_snapshot["bootstrap"] = root_bootstrap()
    legacy = {
        "protocol_version": "1", "request_id": "legacy", "reconciler_session_id": "root-session",
        "reconciler_turn_id": "turn-2", "observed_at": "2026-07-23T00:00:00Z", "root": {},
    }

    assert host.handle(full_snapshot)["code"] == "request_shape_invalid"
    assert host.handle(legacy)["code"] == "request_shape_invalid"


def test_delta_advances_runtime_canonical_facts_and_lost_session_requires_bootstrap():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    initial_digest = fragment_digest(root_manifest())
    changed_digest = fragment_digest(root_manifest("root-v2"))
    changed = root_delta("advance-1", "root-session", "turn-2", initial_digest, changed_digest)
    changed["delta"]["changes"] = [issue_change()]
    changed["command"] = requirement_command(["root-v2"])
    changed["command"]["pending_input_refs"][0]["source_kind"] = "issue_activity"

    host.handle(changed)
    baseline = host._root._baselines["root-session"]
    assert baseline.root_digest == changed_digest
    assert baseline.canonical_facts["pending_input_ids"] == ["root-v2"]
    assert baseline.canonical_facts["root_snapshot"]["root"]["issue"]["description"] == "Updated root description"

    host._sessions.close("root-session")
    lost = host.handle(root_delta("advance-2", "root-session", "turn-3", changed_digest, changed_digest))
    assert lost["code"] == "root_reconciler_bootstrap_required"


def test_delta_replaces_the_structured_convergence_snapshot_in_the_root_baseline():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    initial_manifest = root_manifest()
    target_manifest = [*initial_manifest, {
        "source_kind": "mechanical_violation", "source_id": "mechanical:root-1",
        "source_version_or_digest": "mechanical-v2", "actor_kind": "symphony",
    }]
    changed = root_delta(
        "advance-1", "root-session", "turn-2",
        fragment_digest(initial_manifest), fragment_digest(target_manifest),
    )
    convergence = convergence_snapshot()
    convergence["view"] = {
        **convergence["view"],
        "active_cycle_issue_id": "cycle-1",
        "active_cycle_repair_attempts": 1,
    }
    changed["delta"]["changes"] = [{
        "kind": "current_value",
        "source_kind": "mechanical_violation",
        "source_id": "mechanical:root-1",
        "source_version_or_digest": "mechanical-v2",
        "actor_kind": "symphony",
        "observed_at": "2026-07-23T00:00:01Z",
        "value": {"kind": "mechanical_violation", "mechanical_violations": [], "convergence": convergence},
    }]

    assert host.handle(changed)["based_on_target_root_digest"] == fragment_digest(target_manifest)
    baseline = host._root._baselines["root-session"].canonical_facts
    assert baseline["root_snapshot"]["root"]["convergence"]["view"]["active_cycle_repair_attempts"] == 1


def test_delta_updates_and_removes_the_native_plan_issue_in_the_root_baseline():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    open_request = open_root_request()
    bootstrap = root_bootstrap()
    bootstrap["root_snapshot"]["cycles"] = [cycle_snapshot()]
    plan = {**issue_snapshot("plan"), "parent_issue_id": "cycle-1"}
    bootstrap["root_snapshot"]["cycles"][0]["issues"] = [plan]
    bootstrap["root_snapshot"]["issues"] = [issue_snapshot("cycle"), plan]
    bootstrap_manifest = [
        {"source_kind": "issue", "source_id": "cycle-1", "source_version_or_digest": "cycle-v1", "actor_kind": "symphony"},
        {"source_kind": "issue", "source_id": "plan-1", "source_version_or_digest": "plan-v1", "actor_kind": "symphony"},
        *root_manifest(),
    ]
    bootstrap["source_manifest"] = bootstrap_manifest
    bootstrap["root_digest"] = fragment_digest(bootstrap_manifest)
    open_request["bootstrap"] = bootstrap
    host.handle(open_request)

    updated_manifest = [
        bootstrap_manifest[0],
        {"source_kind": "issue", "source_id": "plan-1", "source_version_or_digest": "plan-v2", "actor_kind": "symphony"},
        bootstrap_manifest[2],
    ]
    added = root_delta(
        "advance-1", "root-session", "turn-2",
        fragment_digest(bootstrap_manifest), fragment_digest(updated_manifest),
    )
    updated_plan = {
        **plan,
        "description": "# Objective\nComplete the cycle using native Linear facts.",
        "status": "In Review",
        "labels": ["Plan"],
        "remote_version": "plan-v2",
    }
    added["delta"]["changes"] = [{
        "kind": "replacement",
        "source_kind": "issue",
        "source_id": "plan-1",
        "source_version_or_digest": "plan-v2",
        "replaces_source_version_or_digest": "plan-v1",
        "actor_kind": "symphony",
        "observed_at": "2026-07-23T00:00:01Z",
        "value": {"kind": "issue", "issue": updated_plan},
    }]
    assert host.handle(added)["based_on_target_root_digest"] == fragment_digest(updated_manifest)
    baseline = host._root._baselines["root-session"].canonical_facts
    cycle = baseline["root_snapshot"]["cycles"][0]
    assert cycle["issues"][0] == updated_plan
    assert next(issue for issue in baseline["root_snapshot"]["issues"] if issue["issue_id"] == "plan-1") == updated_plan

    final_manifest = [updated_manifest[0], updated_manifest[2]]
    removed = root_delta(
        "advance-2", "root-session", "turn-3",
        fragment_digest(updated_manifest), fragment_digest(final_manifest),
    )
    removed["delta"]["changes"] = [{
        "kind": "tombstone",
        "source_kind": "issue",
        "source_id": "plan-1",
        "source_version_or_digest": "plan-tombstone-v1",
        "removes_source_version_or_digest": "plan-v2",
        "actor_kind": "symphony",
        "observed_at": "2026-07-23T00:00:02Z",
        "reason": "left_role_scope",
    }]
    assert host.handle(removed)["based_on_target_root_digest"] == fragment_digest(final_manifest)
    cycle = host._root._baselines["root-session"].canonical_facts["root_snapshot"]["cycles"][0]
    assert cycle["issues"] == []
    assert [issue["issue_id"] for issue in host._root._baselines["root-session"].canonical_facts["root_snapshot"]["issues"]] == ["cycle-1"]


def test_host_persists_root_provider_failure_as_a_typed_model_turn_result():
    backend = RootFailureBackend()
    host = AgentProtocolHost(backend)
    result = host.handle(open_root_request())

    assert result["kind"] == "root_reconciler_opened"
    failure = result["initial_result"]
    assert failure["kind"] == "root_reconciler_failed"
    assert failure["root_issue_id"] == "root-1"
    assert failure["failure"]["code"] == "provider_append_acceptance_unknown"
    assert failure["failure"]["category"] == "transport_failed"
    assert failure["failure"]["attempted_input_ids"] == []
    assert failure["failure"]["continuity"] == {
        "kind": "closed", "append_outcome": "acceptance_unknown",
    }
    assert "root-session" not in host._sessions._sessions
    assert "root-session" not in host._root._baselines
    assert failure["failure"]["model_turn"] == {
        "turn_record_id": "root-1:turn-1",
        "role": "root_reconciler",
        "root_issue_id": "root-1",
        "reconciler_session_id": "root-session",
        "reconciler_turn_id": "turn-1",
        "invocation_state": "ambiguous",
        "model": "gpt",
        "outcome": "transport_failed",
        "usage": {"status": "unavailable", "reason": "transport_lost"},
        "terminal_at": failure["failure"]["failed_at"],
    }


def test_host_preserves_a_provider_schema_rejection_as_a_typed_schema_failure():
    result = AgentProtocolHost(RootSchemaFailureBackend()).handle(open_root_request())
    failure = result["initial_result"]["failure"]

    assert failure["code"] == "provider_schema_unsupported"
    assert failure["category"] == "schema_invalid"
    assert failure["continuity"]["append_outcome"] == "not_accepted"


def test_host_reports_root_semantic_intent_contract_failure():
    host = AgentProtocolHost(InvalidRootDirectiveBackend())
    result = host.handle(open_root_request())

    assert result["kind"] == "root_reconciler_opened"
    failure = result["initial_result"]
    assert failure["kind"] == "root_reconciler_failed"
    assert failure["failure"]["code"] == "root_semantic_intent_contract_invalid"
    assert failure["failure"]["category"] == "schema_invalid"
    assert failure["failure"]["model_turn"]["outcome"] == "schema_invalid"
    assert failure["failure"]["continuity"] == {
        "kind": "retained",
        "append_outcome": "accepted",
        "provider_visible_context_digest": fragment_digest(root_manifest()),
    }
    assert host._root._baselines["root-session"].root_digest == fragment_digest(root_manifest())


def test_retained_failed_root_open_can_be_closed_before_a_fresh_open():
    host = AgentProtocolHost(InvalidRootDirectiveBackend())

    failed = host.handle(open_root_request())
    assert failed["initial_result"]["failure"]["continuity"]["kind"] == "retained"

    closed = host.handle({
        "protocol_version": "1",
        "request_id": "close",
        "kind": "close_root_reconciler",
        "root_issue_id": "root-1",
        "reason": "turn_failed",
    })
    assert closed == {
        "protocol_version": "1",
        "request_id": "close",
        "kind": "root_reconciler_closed",
        "root_issue_id": "root-1",
    }

    reopened = host.handle(open_root_request("reopen", "root-session-2", "turn-2"))
    assert reopened["kind"] == "root_reconciler_opened"
    assert reopened["reconciler_session_id"] == "root-session-2"


def test_root_not_accepted_failure_retains_the_confirmed_base():
    backend = RootAppendFailureBackend("not_accepted")
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    initial_digest = fragment_digest(root_manifest())
    target_digest = fragment_digest(root_manifest("root-v2"))
    request = root_delta("advance", "root-session", "turn-2", initial_digest, target_digest)
    request["delta"]["changes"] = [issue_change()]

    failure = host.handle(request)

    assert failure["failure"]["continuity"] == {
        "kind": "retained", "append_outcome": "not_accepted",
        "provider_visible_context_digest": initial_digest,
    }
    assert host._root._baselines["root-session"].root_digest == initial_digest
    assert host._sessions._sessions["root-session"].provider_visible_context_digest == initial_digest


def test_root_accepted_failure_advances_the_confirmed_target():
    backend = RootAppendFailureBackend("accepted")
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    initial_digest = fragment_digest(root_manifest())
    target_digest = fragment_digest(root_manifest("root-v2"))
    request = root_delta("advance", "root-session", "turn-2", initial_digest, target_digest)
    request["delta"]["changes"] = [issue_change()]

    failure = host.handle(request)

    assert failure["failure"]["continuity"] == {
        "kind": "retained", "append_outcome": "accepted",
        "provider_visible_context_digest": target_digest,
    }
    assert host._root._baselines["root-session"].root_digest == target_digest
    assert host._root._baselines["root-session"].canonical_facts["root_snapshot"]["root"]["issue"]["remote_version"] == "root-v2"
    assert host._sessions._sessions["root-session"].provider_visible_context_digest == target_digest
    assert failure["failure"]["model_turn"]["invocation_state"] == "confirmed"
    assert failure["failure"]["model_turn"]["usage"] == {"status": "unavailable", "reason": "provider_omitted"}


def test_root_ambiguous_append_failure_closes_the_session_and_baseline():
    backend = RootAppendFailureBackend("acceptance_unknown")
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())
    initial_digest = fragment_digest(root_manifest())
    target_digest = fragment_digest(root_manifest("root-v2"))
    request = root_delta("advance", "root-session", "turn-2", initial_digest, target_digest)
    request["delta"]["changes"] = [issue_change()]

    failure = host.handle(request)

    assert failure["failure"]["continuity"] == {
        "kind": "closed", "append_outcome": "acceptance_unknown",
    }
    assert "root-session" not in host._sessions._sessions
    assert "root-session" not in host._root._baselines


def test_host_rejects_legacy_create_root_workspace_model_action():
    request = open_root_request()
    request["bootstrap"]["root_snapshot"]["worktree_gate"] = {
        "kind": "fresh_missing",
        "repository_identity": "repository-1",
        "base_branch": "main",
        "base_revision": "base-1",
    }

    result = AgentProtocolHost(CreateRootWorkspaceBackend()).handle(request)

    assert result["kind"] == "root_reconciler_opened"
    assert result["initial_result"]["kind"] == "root_reconciler_failed"
    assert result["initial_result"]["failure"]["category"] == "schema_invalid"


def test_host_rejects_unexpected_comment_dispositions_when_no_comment_input_is_pending():
    host = AgentProtocolHost(UnexpectedCommentReplyBackend())
    result = host.handle(open_root_request())

    assert result["kind"] == "root_reconciler_opened"
    failure = result["initial_result"]
    assert failure["kind"] == "root_reconciler_failed"
    assert failure["failure"]["code"] == "root_semantic_intent_comment_dispositions_invalid"
    assert failure["failure"]["category"] == "schema_invalid"


def test_host_does_not_require_a_reply_for_an_automation_comment_thread_state():
    request = open_root_request()
    bootstrap = request["bootstrap"]
    assert isinstance(bootstrap, dict)
    snapshot = bootstrap["root_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["user_comment_thread_states"] = [{
        "comment_id": "automation-comment-1",
        "comment_remote_version": "comment-v1",
        "thread_root_comment_id": "automation-comment-1",
        "thread_state": "unresolved",
        "actor_kind": "unknown",
        "observed_at": "2026-07-23T00:00:00Z",
    }]
    source_input_id = "input:" + sha256(
        b"comment_thread_state:automation-comment-1:automation-comment-1:unresolved\0comment-v1",
    ).hexdigest()
    request["command"] = requirement_command([source_input_id])
    request["command"]["pending_input_refs"][0]["source_kind"] = "comment_thread_state"
    request["command"]["pending_input_refs"][0]["source_version_or_digest"] = "comment-v1"

    result = AgentProtocolHost(FakeBackend()).handle(request)

    assert result["kind"] == "root_reconciler_opened"
    assert result["initial_result"]["intent"]["kind"] == "answer_comments"
    assert result["initial_result"]["comment_dispositions"] == []


def test_host_requires_a_reply_for_a_pending_user_comment_thread_state():
    request = open_root_request()
    bootstrap = request["bootstrap"]
    assert isinstance(bootstrap, dict)
    snapshot = bootstrap["root_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["user_comments"] = [{
        "comment_id": "comment-1",
        "comment_remote_version": "comment-v1",
        "issue_id": "root-1",
        "author_kind": "human",
        "author_id": "user-1",
        "body": "Start planning.",
        "thread_root_comment_id": "comment-1",
        "thread_state": "resolved",
        "reactions": [],
        "created_at": "2026-07-23T00:00:00Z",
        "updated_at": "2026-07-23T00:00:01Z",
    }]
    snapshot["user_comment_thread_states"] = [{
        "comment_id": "comment-1",
        "comment_remote_version": "comment-v1",
        "thread_root_comment_id": "comment-1",
        "thread_state": "resolved",
        "actor_kind": "unknown",
        "observed_at": "2026-07-23T00:00:01Z",
    }]
    source_input_id = "input:" + sha256(
        b"comment_thread_state:comment-1:comment-1:resolved\0comment-v1",
    ).hexdigest()
    request["command"] = requirement_command([source_input_id])
    request["command"]["pending_input_refs"][0]["source_kind"] = "comment_thread_state"
    request["command"]["pending_input_refs"][0]["source_version_or_digest"] = "comment-v1"

    result = AgentProtocolHost(MatchingCommentReplyBackend()).handle(request)

    assert result["kind"] == "root_reconciler_opened"
    disposition = result["initial_result"]["comment_dispositions"][0]
    assert disposition["source_input_id"] == source_input_id
    assert disposition["source"]["kind"] == "comment_thread_state"


def test_host_accepts_a_reply_that_matches_the_pending_user_comment_input():
    request = open_root_request()
    bootstrap = request["bootstrap"]
    assert isinstance(bootstrap, dict)
    snapshot = bootstrap["root_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["user_comments"] = [{
        "comment_id": "comment-1",
        "comment_remote_version": "comment-v1",
        "issue_id": "root-1",
        "author_kind": "human",
        "author_id": "user-1",
        "body": "Start planning.",
        "thread_root_comment_id": "comment-1",
        "thread_state": "unresolved",
        "reactions": [],
        "created_at": "2026-07-23T00:00:00Z",
        "updated_at": "2026-07-23T00:00:00Z",
    }]
    body_digest = sha256(b"Start planning.").hexdigest()
    source_input_id = "input:" + sha256(f"comment_body:comment-1\0{body_digest}".encode("utf-8")).hexdigest()
    request["command"] = requirement_command([source_input_id])
    request["command"]["pending_input_refs"][0]["source_version_or_digest"] = body_digest
    source = pending_comment_reply_sources_from_request(request)[0]

    result = AgentProtocolHost(MatchingCommentReplyBackend()).handle(request)

    assert result["kind"] == "root_reconciler_opened"
    intent = result["initial_result"]
    assert intent["intent"]["kind"] == "answer_comments"
    assert intent["comment_dispositions"][0]["source_input_id"] == source["source_input_id"]


def test_root_delta_extracts_pending_comment_reply_source_from_the_closed_context_value():
    body_digest = sha256(b"Continue planning.").hexdigest()
    input_id = "input:" + sha256(f"comment_body:comment-2\0{body_digest}".encode()).hexdigest()
    request = root_delta("advance", "root-session", "turn-2", "base", "target")
    request["command"] = requirement_command([input_id])
    request["command"]["pending_input_refs"][0]["source_version_or_digest"] = body_digest
    request["delta"]["changes"] = [{
        "kind": "current_value",
        "source_kind": "comment",
        "source_id": "comment-2",
        "source_version_or_digest": body_digest,
        "actor_kind": "human",
        "observed_at": "2026-07-23T00:00:01Z",
        "value": {
            "kind": "comment",
            "user_input": {
                "kind": "comment_body", "input_id": input_id,
                "comment_id": "comment-2", "comment_body_digest": body_digest,
                "issue_id": "root-1", "issue_kind": "root",
                "author_kind": "human", "author_id": "user-1",
                "body": "Continue planning.", "thread_root_comment_id": "comment-2",
                "thread_state": "unresolved", "created_at": "2026-07-23T00:00:00Z",
                "updated_at": "2026-07-23T00:00:01Z",
            },
        },
    }]

    assert pending_comment_reply_sources_from_request(request) == [{
        "source_input_id": input_id,
        "source": {"kind": "comment_body", "comment_id": "comment-2", "comment_body_digest": body_digest},
    }]


def test_host_accepts_a_canonical_activity_fragment_in_root_bootstrap_manifest():
    request = open_root_request()
    bootstrap = request["bootstrap"]
    assert isinstance(bootstrap, dict)
    snapshot = bootstrap["root_snapshot"]
    assert isinstance(snapshot, dict)
    snapshot["activities"] = [{
        "activity_id": "activity-1", "issue_id": "root-1",
        "activity_kinds": ["description_changed"], "actor_kind": "human",
        "remote_version": "activity-v1", "created_at": "2026-07-23T00:00:00Z",
    }]
    manifest = [{
        "source_kind": "activity", "source_id": "activity-1",
        "source_version_or_digest": "activity-v1", "actor_kind": "human",
    }, *root_manifest()]
    bootstrap["source_manifest"] = manifest
    bootstrap["root_digest"] = fragment_digest(manifest)

    result = AgentProtocolHost(FakeBackend()).handle(request)

    assert result["kind"] == "root_reconciler_opened"
    assert result["initial_result"]["intent"]["kind"] == "answer_comments"


def test_host_routes_plan_work_and_verify_to_distinct_sessions(tmp_path: Path):
    backend = FakeBackend()
    host = AgentProtocolHost(backend, workspace_root=tmp_path)
    for role in ("plan", "work", "verify"):
        opened = host._sessions.open(
            session_id=f"{role}-session",
            session_generation=f"{role}-generation",
            role=role,
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={"model": "gpt"},
        )
        assert opened.provider_session.role == role

    common = {
        "root_issue_id": "root-1",
        "cycle_issue_id": "cycle-1",
        "observed_tree_digest": "tree-1",
        "context_digest": EMPTY_CONTEXT_DIGEST,
        "execution_policy": {"sandbox_mode": "read_only", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "model_settings": {"model": "gpt", "reasoning_effort": "medium", "is_fast_mode_enabled": False},
        "target_issue_id": "target-1",
        "source_manifest": [],
        "coverage": {"is_complete": True, "omissions": []},
        "instruction_bundle": {"instruction_set_id": "stage-v1", "instructions": "run", "output_schema": "result"},
        "repository_context": {
            "repository_identity": "repo-1", "base_branch": "main", "workspace_revision": "head-1",
            "baseline_revision": "head-1", "status_summary": "clean", "relevant_paths": [],
            "workspace_access": "read_only", "instructions": [],
        },
        "limits": {
            "max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1,
            "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2027-07-23T00:00:00Z",
        },
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }
    for role in ("plan", "verify"):
        result = host.handle({
            "protocol_version": "1", "request_id": role,
            **common,
            "role": role,
            "role_session_id": f"{role}-session",
            "session_generation": f"{role}-generation",
            "role_turn_id": f"{role}-turn",
            "stage_execution_id": f"{role}-execution",
        })
        assert "kind" not in result
        assert result["role"] == role
        assert result["terminal"]["kind"] == "runtime_failure"
        assert result["terminal"]["failure_kind"] == "output_invalid"
        assert result["terminal"]["error_code"] == "provider_output_schema_invalid"
        assert result["terminal"]["continuity"]["append_outcome"] == "accepted"
        assert result["model_observation"]["outcome"] == "runtime_failure"

    work_payload = {
        **common,
        "role": "work",
        "role_session_id": "work-session",
        "session_generation": "work-generation",
        "role_turn_id": "work-turn",
        "stage_execution_id": "work-execution",
        "execution_policy": {"sandbox_mode": "workspace_write", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "repository_context": {**common["repository_context"], "workspace_access": "read_write"},
    }
    work_payload = {"protocol_version": "1", "request_id": "work", **work_payload}
    result = host.handle(work_payload)
    assert result["terminal"]["kind"] == "runtime_failure"
    assert result["terminal"]["failure_kind"] == "output_invalid"
    assert backend.turns[-1][2] == tmp_path
    assert len({handle for handle, _, _ in backend.turns}) == 3


def test_host_rejects_unknown_or_malformed_protocol_requests():
    host = AgentProtocolHost(FakeBackend())

    unknown = host.handle({"protocol_version": "1", "request_id": "x", "kind": "old_stage"})
    malformed = host.handle({"protocol_version": "1", "request_id": "x", "kind": "open_root_reconciler"})

    assert unknown["code"] == "request_kind_unsupported"
    assert malformed["code"] == "request_shape_invalid"

    legacy_envelope = host.handle({
        "protocol_version": "1", "request_id": "legacy", "kind": "open_root_reconciler",
        "payload": {"root_issue_id": "root-1"},
    })
    assert legacy_envelope["code"] == "request_shape_invalid"


def test_close_cycle_does_not_close_root_session():
    backend = FakeBackend()
    host = AgentProtocolHost(backend, process_generation="process-1")
    host.handle(open_root_request(request_id="root"))
    host._sessions.open(
        session_id="plan-session", session_generation="plan-generation",
        role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={}
    )
    command = {
        "protocol_version": "1",
        "command_id": "close",
        "kind": "close_cycle_stage_sessions",
        "root_issue_id": "root-1",
        "cycle_issue_id": "cycle-1",
        "expected_process_generation": "process-1",
        "reason": "cycle_terminal",
        "deadline_at": "2027-07-23T00:00:00Z",
        "expected_sessions": {
            "plan": {
                "kind": "expected",
                "role_session_id": "plan-session",
                "session_generation": "plan-generation",
            },
            "work": {"kind": "absent"},
            "verify": {"kind": "absent"},
        },
    }
    result = host.handle(command)

    assert validate("CloseCycleStageSessionsResult", result) == result
    assert result["kind"] == "all_closed"
    assert result["role_results"]["plan"]["close_outcome"] == "closed_now"
    assert result["role_results"]["work"]["close_outcome"] == "already_absent"
    assert result["role_results"]["verify"]["close_outcome"] == "already_absent"
    assert any(record.role == "root_reconciler" for record in host._sessions._sessions.values())
    assert backend.closed == ["provider-2"]

    assert host.handle(command) == result
    conflict = host.handle({**command, "reason": "shutdown"})
    assert conflict["kind"] == "error"
    assert conflict["request_id"] == "close"
    assert conflict["code"] == "command_id_reused"
