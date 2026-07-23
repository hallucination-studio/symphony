from __future__ import annotations

from pathlib import Path
from threading import Event

import pytest

from performer.backends.provider_backend_interface import ProviderSession
from performer.session_runtime.manager import SessionError, SessionManager


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

    sessions.execute(root, {"role_turn_id": "r-1"}, workspace_root=None, cancel_event=Event())
    sessions.execute(work, {"role_turn_id": "w-1", "target_issue_id": "work-a"}, workspace_root=tmp_path, cancel_event=Event())
    sessions.execute(work, {"role_turn_id": "w-2", "target_issue_id": "work-b"}, workspace_root=tmp_path, cancel_event=Event())

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
