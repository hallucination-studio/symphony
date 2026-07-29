from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from threading import Event, Thread

import pytest

from performer.backends.provider_backend_interface import (
    ProviderSession,
    ProviderTurnAcceptanceUnknown,
    ProviderTurnAcceptedInvalid,
    ProviderTurnAcceptedValid,
    ProviderTurnCanceled,
    ProviderTurnFailure,
    ProviderTurnNotAccepted,
    ProviderTurnSessionLost,
)
from performer.session_runtime.manager import SessionError, SessionManager, SessionTurnFailure

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
        return ProviderTurnAcceptedValid(
            output={"kind": "turn_completed"},
            usage={"status": "unavailable", "reason": "provider_omitted"},
        )

    def interrupt_turn(self, session) -> None:
        pass

    def close_role_session(self, session) -> None:
        self.closed.append(session.provider_handle)


class BlockingBackend(FakeBackend):
    def __init__(self) -> None:
        super().__init__()
        self.started = Event()
        self.release = Event()

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        self.turns.append((session.provider_handle, request, workspace_root))
        self.started.set()
        self.release.wait(timeout=2)
        return ProviderTurnAcceptedValid(
            output={"kind": "turn_completed"},
            usage={"status": "unavailable", "reason": "provider_omitted"},
        )


class SequenceBackend(FakeBackend):
    def __init__(self, outcomes: list[object]) -> None:
        super().__init__()
        self.outcomes = outcomes

    def execute_role_turn(self, session, request, *, workspace_root, cancel_event):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class DeceptiveBackendError(RuntimeError):
    append_outcome = "accepted"


def provider_failure(code: str = "provider_test_failure") -> ProviderTurnFailure:
    return ProviderTurnFailure(
        code=code,
        sanitized_reason="The Provider test turn failed.",
        retryable=True,
        action_required="Fresh-read before another turn.",
    )


def session_manager(backend) -> SessionManager:
    return SessionManager(backend, process_generation="process-1")


def open_session(sessions: SessionManager, **kwargs):
    session_id = kwargs["session_id"]
    return sessions.open(session_generation=f"{session_id}-generation", **kwargs)


def test_root_reconciler_is_reused_across_cycles_and_work_is_reused_within_cycle(tmp_path: Path):
    backend = FakeBackend()
    sessions = session_manager(backend)
    root = open_session(sessions,
        session_id="root-session",
        role="root_reconciler",
        root_issue_id="root-1",
        cycle_issue_id=None,
        settings={"model": "gpt"},
    )
    work = open_session(sessions,
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
    sessions = session_manager(backend)
    for role in ("plan", "work", "verify"):
        open_session(sessions,
            session_id=f"{role}-1",
            role=role,
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={},
        )

    assert [role for role, _ in backend.opened] == ["plan", "work", "verify"]
    assert len({record.provider_session.provider_handle for record in sessions._sessions.values()}) == 3


def test_session_rejects_a_second_turn_before_provider_submission():
    backend = BlockingBackend()
    sessions = session_manager(backend)
    plan = open_session(sessions,
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    request = {
        "role_turn_id": "plan-turn-1",
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }
    errors: list[Exception] = []

    first = Thread(target=lambda: _capture_execute_error(sessions, plan, request, errors))
    first.start()
    assert backend.started.wait(timeout=2)

    with pytest.raises(SessionError, match="already has an active turn") as raised:
        sessions.execute(plan, {**request, "role_turn_id": "plan-turn-2"}, workspace_root=None, cancel_event=Event())

    backend.release.set()
    first.join(timeout=2)
    assert not first.is_alive()
    assert errors == []
    assert raised.value.code == "session_turn_already_active"
    assert len(backend.turns) == 1


def test_close_fences_a_late_provider_result_from_the_closed_session_generation():
    backend = BlockingBackend()
    sessions = session_manager(backend)
    work = open_session(sessions,
        session_id="work-1", role="work", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    request = {
        "role_turn_id": "work-turn-1",
        "role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []},
    }
    errors: list[Exception] = []

    turn = Thread(target=lambda: _capture_execute_error(sessions, work, request, errors))
    turn.start()
    assert backend.started.wait(timeout=2)
    sessions.close("work-1")
    backend.release.set()
    turn.join(timeout=2)

    assert not turn.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], SessionError)
    assert errors[0].code == "session_generation_closed"
    assert errors[0].continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert work.provider_visible_context_digest is None
    assert work.lifecycle_state == "closed"


def _capture_execute_error(
    sessions: SessionManager,
    record,
    request: dict[str, object],
    errors: list[Exception],
) -> None:
    try:
        sessions.execute(record, request, workspace_root=None, cancel_event=Event())
    except Exception as error:
        errors.append(error)


@pytest.mark.parametrize(
    ("outcome", "expected_continuity", "expected_digest", "session_retained"),
    [
        (
            ProviderTurnNotAccepted(provider_failure()),
            {"kind": "retained", "append_outcome": "not_accepted", "provider_visible_context_digest": "root-v1"},
            "root-v1",
            True,
        ),
        (
            ProviderTurnAcceptedInvalid(provider_failure()),
            {"kind": "retained", "append_outcome": "accepted", "provider_visible_context_digest": "root-v2"},
            "root-v2",
            True,
        ),
        (
            ProviderTurnAcceptanceUnknown(provider_failure()),
            {"kind": "closed", "append_outcome": "acceptance_unknown"},
            "root-v1",
            False,
        ),
        (
            ProviderTurnSessionLost(provider_failure("provider_session_lost")),
            {"kind": "closed", "append_outcome": "session_lost"},
            "root-v1",
            False,
        ),
        (
            ProviderTurnCanceled("accepted", False, "The Provider turn was canceled."),
            {"kind": "retained", "append_outcome": "accepted", "provider_visible_context_digest": "root-v2"},
            "root-v2",
            True,
        ),
        (
            ProviderTurnCanceled("acceptance_unknown", True, "The Provider turn deadline expired."),
            {"kind": "closed", "append_outcome": "acceptance_unknown"},
            "root-v1",
            False,
        ),
    ],
)
def test_provider_turn_outcome_exhaustively_controls_session_continuity(
    outcome,
    expected_continuity,
    expected_digest,
    session_retained,
):
    backend = SequenceBackend([
        ProviderTurnAcceptedValid({}, {"status": "unavailable", "reason": "provider_omitted"}),
        outcome,
    ])
    sessions = session_manager(backend)
    root = open_session(sessions,
        session_id="root-1", role="root_reconciler", root_issue_id="root-1", cycle_issue_id=None, settings={},
    )
    sessions.execute(root, {
        "kind": "open_root_reconciler", "bootstrap": {"root_digest": "root-v1"},
    }, workspace_root=None, cancel_event=Event())

    with pytest.raises(SessionTurnFailure) as raised:
        sessions.execute(root, {
            "kind": "advance_root_reconciler",
            "delta": {"base_root_digest": "root-v1", "target_root_digest": "root-v2"},
        }, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == expected_continuity
    assert root.provider_visible_context_digest == expected_digest
    assert ("root-1" in sessions._sessions) is session_retained


def test_backend_exception_cannot_spoof_an_accepted_append_outcome():
    backend = SequenceBackend([
        ProviderTurnAcceptedValid({}, {"status": "unavailable", "reason": "provider_omitted"}),
        DeceptiveBackendError("unclosed backend failure"),
    ])
    sessions = session_manager(backend)
    root = open_session(sessions,
        session_id="root-1", role="root_reconciler", root_issue_id="root-1", cycle_issue_id=None, settings={},
    )
    sessions.execute(root, {
        "kind": "open_root_reconciler", "bootstrap": {"root_digest": "root-v1"},
    }, workspace_root=None, cancel_event=Event())

    with pytest.raises(SessionTurnFailure) as raised:
        sessions.execute(root, {
            "kind": "advance_root_reconciler",
            "delta": {"base_root_digest": "root-v1", "target_root_digest": "root-v2"},
        }, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "acceptance_unknown"}
    assert root.provider_visible_context_digest == "root-v1"
    assert "root-1" not in sessions._sessions


def test_stage_initial_then_continuous_delta_advances_only_its_role_baseline():
    backend = FakeBackend()
    sessions = session_manager(backend)
    plan = open_session(sessions,
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    work = open_session(sessions,
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
    sessions = session_manager(FakeBackend())
    plan = open_session(sessions,
        session_id="plan-1", role="plan", root_issue_id="root-1", cycle_issue_id="cycle-1", settings={},
    )
    initial = {"role_context_update": {"kind": "initial", "target_context_digest": EMPTY_CONTEXT_DIGEST, "sources": []}}
    sessions.execute(plan, initial, workspace_root=None, cancel_event=Event())

    with pytest.raises(SessionError, match="cannot receive another initial") as raised:
        sessions.execute(plan, initial, workspace_root=None, cancel_event=Event())

    assert raised.value.continuity == {"kind": "closed", "append_outcome": "session_lost"}
    assert "plan-1" not in sessions._sessions


def test_discontinuous_stage_delta_closes_the_role_session():
    sessions = session_manager(FakeBackend())
    plan = open_session(sessions,
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
    sessions = session_manager(FakeBackend())
    plan = open_session(sessions,
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
    sessions = session_manager(FakeBackend())
    plan = open_session(sessions,
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
    sessions = session_manager(FakeBackend())
    open_session(sessions,
        session_id="plan-1",
        role="plan",
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        settings={},
    )

    with pytest.raises(SessionError, match="already has an open session"):
        open_session(sessions,
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
    sessions = session_manager(backend)
    open_session(sessions, session_id="root", role="root_reconciler", root_issue_id="r", cycle_issue_id=None, settings={})
    open_session(sessions, session_id="work-1", role="work", root_issue_id="r", cycle_issue_id="c1", settings={})
    open_session(sessions, session_id="work-2", role="work", root_issue_id="r", cycle_issue_id="c2", settings={})

    result = sessions.close_cycle(
        root_issue_id="r",
        cycle_issue_id="c1",
        expected_process_generation="process-1",
        expected_sessions={
            "plan": {"kind": "absent"},
            "work": {
                "kind": "expected",
                "role_session_id": "work-1",
                "session_generation": "work-1-generation",
            },
            "verify": {"kind": "absent"},
        },
    )

    assert result["kind"] == "all_closed"
    assert result["role_results"]["plan"]["close_outcome"] == "already_absent"
    assert result["role_results"]["work"]["close_outcome"] == "closed_now"
    assert result["role_results"]["verify"]["close_outcome"] == "already_absent"
    assert backend.closed == ["provider-2"]
    assert "root" in sessions._sessions
    assert "work-2" in sessions._sessions


def test_close_cycle_preserves_each_role_outcome_and_retries_a_pending_close():
    class PartialCloseBackend(FakeBackend):
        def __init__(self) -> None:
            super().__init__()
            self.fail_work = True

        def close_role_session(self, session) -> None:
            self.closed.append(session.provider_handle)
            if session.role == "work" and self.fail_work:
                raise RuntimeError("close failed")

    backend = PartialCloseBackend()
    sessions = SessionManager(backend, process_generation="process-1")
    for role in ("plan", "work", "verify"):
        sessions.open(
            session_id=f"{role}-session",
            session_generation=f"{role}-generation",
            role=role,
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={},
        )
    expected = {
        role: {
            "kind": "expected",
            "role_session_id": f"{role}-session",
            "session_generation": f"{role}-generation",
        }
        for role in ("plan", "work", "verify")
    }

    first = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-1",
        expected_sessions=expected,
    )

    assert first["kind"] == "close_incomplete"
    assert first["role_results"]["plan"]["close_outcome"] == "closed_now"
    assert first["role_results"]["work"] == {
        "kind": "close_pending",
        "role": "work",
        "role_session_id": "work-session",
        "close_reason": "provider_shutdown_pending",
        "sanitized_reason": "The Provider role session close is not yet confirmed.",
        "retryable": True,
        "action_required": "retry_close_only",
    }
    assert first["role_results"]["verify"]["close_outcome"] == "closed_now"
    assert sessions._sessions["work-session"].lifecycle_state == "closing"

    backend.fail_work = False
    second = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-1",
        expected_sessions=expected,
    )

    assert second["kind"] == "all_closed"
    assert second["role_results"]["plan"]["close_outcome"] == "already_closed"
    assert second["role_results"]["work"]["close_outcome"] == "closed_now"
    assert second["role_results"]["verify"]["close_outcome"] == "already_closed"


def test_stale_process_close_rejects_every_role_without_freezing_current_admission():
    backend = FakeBackend()
    sessions = SessionManager(backend, process_generation="process-current")

    result = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-stale",
        expected_sessions={
            "plan": {"kind": "absent"},
            "work": {"kind": "absent"},
            "verify": {"kind": "absent"},
        },
    )

    assert result["kind"] == "close_incomplete"
    assert {item["close_reason"] for item in result["role_results"].values()} == {"process_generation_mismatch"}
    sessions.open(
        session_id="plan-current",
        session_generation="plan-generation-current",
        role="plan",
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        settings={},
    )
    assert backend.closed == []


def test_stale_or_different_session_generation_never_closes_the_current_session():
    backend = FakeBackend()
    sessions = SessionManager(backend, process_generation="process-1")
    sessions.open(
        session_id="work-current",
        session_generation="work-generation-current",
        role="work",
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        settings={},
    )

    stale_generation = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-1",
        expected_sessions={
            "plan": {"kind": "absent"},
            "work": {
                "kind": "expected",
                "role_session_id": "work-current",
                "session_generation": "work-generation-stale",
            },
            "verify": {"kind": "absent"},
        },
    )
    different_session = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-1",
        expected_sessions={
            "plan": {"kind": "absent"},
            "work": {
                "kind": "expected",
                "role_session_id": "work-stale",
                "session_generation": "work-generation-stale",
            },
            "verify": {"kind": "absent"},
        },
    )

    assert stale_generation["role_results"]["work"]["close_reason"] == "session_generation_mismatch"
    assert different_session["role_results"]["work"]["close_reason"] == "concurrent_newer_session"
    assert sessions._sessions["work-current"].lifecycle_state == "open"
    assert backend.closed == []


def test_close_freeze_rejects_a_provider_session_that_finishes_opening_late():
    class BlockingOpenBackend(FakeBackend):
        def __init__(self) -> None:
            super().__init__()
            self.open_started = Event()
            self.open_release = Event()

        def open_role_session(self, role, settings):
            session = super().open_role_session(role, settings)
            self.open_started.set()
            assert self.open_release.wait(timeout=2)
            return session

    backend = BlockingOpenBackend()
    sessions = SessionManager(backend, process_generation="process-1")
    errors: list[Exception] = []

    opening = Thread(target=lambda: _capture_open_error(sessions, errors))
    opening.start()
    assert backend.open_started.wait(timeout=2)
    result = sessions.close_cycle(
        root_issue_id="root-1",
        cycle_issue_id="cycle-1",
        expected_process_generation="process-1",
        expected_sessions={
            "plan": {"kind": "absent"},
            "work": {"kind": "absent"},
            "verify": {"kind": "absent"},
        },
    )
    backend.open_release.set()
    opening.join(timeout=2)

    assert result["kind"] == "all_closed"
    assert len(errors) == 1
    assert isinstance(errors[0], SessionError)
    assert errors[0].code == "cycle_stage_admission_frozen"
    assert sessions._sessions == {}
    assert backend.closed == ["provider-1"]


def _capture_open_error(sessions: SessionManager, errors: list[Exception]) -> None:
    try:
        sessions.open(
            session_id="plan-late",
            session_generation="plan-generation-late",
            role="plan",
            root_issue_id="root-1",
            cycle_issue_id="cycle-1",
            settings={},
        )
    except Exception as error:
        errors.append(error)
