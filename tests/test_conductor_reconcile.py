from __future__ import annotations

from pathlib import Path

from conductor.conductor_phase import PhaseReducer, RunStatus
from conductor.conductor_reconcile import ReconcileFinding, reconcile_orchestration_health
from conductor.conductor_remediation import OrchestrationRemediator
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


def test_reconcile_reports_dependency_readiness_drift_when_all_blockers_terminal(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    blocker = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    blocked = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id="dispatch-2",
        blocked_by=[blocker.issue_id],
    )
    reducer.performer_started(blocker.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=blocker.run_id,
            issue_id=blocker.issue_id,
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )

    findings = reconcile_orchestration_health(store=store)

    drift = next(finding for finding in findings if finding.code == "dependency_readiness_drift")
    assert drift.run_id == blocked.run_id
    assert drift.issue_id == blocked.issue_id


def test_remediator_rewrites_materialized_projection_drift_from_event_log(tmp_path: Path) -> None:
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
    finding = reconcile_orchestration_health(store=store)[0]

    result = OrchestrationRemediator(store).remediate([finding])

    repaired = store.get_orchestration_run(run.run_id)
    events = store.list_orchestration_events(run.run_id)
    assert result["repaired"] == 1
    assert repaired is not None
    assert repaired.phase is RunPhase.QUEUED
    assert "orchestration_projection_drift" not in _codes(reconcile_orchestration_health(store=store))
    assert events[-1].event_type == "remediation.projection_rebuilt"


def test_remediator_records_repair_event_for_orphan_claim_finding_with_run(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    run = reducer.dispatch_received(
        instance_id="inst-1",
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json", pid=123)
    finding = ReconcileFinding(
        code="orphan_claim_detected",
        severity="error",
        message="stale claim",
        run_id=run.run_id,
        issue_id=run.issue_id,
        action="release_or_mark_orphan_claim",
    )

    result = OrchestrationRemediator(store).remediate([finding])

    repaired = store.get_orchestration_run(run.run_id)
    events = store.list_orchestration_events(run.run_id)
    assert result["repaired"] == 1
    assert repaired is not None
    assert repaired.phase is RunPhase.QUEUED
    assert repaired.status == RunStatus.QUEUED
    assert repaired.process_pid is None
    assert events[-1].event_type == "remediation.orphan_claim_released"


def test_remediator_escalates_timeout_finding_to_failed_run_for_human_action(tmp_path: Path) -> None:
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
    store.apply_event(
        run.run_id,
        {
            "event_type": "projection.patch",
            "to_phase": RunPhase.IMPLEMENTING,
            "payload": {"last_reason": "scenario_timeout"},
        },
    )
    finding = next(finding for finding in reconcile_orchestration_health(store=store) if finding.code == "scenario_timeout_unresolved")

    result = OrchestrationRemediator(store).remediate([finding])

    failed = store.get_orchestration_run(run.run_id)
    events = store.list_orchestration_events(run.run_id)
    assert result["escalated"] == 1
    assert failed is not None
    assert failed.phase is RunPhase.FAILED
    assert failed.ack_status == "pending"
    assert failed.last_reason == "scenario_timeout_unresolved"
    assert events[-1].event_type == "remediation.human_action_required"


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
