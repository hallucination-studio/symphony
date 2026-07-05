from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from performer_api.phase import RunPhase

from .conductor_phase import RunStatus
from .conductor_reconcile import ReconcileFinding


@dataclass(frozen=True)
class RemediationPolicy:
    max_attempts: int = 3


class OrchestrationRemediator:
    def __init__(self, store: Any, *, policy: RemediationPolicy | None = None):
        self.store = store
        self.policy = policy or RemediationPolicy()

    def remediate(self, findings: list[ReconcileFinding]) -> dict[str, int]:
        result = {"repaired": 0, "escalated": 0, "skipped": 0, "failed": 0}
        for finding in findings:
            try:
                outcome = self._remediate_one(finding)
            except Exception:
                result["failed"] += 1
                continue
            result[outcome] += 1
        return result

    def _remediate_one(self, finding: ReconcileFinding) -> str:
        if finding.code == "orchestration_projection_drift":
            return self._rebuild_projection(finding)
        if finding.code in {"orphan_claim_detected", "already_claimed_without_worker"}:
            return self._release_orphan_claim(finding)
        if finding.code == "review_phase_projection_missing":
            return self._request_linear_projection_replay(finding)
        if finding.code == "review_without_evidence":
            return self._return_to_rework(finding)
        if finding.code == "continuation_recorded_as_retry":
            return self._repair_continuation_projection(finding)
        if finding.code in {
            "gate_parent_relationship_drift",
            "scenario_timeout_unresolved",
            "orchestration_event_rebuild_failed",
        }:
            return self._escalate_for_human_action(finding)
        return "skipped"

    def _rebuild_projection(self, finding: ReconcileFinding) -> str:
        run = self._require_run(finding)
        rebuilt = self.store.rebuild_run(run.run_id)
        payload = _projection_payload(rebuilt)
        payload["remediation"] = _finding_payload(finding)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.projection_rebuilt",
                "to_phase": rebuilt.phase,
                "reason": finding.code,
                "payload": payload,
            },
            expected_current_phases={run.phase},
        )
        return "repaired"

    def _release_orphan_claim(self, finding: ReconcileFinding) -> str:
        if not finding.run_id:
            return "skipped"
        run = self._require_run(finding)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.orphan_claim_released",
                "to_phase": RunPhase.QUEUED,
                "reason": finding.code,
                "payload": {
                    "phase": RunPhase.QUEUED,
                    "status": RunStatus.QUEUED,
                    "process_pid": None,
                    "next_run_at": None,
                    "last_reason": finding.code,
                    "last_error": finding.message,
                    "remediation": _finding_payload(finding),
                },
            },
            expected_current_phases={run.phase},
        )
        return "repaired"

    def _request_linear_projection_replay(self, finding: ReconcileFinding) -> str:
        run = self._require_run(finding)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.linear_projection_replay_requested",
                "to_phase": run.phase,
                "reason": finding.code,
                "payload": {
                    "last_reason": finding.code,
                    "remediation": _finding_payload(finding),
                },
            },
            expected_current_phases={run.phase},
        )
        return "repaired"

    def _return_to_rework(self, finding: ReconcileFinding) -> str:
        run = self._require_run(finding)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.review_without_evidence_requeued",
                "to_phase": RunPhase.REWORKING,
                "reason": finding.code,
                "payload": {
                    "phase": RunPhase.REWORKING,
                    "status": RunStatus.QUEUED,
                    "process_pid": None,
                    "next_run_at": None,
                    "last_reason": finding.code,
                    "last_error": finding.message,
                    "remediation": _finding_payload(finding),
                },
            },
            expected_current_phases={run.phase},
        )
        return "repaired"

    def _repair_continuation_projection(self, finding: ReconcileFinding) -> str:
        run = self._require_run(finding)
        retry_count = max(run.retry_count - 1, 0)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.continuation_retry_count_repaired",
                "to_phase": run.phase,
                "reason": finding.code,
                "payload": {
                    "retry_count": retry_count,
                    "last_reason": "continuation",
                    "last_error": None,
                    "remediation": _finding_payload(finding),
                },
            },
            expected_current_phases={run.phase},
        )
        return "repaired"

    def _escalate_for_human_action(self, finding: ReconcileFinding) -> str:
        run = self._require_run(finding)
        self.store.apply_event(
            run.run_id,
            {
                "event_type": "remediation.human_action_required",
                "to_phase": RunPhase.FAILED,
                "reason": finding.code,
                "payload": {
                    "phase": RunPhase.FAILED,
                    "status": RunStatus.FAILED,
                    "last_reason": finding.code,
                    "last_error": finding.message,
                    "process_pid": None,
                    "next_run_at": None,
                    "ack_status": "pending",
                    "remediation": _finding_payload(finding),
                },
            },
            expected_current_phases={run.phase},
        )
        return "escalated"

    def _require_run(self, finding: ReconcileFinding) -> Any:
        if not finding.run_id:
            raise FileNotFoundError(f"Remediation finding has no run_id: {finding.code}")
        run = self.store.get_orchestration_run(finding.run_id)
        if run is None:
            raise FileNotFoundError(f"Remediation run not found: {finding.run_id}")
        return run


def _projection_payload(run: Any) -> dict[str, Any]:
    payload = run.to_dict()
    payload.pop("run_id", None)
    payload.pop("instance_id", None)
    payload.pop("issue_id", None)
    payload.pop("created_at", None)
    payload.pop("updated_at", None)
    return payload


def _finding_payload(finding: ReconcileFinding) -> dict[str, Any]:
    return finding.to_dict()
