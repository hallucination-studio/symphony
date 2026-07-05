from __future__ import annotations

from pathlib import Path

from conductor.conductor_phase import PhaseReducer, RunStatus
from conductor.conductor_reconcile import reconcile_orchestration_health
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


def _codes(findings) -> set[str]:
    return {finding.code for finding in findings}


def test_reconcile_detects_materialized_projection_drift(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    with store.connect() as connection:
        connection.execute("UPDATE orchestration_runs SET phase = ? WHERE run_id = ?", (RunPhase.FAILED.value, run.run_id))

    findings = reconcile_orchestration_health(store=store)

    assert "orchestration_projection_drift" in _codes(findings)


def test_reconcile_detects_orphan_claim_log_patterns(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")

    findings = reconcile_orchestration_health(
        store=store,
        log_lines=[
            "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
            "already_running_or_claimed",
            "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
            "already_running_or_claimed",
        ],
    )

    assert {"orphan_claim_detected", "already_claimed_without_worker"} <= _codes(findings)


def test_reconcile_codes_when_to_stop_waiting_event_rules(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
            reason="implementation_ready_for_review",
        )
    )
    store.apply_event(run.run_id, {"event_type": "gate.parent_mismatch", "to_phase": RunPhase.REVIEWING})
    store.apply_event(run.run_id, {"event_type": "evidence.missing", "to_phase": RunPhase.REVIEWING})
    store.apply_event(
        run.run_id,
        {
            "event_type": "projection.patch",
            "to_phase": RunPhase.REVIEWING,
            "payload": {"last_reason": "continuation", "retry_count": 1},
        },
    )

    findings = reconcile_orchestration_health(store=store)

    assert {
        "review_phase_projection_missing",
        "gate_parent_relationship_drift",
        "review_without_evidence",
        "continuation_recorded_as_retry",
    } <= _codes(findings)


def test_reconcile_accepts_review_after_linear_projection_event(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
        )
    )
    store.apply_event(
        run.run_id,
        {
            "event_type": "linear.projected_review_state",
            "to_phase": RunPhase.REVIEWING,
            "payload": {"status": RunStatus.QUEUED},
        },
    )

    assert "review_phase_projection_missing" not in _codes(reconcile_orchestration_health(store=store))
