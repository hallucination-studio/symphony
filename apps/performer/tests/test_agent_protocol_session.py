from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from threading import Event

import pytest

from performer.backends.provider_backend_interface import ProviderSession
from performer.session_runtime.manager import SessionError, SessionManager

EMPTY_CONTEXT_DIGEST = sha256(b"[]").hexdigest()


def stage_digest(*entries: tuple[str, str, str, str]) -> str:
    encoded = json.dumps(sorted(entries), separators=(",", ":"))
    return sha256(encoded.encode()).hexdigest()


def issue_source(version: str, *, operation: str = "current_value") -> dict[str, object]:
    return {
        "kind": operation,
        "source_kind": "linear_issue",
        "source_id": "issue-1",
        "source_version_or_digest": version,
        "actor_kind": "human",
        "value": {"kind": "issue"},
    }


class FakeBackend:
    def __init__(self) -> None:
        self.opened: list[tuple[str, dict[str, object]]] = []
        self.turns: list[tuple[str, dict[str, object], Path | None]] = []
        self.closed: list[str] = []

    def open_role_session(self, role: str, settings: dict[str, object]) -> ProviderSession:
        self.opened.append((role, settings))
        return ProviderSession(role, f"provider-{len(self.opened)}")

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        self.turns.append((session.provider_handle, request, workspace_root))
        return {"output": {"kind": "turn_completed"}}

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


def test_root_reconciler_is_reused_across_cycles_and_work_is_reused_within_cycle(tmp_path: Path):
    backend = FakeBackend()
    sessions = SessionManager(backend)
    root = sessions.open(
        session_id="root-session",
        role="root_reconciler",
        root_issue_id="root-1",
        cycle_issue_id=None,
        settings={"model": "gpt"},
    )
    work = sessions.open(
        session_id="work-session",
        role="work",
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        settings={"model": "gpt"},
    )

    sessions.execute(root, {
        "kind": "open_root_reconciler",
        "bootstrap": {"root_digest": "root-context-1"},
    }, workspace_root=None, cancel_event=Event())
    sessions.execute(work, {
        "role_turn_id": "w-1", "target_issue_id": "work-a",
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }, workspace_root=tmp_path, cancel_event=Event())
    sessions.execute(work, {
        "role_turn_id": "w-2", "target_issue_id": "work-b",
        "role_context_update": {
            "kind": "delta", "base_context_digest": EMPTY_CONTEXT_DIGEST,
            "target_context_digest": EMPTY_CONTEXT_DIGEST, "changes": [],
        },
    }, workspace_root=tmp_path, cancel_event=Event())

    assert [handle for handle, _, _ in backend.turns] == ["provider-1", "provider-2", "provider-2"]
    assert backend.turns[-1][2] == tmp_path


def test_stage_sessions_are_isolated_by_role_and_cycle():
    backend = FakeBackend()
    sessions = SessionManager(backend)
    for role in ("plan", "work", "verify"):
        sessions.open(
            session_id=f"{role}-1",
            role=role,
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={},
        )

    assert [role for role, _ in backend.opened] == ["plan", "work", "verify"]
    assert len({record.provider_session.provider_handle for record in sessions._sessions.values()}) == 3


def test_stage_initial_then_continuous_delta_advances_only_its_role_baseline():
    backend = FakeBackend()
    sessions = SessionManager(backend)
    plan = sessions.open(
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    work = sessions.open(
        session_id="work-1", role="work", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )

    sessions.execute(plan, {
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }, workspace_root=None, cancel_event=Event())
    sessions.execute(work, {
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }, workspace_root=None, cancel_event=Event())
    sessions.execute(plan, {
        "role_context_update": {
            "kind": "delta", "base_context_digest": EMPTY_CONTEXT_DIGEST,
            "target_context_digest": EMPTY_CONTEXT_DIGEST, "changes": [],
        },
    }, workspace_root=None, cancel_event=Event())

    assert plan.provider_visible_context_digest == EMPTY_CONTEXT_DIGEST
    assert work.provider_visible_context_digest == EMPTY_CONTEXT_DIGEST


def test_repeated_stage_initial_closes_the_role_session():
    sessions = SessionManager(FakeBackend())
    plan = sessions.open(
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    initial = {"role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []}}
    sessions.execute(plan, initial, workspace_root=None, cancel_event=Event())

    with pytest.raises(SessionError, match="cannot receive another initial") as raised:
        sessions.execute(plan, initial, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert "plan-1" not in sessions._sessions


def test_discontinuous_stage_delta_closes_the_role_session():
    sessions = SessionManager(FakeBackend())
    plan = sessions.open(
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    sessions.execute(plan, {
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }, workspace_root=None, cancel_event=Event())

    with pytest.raises(SessionError, match="baseline is discontinuous") as raised:
        sessions.execute(plan, {
            "role_context_update": {
                "kind": "delta", "base_context_digest": "unknown",
                "target_context_digest": EMPTY_CONTEXT_DIGEST, "changes": [],
            },
        }, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert "plan-1" not in sessions._sessions


def test_stage_replacement_with_wrong_version_closes_the_role_session():
    sessions = SessionManager(FakeBackend())
    plan = sessions.open(
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    initial_digest = stage_digest(("linear_issue", "issue-1", "v1", "human"))
    sessions.execute(plan, {
        "role_context_update": {
            "kind": "initial", "target_context_digest": initial_digest, "sources": [issue_source("v1")],
        },
    }, workspace_root=None, cancel_event=Event())
    replacement = issue_source("v2", operation="replacement")
    replacement["replaces_source_version_or_digest"] = "wrong-version"

    with pytest.raises(SessionError, match="replacement precondition failed") as raised:
        sessions.execute(plan, {
            "role_context_update": {
                "kind": "delta", "base_context_digest": initial_digest,
                "target_context_digest": stage_digest(("linear_issue", "issue-1", "v2", "human")),
                "changes": [replacement],
            },
        }, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert "plan-1" not in sessions._sessions


def test_stage_target_digest_mismatch_closes_the_role_session():
    sessions = SessionManager(FakeBackend())
    plan = sessions.open(
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )

    with pytest.raises(SessionError, match="initial context digest is invalid") as raised:
        sessions.execute(plan, {
            "role_context_update": {
                "kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST,
                "sources": [issue_source("v1")],
            },
        }, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert "plan-1" not in sessions._sessions


def test_duplicate_role_scope_and_wrong_scope_fail_closed():
    sessions = SessionManager(FakeBackend())
    sessions.open(
        session_id="plan-1",
        role="plan",
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        settings={},
    )

    with pytest.raises(SessionError, match="already has an open session"):
        sessions.open(
            session_id="plan-2",
            role="plan",
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={},
        )
    with pytest.raises(SessionError, match="scope does not match"):
        sessions.get("plan-1", role="verify", root_issue_id="root-1", cycle_issue_id="cycle-1")


def test_close_cycle_only_closes_its_three_stage_sessions():
    backend = FakeBackend()
    sessions = SessionManager(backend)
    sessions.open(session_id="root", role="root_reconciler", root_issue_id="r", cycle_issue_id=None, settings={})
    sessions.open(session_id="work-1", role="work", root_issue_id="r", cycle_issue_id="c1", settings={})
    sessions.open(session_id="work-2", role="work", root_issue_id="r", cycle_issue_id="c2", settings={})

    assert sessions.close_cycle(root_issue_id="r", cycle_issue_id="c1") == ["work-1"]
    assert backend.closed == ["provider-2"]
    assert "root" in sessions._sessions
    assert "work-2" in sessions._sessions
