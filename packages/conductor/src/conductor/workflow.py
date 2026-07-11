from __future__ import annotations

from typing import Any

from performer_api.workflow import Plan

from .store import ConductorStore


class Workflow:
    def __init__(self, store: ConductorStore) -> None:
        self.store = store

    def accept_parent(self, parent_issue_id: str, issue_identifier: str, *, instance_id: str) -> dict[str, Any]:
        return self.store.create_run(parent_issue_id, issue_identifier, instance_id=instance_id)

    def commit_plan(self, run_id: str, plan: Plan, *, approval_required: bool | None = None) -> int:
        return self.store.save_plan(run_id, plan, approval_required=approval_required)

    def start_plan(self, run_id: str) -> dict[str, Any]:
        return self.store.start_plan(run_id)

    def record_plan(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        plan: Plan,
        *,
        policy_revision: int = 1,
        manifest_refs: list[str] | None = None,
    ) -> int:
        return self.store.record_plan(
            run_id,
            attempt_id,
            fencing_token,
            plan,
            policy_revision=policy_revision,
            manifest_refs=manifest_refs,
        )

    def record_runtime_wait(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        *,
        kind: str,
        reason: str,
    ) -> None:
        self.store.record_runtime_wait(run_id, attempt_id, fencing_token, kind=kind, reason=reason)

    def approve_plan(self, run_id: str, version: int, *, approval_id: str) -> None:
        self.store.approve_plan(run_id, version, approval_id=approval_id)

    def next_task(self, run_id: str) -> dict[str, Any] | None:
        return self.store.next_task(run_id)

    def start_task(self, run_id: str, task_id: str) -> dict[str, Any]:
        return self.store.start_task(run_id, task_id)

    def start_gate(self, run_id: str, task_id: str) -> dict[str, Any]:
        return self.store.start_gate(run_id, task_id)

    def record_execute(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        *,
        ready_for_gate: bool,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.store.record_execute(run_id, attempt_id, fencing_token, ready_for_gate=ready_for_gate, result=result)

    def record_gate(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        *,
        passed: bool,
        score: int,
        threshold: int = 3,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.store.record_gate(
            run_id,
            attempt_id,
            fencing_token,
            passed=passed,
            score=score,
            threshold=threshold,
            evidence=evidence,
        )


__all__ = ["Workflow"]
