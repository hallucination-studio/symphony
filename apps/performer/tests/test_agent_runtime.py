from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from performer.agent_protocol.host import AgentProtocolHost
from performer.backends.provider_backend_interface import ProviderBackendError
from performer.backends.provider_backend_interface import ProviderSession


class FakeBackend:
    def __init__(self) -> None:
        self.opened: list[str] = []
        self.turns: list[tuple[str, dict[str, object], Path | None]] = []
        self.closed: list[str] = []

    def open_role_session(self, role: str, settings: dict[str, object]) -> ProviderSession:
        handle = f"provider-{len(self.opened) + 1}"
        self.opened.append(f"{role}:{handle}")
        return ProviderSession(role, handle)

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        self.turns.append((session.provider_handle, request, workspace_root))
        if session.role == "root_reconciler":
            return {"output": {
                "rationale": "Waiting for the next durable fact.",
                "evidence_refs": [{"reference_id": "fact-1", "source_kind": "result"}],
                "consumed_input_ids": [],
                "comment_replies": [],
                "human_action_resolutions": [],
                "action": {"kind": "wait", "reason_code": "human", "blocking_fact_refs": [{"reference_id": "fact-1", "source_kind": "result"}]},
            }}
        return {"output": {"kind": "canceled", "sanitized_reason": "test cancellation"}, "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


class RootFailureBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            raise ProviderBackendError("provider turn failed", code="provider_turn_failed", retryable=True)
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


class InvalidRootDirectiveBackend(FakeBackend):
    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        if session.role == "root_reconciler":
            return {"output": {
                "rationale": "Missing evidence.",
                "evidence_refs": [],
                "consumed_input_ids": [],
                "comment_replies": [],
                "human_action_resolutions": [],
                "action": {"kind": "wait", "reason_code": "human"},
            }}
        return super().execute_role_turn(
            session,
            request,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )


def envelope(request_id: str, kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"protocol_version": "1", "request_id": request_id, "kind": kind, **payload}


def root_bootstrap(root_digest: str = "tree-1") -> dict[str, object]:
    return {
        "root_snapshot": {
            "root": {
                "issue": {
                    "issue_id": "root-1", "issue_kind": "root", "title": "Root", "description": "Root description",
                    "status": "Todo", "is_archived": False, "labels": [], "remote_version": "root-v1",
                },
                "objective": "Complete the root objective",
                "scope": "The requested root scope",
                "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The objective is complete", "verification_method": "automated test"}],
                "constraints": [],
                "root_status": "Todo",
                "ownership": {"record_id": "owner-1", "record_kind": "root_ownership", "version": "1"},
                "convergence_summary": "No convergence limit has been reached.",
            },
            "cycles": [],
            "issues": [],
            "relations": [],
            "managed_records": [],
            "user_comments": [],
            "git_facts": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
            "delivery": {"record_id": "delivery-1", "record_kind": "delivery", "version": "1"},
            "mechanical_violations": [],
        },
        "source_manifest": [],
        "coverage": {"is_complete": True, "omissions": []},
        "root_digest": root_digest,
        "pending_input_ids": [],
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
        "delta": {"base_root_digest": base, "target_root_digest": target, "changes": [], "pending_input_ids": []},
        "limits": {
            "max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1,
            "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2027-07-23T00:00:00Z",
        },
    }


def issue_change(description: str = "Updated root description") -> dict[str, object]:
    return {
        "kind": "issue_current_value",
        "source_id": "root-1",
        "source_version": "root-v2",
        "actor_kind": "human",
        "observed_at": "2026-07-23T00:00:01Z",
        "issue": {
            "issue_id": "root-1", "issue_kind": "root", "title": "Root", "description": description,
            "status": "Todo", "is_archived": False, "labels": [], "remote_version": "root-v2",
        },
    }


def issue_snapshot(kind: str) -> dict[str, object]:
    return {
        "issue_id": f"{kind}-1", "issue_kind": kind, "title": kind.title(), "description": f"{kind} description",
        "status": "Todo", "is_archived": False, "labels": [], "remote_version": f"{kind}-v1",
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


def canonical_plan_contract() -> dict[str, object]:
    return {
        "kind": "plan_contract",
        "version": 1,
        "root_issue_id": "root-1",
        "cycle_issue_id": "cycle-1",
        "plan_contract_digest": "plan-contract-1",
        **plan_contract(),
        "proposed_work_dag": plan_dag(),
    }


def completed_plan_result() -> dict[str, object]:
    return {
        "result_id": "plan-result-1",
        "root_issue_id": "root-1",
        "cycle_issue_id": "cycle-1",
        "node_issue_id": "plan-1",
        "summary": "The complete Plan is ready for review.",
        "completed_at": "2026-07-23T00:00:01Z",
        "plan_contract_digest": "plan-contract-1",
        "plan_contract": plan_contract(),
        "proposed_work_dag": plan_dag(),
        "risks": [],
        "required_permissions": [],
        "evidence_refs": [],
    }


def cycle_snapshot() -> dict[str, object]:
    return {
        "cycle_issue": issue_snapshot("cycle"),
        "predecessor_cycle_issue_id": "none",
        "cycle_status": "Todo",
        "is_archived": False,
        "issues": [issue_snapshot("plan")],
        "relations": [],
        "plan_results": [],
        "plan_completed_results": [],
        "work_results": [],
        "verify_results": [],
        "findings": [],
        "human_action_records": [],
        "human_action_resolutions": [],
    }


def stage_context(role: str) -> dict[str, object]:
    if role == "plan":
        return {
            "root_contract": {"objective": "Complete the root objective", "requested_scope": "the requested scope", "constraints": [], "acceptance_criteria": [{"criterion_key": "criterion-1", "statement": "The objective is complete", "verification_method": "automated test"}]},
            "cycle": {"cycle_issue_id": "cycle-1", "trigger": "initial"},
            "current_plan_issue": issue_snapshot("plan"), "prior_plan_results": [], "prior_plan_contracts": [],
            "unresolved_findings": [], "human_resolutions": [],
            "current_git_facts": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
            "required_output": "return a PlanResult",
        }
    if role == "work":
        return {
            "approved_plan_contract": plan_contract(), "current_active_work_dag": plan_dag(), "selected_work": issue_snapshot("work"),
            "completed_work_evidence": [], "prior_turn_results": [], "human_resolutions": [],
            "git_baseline": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
            "workspace_capability": "workspace_write",
        }
    return {
        "approved_plan_contract": plan_contract(), "complete_active_cycle_dag": plan_dag(), "archived_cycle_nodes": [],
        "completed_work_results": [], "unresolved_findings": [], "human_resolutions": [], "verification_requirements": ["automated test"],
        "immutable_target_revision": "head-1", "repository_snapshot": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
    }


def test_host_keeps_root_session_and_returns_root_directive():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)

    opened = host.handle(open_root_request())

    assert opened["kind"] == "root_reconciler_opened"
    assert opened["initial_directive"]["action"]["kind"] == "wait"
    assert opened["bootstrap_root_digest"] == "tree-1"
    assert backend.turns[0][0] == "provider-1"
    assert backend.turns[0][1]["kind"] == "open_root_reconciler"


def test_host_accepts_multiple_continuous_deltas_in_one_root_session():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    host.handle(open_root_request())

    first = host.handle(root_delta("advance-1", "root-session", "turn-2", "tree-1", "tree-2"))
    second = host.handle(root_delta("advance-2", "root-session", "turn-3", "tree-2", "tree-3"))

    assert first["based_on_target_root_digest"] == "tree-2"
    assert second["based_on_target_root_digest"] == "tree-3"
    assert [turn[1]["kind"] for turn in backend.turns] == ["open_root_reconciler", "advance_root_reconciler", "advance_root_reconciler"]


def test_host_rejects_stale_and_discontinuous_deltas():
    stale_host = AgentProtocolHost(FakeBackend())
    stale_host.handle(open_root_request())
    stale_host.handle(root_delta("advance-1", "root-session", "turn-2", "tree-1", "tree-2"))

    stale = stale_host.handle(root_delta("stale", "root-session", "turn-3", "tree-1", "tree-3"))

    discontinuous_host = AgentProtocolHost(FakeBackend())
    discontinuous_host.handle(open_root_request())
    discontinuous = discontinuous_host.handle(root_delta("gap", "root-session", "turn-2", "unknown", "tree-4"))

    assert stale["code"] == "root_delta_stale"
    assert discontinuous["code"] == "root_delta_discontinuous"
    assert stale_host.handle(root_delta("after-stale", "root-session", "turn-4", "tree-1", "tree-4"))["code"] == "root_reconciler_bootstrap_required"


def test_host_rejects_full_snapshot_and_implicit_root_turn_on_advance():
    host = AgentProtocolHost(FakeBackend())
    host.handle(open_root_request())
    full_snapshot = root_delta("full", "root-session", "turn-2", "tree-1", "tree-2")
    full_snapshot["bootstrap"] = root_bootstrap("tree-2")
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
    changed = root_delta("advance-1", "root-session", "turn-2", "tree-1", "tree-2")
    changed["delta"]["changes"] = [issue_change()]
    changed["delta"]["pending_input_ids"] = ["root-v2"]

    host.handle(changed)
    baseline = host._root._baselines["root-session"]
    assert baseline.root_digest == "tree-2"
    assert baseline.canonical_facts["pending_input_ids"] == ["root-v2"]
    assert baseline.canonical_facts["root_snapshot"]["root"]["issue"]["description"] == "Updated root description"

    host._sessions.close("root-session")
    lost = host.handle(root_delta("advance-2", "root-session", "turn-3", "tree-2", "tree-3"))
    assert lost["code"] == "root_reconciler_bootstrap_required"


def test_delta_retains_and_removes_canonical_plan_facts_in_the_root_baseline():
    backend = FakeBackend()
    host = AgentProtocolHost(backend)
    open_request = open_root_request()
    bootstrap = root_bootstrap()
    bootstrap["root_snapshot"]["cycles"] = [cycle_snapshot()]
    open_request["bootstrap"] = bootstrap
    host.handle(open_request)

    contract = canonical_plan_contract()
    completed = completed_plan_result()
    added = root_delta("advance-1", "root-session", "turn-2", "tree-1", "tree-2")
    added["delta"]["changes"] = [
        {
            "kind": "plan_contract_current_value",
            "source_id": "plan-contract-comment-1",
            "source_version": "comment-v1",
            "actor_kind": "symphony",
            "observed_at": "2026-07-23T00:00:01Z",
            "plan_issue_id": "plan-1",
            "plan_contract": contract,
        },
        {
            "kind": "plan_completed_result_current_value",
            "source_id": "plan-result-comment-1",
            "source_version": "comment-v1",
            "actor_kind": "symphony",
            "observed_at": "2026-07-23T00:00:01Z",
            "plan_completed_result": completed,
        },
    ]
    assert host.handle(added)["based_on_target_root_digest"] == "tree-2"
    baseline = host._root._baselines["root-session"].canonical_facts
    cycle = baseline["root_snapshot"]["cycles"][0]
    assert cycle["active_plan_contract"]["objective"] == "Complete the cycle objective"
    assert cycle["plan_completed_results"][0]["result_id"] == "plan-result-1"

    removed = root_delta("advance-2", "root-session", "turn-3", "tree-2", "tree-3")
    removed["delta"]["changes"] = [
        {
            "kind": "plan_contract_removed",
            "source_id": "plan-contract-comment-1",
            "source_version": "comment-v1",
            "actor_kind": "symphony",
            "observed_at": "2026-07-23T00:00:02Z",
            "cycle_issue_id": "cycle-1",
            "plan_issue_id": "plan-1",
            "plan_contract_digest": "plan-contract-1",
        },
        {
            "kind": "plan_completed_result_removed",
            "source_id": "plan-result-comment-1",
            "source_version": "comment-v1",
            "actor_kind": "symphony",
            "observed_at": "2026-07-23T00:00:02Z",
            "cycle_issue_id": "cycle-1",
            "result_id": "plan-result-1",
        },
    ]
    assert host.handle(removed)["based_on_target_root_digest"] == "tree-3"
    cycle = host._root._baselines["root-session"].canonical_facts["root_snapshot"]["cycles"][0]
    assert "active_plan_contract" not in cycle
    assert cycle["plan_completed_results"] == []


def test_host_preserves_root_provider_failure_code():
    backend = RootFailureBackend()
    host = AgentProtocolHost(backend)
    result = host.handle(open_root_request())

    assert result["code"] == "provider_turn_failed"


def test_host_reports_root_directive_contract_failure():
    host = AgentProtocolHost(InvalidRootDirectiveBackend())
    result = host.handle(open_root_request())

    assert result["code"] == "root_directive_wait_missing_blocking_fact_refs"


def test_host_routes_plan_work_and_verify_to_distinct_sessions(tmp_path: Path):
    backend = FakeBackend()
    host = AgentProtocolHost(backend, workspace_root=tmp_path)
    for role in ("plan", "work", "verify"):
        opened = host._sessions.open(
            session_id=f"{role}-session",
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
        "context_digest": "context-1",
        "execution_policy": {"sandbox_mode": "read_only", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
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
        "context": {},
    }
    for role in ("plan", "verify"):
        result = host.handle({
            "protocol_version": "1", "request_id": role,
            **common,
            "role": role,
            "role_session_id": f"{role}-session",
            "role_turn_id": f"{role}-turn",
            "stage_execution_id": f"{role}-execution",
            "context": stage_context(role),
        })
        assert "kind" not in result
        assert result["role"] == role
        assert result["outcome"]["kind"] == "canceled"

    work_payload = {
        **common,
        "role": "work",
        "role_session_id": "work-session",
        "role_turn_id": "work-turn",
        "stage_execution_id": "work-execution",
        "execution_policy": {"sandbox_mode": "workspace_write", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "repository_context": {**common["repository_context"], "workspace_access": "read_write"},
        "context": stage_context("work"),
    }
    work_payload = {"protocol_version": "1", "request_id": "work", **work_payload}
    result = host.handle(work_payload)
    assert result["outcome"]["kind"] == "canceled"
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
    host = AgentProtocolHost(backend)
    host.handle(open_root_request(request_id="root"))
    host._sessions.open(
        session_id="plan-session", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={}
    )
    result = host.handle(envelope("close", "close_cycle_stage_sessions", {
        "root_issue_id": "root-1", "cycle_issue_id": "cycle-1", "reason": "cycle_terminal",
    }))

    assert result["closed_session_ids"] == ["plan-session"]
    assert any(record.role == "root_reconciler" for record in host._sessions._sessions.values())
    assert backend.closed == ["provider-2"]
