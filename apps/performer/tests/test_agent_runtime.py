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
            return {"output": {"kind": "directive", "action": {"kind": "wait", "reason_code": "human"}}}
        return {"output": {"kind": f"{session.role}_completed"}, "usage": {"total_tokens": 2}}

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


def envelope(request_id: str, kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"protocol_version": "1", "request_id": request_id, "kind": kind, **payload}


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
    result = host.handle(envelope("turn", "advance_root_reconciler", {
        "role_session_id": opened["reconciler_session_id"],
        "role_turn_id": "turn-1",
        "root_issue_id": "root-1",
        "observed_root_tree_digest": "tree-1",
            "observation": {"root": "complete tree"},
    }))

    assert opened["kind"] == "root_reconciler_opened"
    assert result["kind"] == "root_directive"
    assert result["directive"]["action"]["kind"] == "wait"
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
        "execution_policy": {"sandbox_mode": "read_only", "workspace_access": "read_only"},
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
        result = host.handle(envelope(role, f"execute_{role}_turn", {
            **common,
            "role": role,
            "role_session_id": f"{role}-session",
            "role_turn_id": f"{role}-turn",
            "stage_execution_id": f"{role}-execution",
        }))
        assert result["kind"] == "stage_result"
        assert result["result"]["kind"] == f"{role}_completed"

    work_payload = {
        **common,
        "role": "work",
        "role_session_id": "work-session",
        "role_turn_id": "work-turn",
        "stage_execution_id": "work-execution",
        "execution_policy": {"sandbox_mode": "workspace_write", "workspace_access": "read_write"},
        "workspace_capability": {"access": "workspace_write"},
    }
    result = host.handle(envelope("work", "execute_work_turn", work_payload))
    assert result["result"]["kind"] == "work_completed"
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
