from __future__ import annotations

from conductor.store import ConductorStore
from performer_api.performer_control import (
    PerformerControlError,
    PerformerReadinessState,
)


POLICY_HASH = "a" * 64


def _readiness(status: str) -> PerformerReadinessState:
    error = (
        PerformerControlError(
            error_code="performer_check_failed",
            sanitized_reason="The backend Check failed.",
            action_required=True,
            retryable=False,
            attempt_number=1,
            next_action="Correct backend configuration and run Check again.",
        )
        if status == "failed"
        else None
    )
    return PerformerReadinessState(
        performer_kind="codex",
        binding_generation=7,
        capability_version=1,
        execution_policy_sha256=POLICY_HASH,
        status=status,
        last_check_status=("passed" if status == "ready" else "failed"),
        error=error,
    )


def test_store_initializes_one_generic_unchecked_performer_state(tmp_path) -> None:
    store = ConductorStore(tmp_path)

    state = store.get_performer_control_state()

    assert state == {
        "performer_kind": "",
        "binding_generation": 0,
        "capability_version": 0,
        "execution_policy_sha256": "",
        "status": "unchecked",
        "last_check_status": "none",
        "last_check_started_at": None,
        "last_check_finished_at": None,
        "error_code": None,
        "sanitized_reason": None,
        "action_required": False,
        "retryable": False,
        "attempt_number": None,
        "next_action": None,
        "updated_at": state["updated_at"],
    }


def test_store_restart_resets_current_readiness_but_keeps_last_check_evidence(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    store.record_performer_readiness(
        _readiness("ready"),
        check_started_at="2026-07-13T00:00:00Z",
        check_finished_at="2026-07-13T00:00:02Z",
    )

    restarted = ConductorStore(tmp_path)
    state = restarted.get_performer_control_state()

    assert state["status"] == "unchecked"
    assert state["last_check_status"] == "passed"
    assert state["last_check_started_at"] == "2026-07-13T00:00:00Z"
    assert state["last_check_finished_at"] == "2026-07-13T00:00:02Z"
    assert state["performer_kind"] == "codex"
    assert state["binding_generation"] == 7
    assert state["execution_policy_sha256"] == POLICY_HASH


def test_identity_change_invalidates_and_clears_incompatible_check_evidence(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    store.record_performer_readiness(_readiness("ready"))

    state = store.ensure_performer_control_identity(
        performer_kind="codex",
        binding_generation=8,
        capability_version=1,
        execution_policy_sha256=POLICY_HASH,
    )

    assert state["status"] == "unchecked"
    assert state["binding_generation"] == 8
    assert state["last_check_status"] == "none"
    assert state["error_code"] is None


def test_failed_readiness_persists_standard_sanitized_error_fields(tmp_path) -> None:
    store = ConductorStore(tmp_path)

    state = store.record_performer_readiness(
        _readiness("failed"),
        check_started_at="2026-07-13T00:00:00Z",
        check_finished_at="2026-07-13T00:00:02Z",
    )

    assert state["status"] == "failed"
    assert state["last_check_status"] == "failed"
    assert state["error_code"] == "performer_check_failed"
    assert state["sanitized_reason"] == "The backend Check failed."
    assert state["action_required"] is True
    assert state["retryable"] is False
    assert state["attempt_number"] == 1
    assert state["next_action"] == "Correct backend configuration and run Check again."
