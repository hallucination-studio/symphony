from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from performer_api.phase import RunPhase


DISPATCH_COUNTS = re.compile(r"running=(?P<running>\d+)\s+claimed=(?P<claimed>\d+)")


@dataclass(frozen=True)
class ReconcileFinding:
    code: str
    severity: str
    message: str
    run_id: str | None = None
    issue_id: str | None = None
    action: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "run_id": self.run_id,
            "issue_id": self.issue_id,
            "action": self.action,
        }


def reconcile_orchestration_health(*, store: Any, log_lines: list[str] | None = None) -> list[ReconcileFinding]:
    findings: list[ReconcileFinding] = []
    findings.extend(_reconcile_materialized_view(store))
    findings.extend(_reconcile_repeated_claim_without_worker(log_lines or []))
    for run in store.list_orchestration_runs():
        findings.extend(_reconcile_run_events(store, run))
        findings.extend(_reconcile_dependency_readiness(store, run))
    return findings


def _reconcile_materialized_view(store: Any) -> list[ReconcileFinding]:
    findings: list[ReconcileFinding] = []
    for run in store.list_orchestration_runs():
        try:
            rebuilt = store.rebuild_run(run.run_id)
        except Exception as exc:
            findings.append(
                ReconcileFinding(
                    code="orchestration_event_rebuild_failed",
                    severity="error",
                    message=f"event log could not rebuild run projection: {exc}",
                    run_id=run.run_id,
                    issue_id=run.issue_id,
                    action="investigate_event_log",
                )
            )
            continue
        if rebuilt != run:
            findings.append(
                ReconcileFinding(
                    code="orchestration_projection_drift",
                    severity="error",
                    message="materialized orchestration_runs row differs from event replay",
                    run_id=run.run_id,
                    issue_id=run.issue_id,
                    action="rewrite_projection_from_events",
                )
            )
    return findings


def _reconcile_repeated_claim_without_worker(log_lines: list[str]) -> list[ReconcileFinding]:
    rows: list[str] = []
    repeated_already_claimed = 0
    for line in log_lines:
        match = DISPATCH_COUNTS.search(line)
        if match and int(match.group("running")) == 0 and int(match.group("claimed")) > 0:
            rows.append(line[-500:])
        if "already_running_or_claimed" in line:
            repeated_already_claimed += 1
    findings: list[ReconcileFinding] = []
    if len(rows) >= 2:
        findings.append(
            ReconcileFinding(
                code="orphan_claim_detected",
                severity="error",
                message="logs repeatedly report running=0 with claimed>0",
                action="release_or_mark_orphan_claim",
            )
        )
    if repeated_already_claimed >= 2 and rows:
        findings.append(
            ReconcileFinding(
                code="already_claimed_without_worker",
                severity="error",
                message="already_running_or_claimed repeats while no worker is running",
                action="release_or_mark_orphan_claim",
            )
        )
    return findings


def _reconcile_run_events(store: Any, run: Any) -> list[ReconcileFinding]:
    events = store.list_orchestration_events(run.run_id)
    findings: list[ReconcileFinding] = []
    if run.phase is RunPhase.REVIEWING and not _event_seen(events, "linear.projected_review_state"):
        findings.append(
            ReconcileFinding(
                code="review_phase_projection_missing",
                severity="warning",
                message="run is reviewing but no Linear In Review projection event was recorded",
                run_id=run.run_id,
                issue_id=run.issue_id,
                action="replay_linear_projection",
            )
        )
    if _event_seen(events, "gate.parent_mismatch"):
        findings.append(
            ReconcileFinding(
                code="gate_parent_relationship_drift",
                severity="error",
                message="gate/evidence parent relationships are wrong",
                run_id=run.run_id,
                issue_id=run.issue_id,
                action="reconcile_linear_tree_projection",
            )
        )
    if run.phase is RunPhase.REVIEWING and _event_seen(events, "evidence.missing"):
        findings.append(
            ReconcileFinding(
                code="review_without_evidence",
                severity="error",
                message="evidence is missing while the issue is in review",
                run_id=run.run_id,
                issue_id=run.issue_id,
                action="return_to_implementation_projection",
            )
        )
    if run.last_reason == "continuation" and run.retry_count > 0:
        findings.append(
            ReconcileFinding(
                code="continuation_recorded_as_retry",
                severity="error",
                message="normal continuation appears in retry state",
                run_id=run.run_id,
                issue_id=run.issue_id,
                action="repair_continuation_projection",
            )
        )
    if run.last_reason in {"scenario_timeout", "turn_timeout"} and run.phase not in {RunPhase.QUEUED, RunPhase.FAILED}:
        findings.append(
            ReconcileFinding(
                code="scenario_timeout_unresolved",
                severity="error",
                message="run exceeded a scenario timeout without a queued or terminal projection",
                run_id=run.run_id,
                issue_id=run.issue_id,
                action="record_timeout_event",
            )
        )
    return findings


def _reconcile_dependency_readiness(store: Any, run: Any) -> list[ReconcileFinding]:
    if run.phase is not RunPhase.QUEUED or run.status != "queued":
        return []
    blocker_issue_ids = list(getattr(run, "blocked_by", []) or [])
    if not blocker_issue_ids:
        return []
    for blocker_issue_id in blocker_issue_ids:
        blocker = store.get_latest_orchestration_run_for_issue(blocker_issue_id)
        if blocker is None or blocker.phase not in {RunPhase.DONE, RunPhase.FAILED}:
            return []
    return [
        ReconcileFinding(
            code="dependency_readiness_drift",
            severity="warning",
            message="run is still queued behind dependencies even though all recorded blockers are terminal",
            run_id=run.run_id,
            issue_id=run.issue_id,
            action="requeue_dependency_ready_run",
        )
    ]


def _event_seen(events: list[Any], event_type: str) -> bool:
    return any(getattr(event, "event_type", "") == event_type for event in events)
