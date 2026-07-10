from __future__ import annotations

import logging
from typing import Any

from performer_api.managed_runs import ManagedRunTurnContext


LOGGER = logging.getLogger("conductor.managed_run_fencing")


def build_turn_context(
    run: dict[str, Any],
    attempt: dict[str, Any],
    *,
    work_item_id: str,
    policy_revision: int,
) -> ManagedRunTurnContext:
    attempt_id = str(attempt.get("attempt_id") or "")
    return ManagedRunTurnContext(
        run_id=str(run.get("run_id") or ""),
        work_item_id=work_item_id,
        policy_revision=policy_revision,
        plan_version=int(run.get("plan_version") or 0),
        lease_id=f"lease-{attempt_id}",
        fencing_token=f"fence-{attempt_id}",
        turn_id=attempt_id,
    )


def attempt_fencing_fields(context: ManagedRunTurnContext) -> dict[str, Any]:
    return {
        "turn_context": context.to_dict(),
        "run_id": context.run_id,
        "policy_revision": context.policy_revision,
        "plan_version": context.plan_version,
        "lease_id": context.lease_id,
        "fencing_token": context.fencing_token,
        "turn_id": context.turn_id,
    }


def plan_turn_request(
    *,
    workspace_path: str,
    issue_description: str,
    thread_id: str | None,
    context: ManagedRunTurnContext,
    revision: dict[str, Any],
) -> dict[str, Any]:
    request = {
        "turn_kind": "plan",
        "workspace_path": workspace_path,
        "issue_description": issue_description,
        "thread_id": thread_id,
        "context": context.to_dict(),
    }
    if revision:
        request.update({"plan_mode": "revision", "plan_revision": revision})
    return request


def result_context_error(run: dict[str, Any], attempt: dict[str, Any], payload: dict[str, Any]) -> str | None:
    expected_payload = attempt.get("turn_context") if isinstance(attempt.get("turn_context"), dict) else {}
    expected = ManagedRunTurnContext.from_dict(expected_payload)
    expected_errors = expected.validation_errors()
    if expected_errors:
        return f"attempt_turn_context_invalid:{expected_errors[0]}"
    actual_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    actual = ManagedRunTurnContext.from_dict(actual_payload)
    mismatch = expected.mismatch_reason(actual)
    if mismatch:
        return mismatch
    if expected.plan_version != int(run.get("plan_version") or 0):
        return "stale_plan_version"
    run_payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    policy_revision = int(run_payload.get("last_managed_run_policy_version") or expected.policy_revision)
    if expected.policy_revision != policy_revision:
        return "stale_policy_revision"
    return None


def log_result_rejection(run: dict[str, Any], attempt: dict[str, Any], reason: str) -> None:
    context = attempt.get("turn_context") if isinstance(attempt.get("turn_context"), dict) else {}
    LOGGER.error(
        "event=managed_run_result_rejected run_id=%s work_item_id=%s turn_id=%s lease_id=%s policy_revision=%s plan_version=%s error_code=%s sanitized_reason=%s action_required=retry_turn retryable=false next_action=inspect_attempt",
        run.get("run_id"),
        context.get("work_item_id") or "-",
        context.get("turn_id") or "-",
        context.get("lease_id") or "-",
        context.get("policy_revision") or 0,
        context.get("plan_version") or 0,
        reason,
        reason,
    )


__all__ = ["attempt_fencing_fields", "build_turn_context", "log_result_rejection", "plan_turn_request", "result_context_error"]
