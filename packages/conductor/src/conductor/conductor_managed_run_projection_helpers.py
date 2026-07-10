from __future__ import annotations

from typing import Any

from performer_api.managed_runs import ManagedRunState, WorkItemState

from .conductor_managed_run_attempts import canonical_attempt_records


def linear_state_target(state: str) -> tuple[list[str], str]:
    if state == WorkItemState.TODO.value:
        return ["Todo"], "unstarted"
    if state == WorkItemState.IN_PROGRESS.value:
        return ["In Progress"], "started"
    if state == WorkItemState.IN_REVIEW.value:
        return ["In Review"], "started"
    if state == WorkItemState.DONE.value:
        return ["Done"], "completed"
    if state == WorkItemState.BLOCKED.value:
        return ["Blocked", "Needs More"], "unstarted"
    if state == WorkItemState.CANCELLED.value:
        return ["Canceled", "Cancelled"], "canceled"
    return ["Todo"], "unstarted"


def parent_linear_state_target(run_state: str) -> tuple[list[str], str]:
    if run_state in {ManagedRunState.VERIFIED.value, ManagedRunState.DONE.value}:
        return ["Done"], "completed"
    if run_state in {ManagedRunState.AWAITING_APPROVAL.value, ManagedRunState.BLOCKED.value, ManagedRunState.FAILED.value}:
        return ["Blocked", "Needs More"], "unstarted"
    return ["In Progress"], "started"


def rubric_results(plan: Any, items: list[dict[str, Any]], *, checkpoint_evidence: list[str] | None = None, complete: bool) -> list[dict[str, Any]]:
    evidence = [str(item.get("gate_status") or item.get("state") or "") for item in items] + list(checkpoint_evidence or [])
    rubric = getattr(plan, "verification_rubric", None)
    if rubric is None:
        return [{"area": "correctness", "status": "passed" if complete else "pending", "evidence": evidence}]
    results = []
    for area in ["correctness", "quality", "integration", "documentation", "ship_readiness"]:
        checks = list(getattr(rubric, area, []) or [])
        results.append({"area": area, "status": "passed" if complete else "pending", "evidence": checks + evidence})
    return results


def checkpoint_evidence(results: list[dict[str, Any]]) -> list[str]:
    evidence: list[str] = []
    for result in results:
        status = "checkpoint_passed" if result.get("passed") else "checkpoint_failed"
        after = ",".join(str(item) for item in result.get("after") or [])
        verify = " && ".join(str(item) for item in result.get("verify") or [])
        reason = str(result.get("reason") or "")
        evidence.append(f"{status}:{after}:{verify}:{reason}")
    return evidence


def residual_risks(plan: Any, *, complete: bool) -> list[str]:
    risks: list[str] = []
    for risk in getattr(plan, "risks", []) or []:
        if isinstance(risk, dict):
            risks.append(str(risk.get("summary") or risk.get("risk") or risk))
        else:
            risks.append(str(risk))
    if not complete:
        return risks + ["Run is not complete."]
    return risks


def summary_text(value: Any) -> str:
    return str(value or "").replace("\n", " ").replace("\r", " ").strip()[:300]


def projection_health_lines(payload: dict[str, Any]) -> list[str]:
    if "projection_healthy" not in payload:
        return []
    healthy = bool(payload.get("projection_healthy"))
    lines = [f"projection_healthy: {str(healthy).lower()}"]
    last_success = summary_text(payload.get("last_successful_projection_at"))
    if last_success:
        lines.append(f"last_successful_projection_at: {last_success}")
    error = payload.get("last_projection_error")
    if isinstance(error, dict) and error.get("sanitized_reason"):
        lines.append(f"last_projection_error: {summary_text(error.get('sanitized_reason'))}")
    return lines


def attempts_for_work_item(payload: dict[str, Any], work_item_id: str) -> list[dict[str, Any]]:
    return [attempt for attempt in canonical_attempt_records(payload) if str(attempt.get("work_item_id") or "") == work_item_id]


def attempt_ids_for_work_item(payload: dict[str, Any], work_item_id: str) -> list[str]:
    return [str(attempt.get("attempt_id") or "") for attempt in attempts_for_work_item(payload, work_item_id) if attempt.get("attempt_id")]


def latest_attempt_id(payload: dict[str, Any], *, kind: str, work_item_id: str | None = None) -> str:
    for attempt in reversed(canonical_attempt_records(payload)):
        if str(attempt.get("kind") or "") != kind:
            continue
        if work_item_id is not None and str(attempt.get("work_item_id") or "") != work_item_id:
            continue
        attempt_id = str(attempt.get("attempt_id") or "")
        if attempt_id:
            return attempt_id
    return ""


def last_synced_comment_ids(payload: dict[str, Any], work_item_id: str) -> list[str]:
    mappings = payload.get("attempt_comment_projections") if isinstance(payload.get("attempt_comment_projections"), dict) else {}
    return [
        str(item.get("linear_comment_id") or "")
        for item in mappings.values()
        if isinstance(item, dict) and item.get("work_item_id") == work_item_id and item.get("linear_comment_id")
    ]


def operator_wait_kind(item: dict[str, Any]) -> str:
    gate_status = str(item.get("gate_status") or "")
    if gate_status == "human_approval_required":
        return "managed_run_human_approval"
    if gate_status.startswith("checkpoint_failed"):
        return "checkpoint"
    if gate_status:
        return gate_status.split(":", 1)[0]
    return ""


def attempt_comment_body(attempt: dict[str, Any]) -> str:
    events = attempt.get("events") if isinstance(attempt.get("events"), list) else []
    event_summaries = [_event_summary(event) for event in events if isinstance(event, dict)]
    lines = [
        "## Symphony Managed Run Attempt",
        "",
        f"- attempt_id: {summary_text(attempt.get('attempt_id'))}",
        f"- turn_kind: {summary_text(attempt.get('kind') or attempt.get('mode'))}",
        f"- attempt_state: {summary_text(attempt.get('state') or 'running')}",
        f"- backend_thread_id: {summary_text(attempt.get('thread_id')) or 'unavailable'}",
        f"- verify_score: {summary_text(attempt.get('verify_score')) or 'unavailable'}",
        f"- sanitized_error: {summary_text(attempt.get('sanitized_error') or attempt.get('reason')) or 'none'}",
        f"- request_path: `{summary_text(attempt.get('request_path'))}`",
        f"- result_path: `{summary_text(attempt.get('result_path'))}`",
        f"- started_at: {summary_text(attempt.get('started_at'))}",
        f"- completed_at: {summary_text(attempt.get('completed_at')) or 'pending'}",
        "",
        "### Evidence",
    ]
    lines.extend(f"- {summary}" for summary in (event_summaries or ["No event evidence recorded."]))
    return "\n".join(lines)


def _event_summary(event: dict[str, Any]) -> str:
    name = summary_text(event.get("event") or event.get("type") or "event")
    message = summary_text(event.get("message") or event.get("summary") or "")
    return f"{name}: {message}" if message else name


__all__ = [
    "attempt_comment_body",
    "attempt_ids_for_work_item",
    "attempts_for_work_item",
    "checkpoint_evidence",
    "last_synced_comment_ids",
    "latest_attempt_id",
    "linear_state_target",
    "operator_wait_kind",
    "parent_linear_state_target",
    "projection_health_lines",
    "residual_risks",
    "rubric_results",
    "summary_text",
]
