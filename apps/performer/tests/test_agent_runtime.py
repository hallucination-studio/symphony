from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from performer.agent_protocol.host import AgentProtocolHost
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
            return {"output": {"action": {"kind": "wait", "reason_code": "human", "blocking_fact_refs": [{"reference_id": "fact-1", "source_kind": "result"}]}}}
        return {"output": {"kind": "canceled", "sanitized_reason": "test cancellation"}, "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


def envelope(request_id: str, kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"protocol_version": "1", "request_id": request_id, "kind": kind, **payload}


def root_observation(request_id: str, session_id: str, turn_id: str) -> dict[str, object]:
    return {
        "protocol_version": "1",
        "request_id": request_id,
        "reconciler_session_id": session_id,
        "reconciler_turn_id": turn_id,
        "observed_at": "2026-07-23T00:00:00Z",
        "root": {
            "issue": {
                "issue_id": "root-1", "issue_kind": "root", "title": "Root", "description": "Root description",
                "status": "Todo", "is_archived": False, "remote_version": "root-v1",
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
        "root_human_actions": [],
        "accepted_root_directives": [],
        "root_reconciler_failures": [],
        "pending_user_comments": [],
        "reconciler_reply_records": [],
        "external_linear_changes": [],
        "workflow_change_resolutions": [],
        "git_facts": {"head_revision": "head-1", "baseline_revision": "head-1", "status_summary": "clean", "changed_paths": []},
        "delivery": {"record_id": "delivery-1", "record_kind": "delivery", "version": "1"},
        "source_manifest": [],
        "coverage": {"is_complete": True, "omissions": []},
        "observed_root_tree_digest": "tree-1",
        "limits": {
            "max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1,
            "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2027-07-23T00:00:00Z",
        },
    }


def issue_snapshot(kind: str) -> dict[str, object]:
    return {
        "issue_id": f"{kind}-1", "issue_kind": kind, "title": kind.title(), "description": f"{kind} description",
        "status": "Todo", "is_archived": False, "remote_version": f"{kind}-v1",
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

    opened = host.handle(envelope("open", "open_root_reconciler", {
        "root_issue_id": "root-1",
        "performer_profile_id": "profile-1",
        "model_settings": {"model": "gpt", "reasoning_effort": "medium", "is_fast_mode_enabled": False},
        "execution_policy": {"sandbox_mode": "read_only", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "limits": {"max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1, "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2026-07-23T00:00:00Z"},
    }))
    result = host.handle(root_observation("turn", opened["reconciler_session_id"], "turn-1"))

    assert opened["kind"] == "root_reconciler_opened"
    assert result["action"]["kind"] == "wait"
    assert backend.turns[0][0] == "provider-1"


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
    host.handle(envelope("root", "open_root_reconciler", {
        "root_issue_id": "root-1", "performer_profile_id": "profile-1",
        "model_settings": {"model": "gpt", "reasoning_effort": "medium", "is_fast_mode_enabled": False},
        "execution_policy": {"sandbox_mode": "read_only", "allowed_tools": [], "denied_tools": [], "network_policy": "disabled"},
        "limits": {"max_context_bytes": 1, "max_result_bytes": 1, "max_output_tokens": 1, "max_tool_calls": 0, "max_wall_time_ms": 1000, "deadline_at": "2026-07-23T00:00:00Z"},
    }))
    host._sessions.open(
        session_id="plan-session", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={}
    )
    result = host.handle(envelope("close", "close_cycle_stage_sessions", {
        "root_issue_id": "root-1", "cycle_issue_id": "cycle-1", "reason": "cycle_terminal",
    }))

    assert result["closed_session_ids"] == ["plan-session"]
    assert any(record.role == "root_reconciler" for record in host._sessions._sessions.values())
    assert backend.closed == ["provider-2"]
