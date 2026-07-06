from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from performer_api.models import (
    HUMAN_INTERVENTION_LABELS,
    Issue,
    RunningEntry,
    RuntimeTokens,
    normalize_state_key,
    utc_now,
)
from .orchestrator_codex_events import (
    command_from_event,
    event_can_signal_human_block,
    exit_code_from_event,
    human_blocked_runtime_reason,
    log_message,
    status_message_from_event,
)
from .completion_verifier import CompletionVerdict
from .orchestrator_acceptance_helpers import *

HUMAN_RESPONSE_MARKER_NAME = "SYMPHONY HUMAN RESPONSE"

__all__ = [
    "HUMAN_RESPONSE_MARKER_NAME",
    "_log_message",
    "_retry_delay_seconds",
    "_is_codex_init_error_code",
    "_status_message_from_event",
    "_is_low_value_message",
    "_command_from_event",
    "_exit_code_from_event",
    "_failure_comment_body",
    "_runtime_error_comment_body",
    "_human_blocked_runtime_reason",
    "_human_intervention_title",
    "_human_intervention_description",
    "_redact_human_text",
    "_human_action_instruction",
    "_find_human_child",
    "_human_response_from_child",
    "_human_intervention_requires_response",
    "_human_resume_error",
    "_event_can_signal_human_block",
    "_completion_verdict_comment_body",
    "_description_with_structured_result",
    "_structured_result_evidence_block",
    "_structured_result_from_issue_description",
    "_structured_result_needs_human",
    "_structured_result_summary",
    "_structured_result_questions",
    "_extract_evidence_section",
    "_structured_result_comment_body",
    "_structured_list",
    "_completion_verification_error_comment_body",
    "_acceptance_issue_description",
    "_acceptance_issue_description_for_issue",
    "_acceptance_marker_block",
    "_gate_plan_marker_block",
    "_gate_issue_description",
    "_evidence_issue_description",
    "_gate_plan_needs_more_info_comment",
    "_gate_plan_rejected_comment",
    "_entry_for_issue",
    "_has_acceptance_evidence",
    "_has_nonempty_evidence_field",
    "_is_placeholder_evidence_value",
    "_strip_marker_block",
    "_has_passed_acceptance_gate",
    "_issue_dict_has_label",
    "_policy_violation_comment_body",
    "_acceptance_report_comment_body",
    "_handoff_preserved_comment_body",
    "_issue_with_verification_context",
    "_issue_with_retry_context",
    "_retry_context_from_issue",
    "_format_check_evidence",
    "_acceptance_issue_description",
    "_acceptance_issue_description_for_issue",
    "_acceptance_marker_block",
    "_gate_plan_marker_block",
    "_gate_issue_description",
    "_evidence_issue_description",
    "_gate_plan_needs_more_info_comment",
    "_gate_plan_rejected_comment",
    "_entry_for_issue",
    "_has_acceptance_evidence",
    "_has_nonempty_evidence_field",
    "_is_placeholder_evidence_value",
    "_strip_marker_block",
    "_has_passed_acceptance_gate",
    "_issue_dict_has_label",
    "_policy_violation_comment_body",
    "_acceptance_report_comment_body",
    "_handoff_preserved_comment_body",
]

def _log_message(value: Any) -> str:
    return log_message(value)

def _retry_delay_seconds(entry: Any) -> int:
    due_at = getattr(entry, "due_at", None)
    if not isinstance(due_at, datetime):
        return 0
    remaining = (due_at - datetime.now(timezone.utc)).total_seconds()
    if remaining <= 0:
        return 0
    return max(math.ceil(remaining), 5)

def _is_codex_init_error_code(code: str | None) -> bool:
    return code in {
        "codex_init_failed",
        "codex_sdk_not_installed",
        "invalid_sdk_codex_bin",
        "invalid_workspace_cwd",
        "sdk_missing_thread_start",
        "sdk_missing_thread_resume",
        "unsupported_sdk_worker_host",
    }

def _status_message_from_event(event: dict[str, Any]) -> str | None:
    return status_message_from_event(event)

def _is_low_value_message(message: str) -> bool:
    from .orchestrator_codex_events import is_low_value_message

    return is_low_value_message(message)

def _command_from_event(event: dict[str, Any]) -> str | None:
    return command_from_event(event)

def _exit_code_from_event(event: dict[str, Any]) -> int | None:
    return exit_code_from_event(event)

def _failure_comment_body(entry: RunningEntry, error: str, next_attempt: int) -> str:
    event_type = "stalled" if error == "stalled" else "retry_backoff"
    reason = (
        "Stalled because no Codex output arrived before the stall timeout."
        if error == "stalled"
        else f"Retrying because {error}. Next retry attempt: {next_attempt}."
    )
    detail = {
        "issue_identifier": entry.issue.identifier,
        "latest_run": {
            "turn_count": entry.turn_count,
            "total_tokens": entry.tokens.total_tokens,
            "estimated_cost_usd": 0.0,
        },
        "state_explanation": reason,
    }
    lines = [
        format_linear_milestone_comment(
            detail,
            event_type=event_type,
            debug_url=entry.issue.url or f"linear://issue/{entry.issue.identifier}",
        ),
        "",
        f"Failure: {error}",
        f"Next retry attempt: {next_attempt}",
    ]
    if entry.session_id:
        lines.append(f"Codex session: {entry.session_id}")
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    return "\n".join(lines)

def _runtime_error_comment_body(entry: RunningEntry, event: dict[str, Any]) -> str:
    event_name = str(event.get("event") or "unknown")
    raw_method = str(event.get("raw_method") or event.get("method") or "-")
    message = entry.last_codex_message or entry.last_raw_codex_message or event_name
    lines = [
        "Performer runtime error.",
        "",
        f"Issue: {entry.issue.identifier}",
        f"Phase: {entry.phase}",
        f"Event: {event_name}",
        f"Raw method: {raw_method}",
        f"Message: {message}",
    ]
    command = _command_from_event(event)
    if command:
        lines.append(f"Command: {command}")
    exit_code = _exit_code_from_event(event)
    if exit_code is not None:
        lines.append(f"Exit code: {exit_code}")
    lines.append("")
    if entry.human_blocked_reason:
        lines.extend(
            [
                "This run is paused because the runtime error requires human approval or environment changes.",
                f"Blocked reason: {entry.human_blocked_reason}",
                "A [Human Action] child issue will be created. Complete that child issue and move it to Done to resume.",
            ]
        )
    else:
        lines.append(
            "The run has not been marked terminal failed yet. Performer will continue, retry, or post a final failure if recovery does not succeed."
        )
    return "\n".join(lines)

def _human_blocked_runtime_reason(entry: RunningEntry, event: dict[str, Any]) -> str | None:
    return human_blocked_runtime_reason(entry, event)

def _human_intervention_title(issue: Issue, kind: str) -> str:
    suffix = {
        "preflight_needs_input": "Need more information",
        "codex_needs_input": "Codex requested input",
        "runtime_permission": "Runtime approval required",
        "runtime_error": "Runtime error needs review",
        "verification_needs_human": "Verification needs review",
    }.get(kind, "Human action required")
    return f"[Human Action] {issue.identifier}: {suffix}"

def _human_intervention_description(
    issue: Issue,
    *,
    kind: str,
    error: str | None,
    questions: list[str],
    last_message: str | None,
    http_status: int | None = None,
) -> str:
    reason = {
        "preflight_needs_input": "Performer cannot plan acceptance gates because required information is missing.",
        "codex_needs_input": "Codex requested human input before it can continue.",
        "runtime_permission": "The runtime hit a permission or sandbox boundary that needs human approval or an environment fix.",
        "runtime_error": "The worker hit an execution failure that needs human review before retrying.",
        "verification_needs_human": "Completion verification needs human judgment before Performer can continue.",
    }.get(kind, "Performer needs a human decision before continuing.")
    lines = [
        reason,
        "",
        f"Parent issue: {issue.identifier}",
    ]
    if http_status is not None:
        lines.extend(["", f"Upstream HTTP status: {http_status}"])
    safe_error = _redact_human_text(error)
    safe_last_message = _redact_human_text(last_message)
    if safe_error:
        lines.extend(["", "Last error:", safe_error])
    if safe_last_message and safe_last_message != safe_error:
        lines.extend(["", "Last observed message:", safe_last_message])
    if questions:
        lines.append("")
        lines.append("Questions:")
        lines.extend(f"- {question}" for question in questions)
    lines.extend(
        [
            "",
            "Human action:",
            _human_action_instruction(kind),
            "",
            "Human response:",
            "",
            "(Add the answer or decision here when information is required.)",
            "",
            "When finished, move this child issue to Done. Performer only resumes from this child issue being Done.",
        ]
    )
    return "\n".join(lines)

def _redact_human_text(value: str | None) -> str | None:
    if value is None:
        return None
    redacted = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value)
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(api[_-]?key|token|secret)(\s*[=:]\s*)[^\s,;]+", r"\1\2[REDACTED]", redacted)
    return redacted

def _human_action_instruction(kind: str) -> str:
    if kind in {"preflight_needs_input", "codex_needs_input"}:
        return "Answer the questions above in the Human response section."
    if kind == "runtime_permission":
        return "Approve the runtime action or fix the environment so the next attempt can proceed."
    if kind == "verification_needs_human":
        return "Review the verifier concern and state the decision or correction in Human response if needed."
    return "Review the failure and make any needed repository, environment, or issue updates before retry."

def _find_human_child(
    intervention: HumanInterventionEntry,
    children: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for child in children:
        if not isinstance(child, dict):
            continue
        if str(child.get("id") or "") == intervention.child_issue_id:
            return child
    return None

def _human_response_from_child(child: dict[str, Any]) -> str | None:
    description = str(child.get("description") or "")
    marker = "Human response:"
    if marker.lower() not in description.lower():
        return None
    lower = description.lower()
    start = lower.find(marker.lower())
    response = description[start + len(marker):]
    stop_markers = ["When finished,", "完成后", "Move this child issue"]
    for stop in stop_markers:
        index = response.lower().find(stop.lower())
        if index >= 0:
            response = response[:index]
    cleaned = response.strip()
    if not cleaned or cleaned == "(Add the answer or decision here when information is required.)":
        return None
    return cleaned

def _human_intervention_requires_response(intervention: HumanInterventionEntry) -> bool:
    return intervention.kind in {"preflight_needs_input", "codex_needs_input"}

def _human_resume_error(intervention: HumanInterventionEntry, response: str | None) -> str:
    if response:
        return f"human_action_resolved: {intervention.kind}: {response[:500]}"
    if intervention.error:
        return f"human_action_resolved: {intervention.kind}: {intervention.error}"
    return f"human_action_resolved: {intervention.kind}"

def _event_can_signal_human_block(event: dict[str, Any]) -> bool:
    return event_can_signal_human_block(event)

def _completion_verdict_comment_body(entry: RunningEntry, verdict: Any, *, next_action: str) -> str:
    action_line = (
        "Required next action: fix the verifier failures and retry."
        if next_action == "retry"
        else "Required next action: human review is required before closing this issue."
    )
    lines = [
        "Verification failed after agent claimed success.",
        "",
        f"Verdict: {verdict.status}",
        f"Reason: {verdict.reason}",
        "",
        "Observed evidence:",
    ]
    for check in getattr(verdict, "checks", []):
        icon = "PASS" if check.passed else "FAIL"
        lines.append(f"- [{icon}] {check.check_name}: {check.message}")
        evidence = _format_check_evidence(getattr(check, "evidence", None))
        if evidence:
            lines.append(f"  Evidence: {evidence}")
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    lines.extend(["", action_line])
    return "\n".join(lines)

def _description_with_structured_result(existing: str, result: dict[str, Any]) -> str:
    block = _structured_result_evidence_block(result)
    marker = "<!-- PERFORMER IMPLEMENTATION EVIDENCE -->"
    if marker in existing:
        return existing.split(marker, 1)[0].rstrip() + "\n\n" + marker + "\n" + block
    prefix = existing.rstrip()
    return f"{prefix}\n\n{marker}\n{block}".strip()

def _structured_result_evidence_block(result: dict[str, Any]) -> str:
    return "\n".join(
        [
            "Implementation summary:",
            str(result.get("summary") or "").strip() or "No summary provided.",
            "",
            "Test commands and exact output:",
            _structured_list(result.get("test_commands")),
            "",
            "Remaining risks:",
            _structured_list(result.get("remaining_risks")) or "None.",
            "",
            "Changed files:",
            _structured_list(result.get("changed_files")) or "None reported.",
        ]
    )

def _structured_result_from_issue_description(description: str) -> dict[str, Any] | None:
    summary = _extract_evidence_section(description, "Implementation summary:")
    tests = _extract_evidence_section(description, "Test commands and exact output:")
    risks = _extract_evidence_section(description, "Remaining risks:")
    if not any((summary, tests, risks)):
        return None
    return {
        "summary": summary or "",
        "test_commands": [tests] if tests else [],
        "remaining_risks": [risks] if risks else [],
    }

def _structured_result_needs_human(result: dict[str, Any]) -> bool:
    next_action = str(result.get("next_action") or "").strip().lower()
    if next_action == "needs_human":
        return True
    if next_action == "blocked":
        combined = " ".join(
            str(value or "")
            for value in (
                result.get("summary"),
                result.get("questions"),
                result.get("remaining_risks"),
            )
        ).lower()
        return any(token in combined for token in ("need", "missing", "question", "clarify", "human", "input"))
    return False

def _structured_result_summary(result: dict[str, Any]) -> str:
    summary = result.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    return "Codex requested human input"

def _structured_result_questions(result: dict[str, Any]) -> list[str]:
    questions = result.get("questions")
    if isinstance(questions, list):
        return [str(question).strip() for question in questions if str(question).strip()]
    if isinstance(questions, str) and questions.strip():
        return [questions.strip()]
    risks = result.get("remaining_risks")
    if isinstance(risks, list):
        return [str(risk).strip() for risk in risks if str(risk).strip()]
    return []

def _extract_evidence_section(description: str, heading: str) -> str:
    start = description.lower().find(heading.lower())
    if start < 0:
        return ""
    body_start = start + len(heading)
    next_positions = [
        position
        for marker in ("Implementation summary:", "Test commands and exact output:", "Remaining risks:", "Changed files:")
        if marker.lower() != heading.lower()
        for position in [description.lower().find(marker.lower(), body_start)]
        if position >= 0
    ]
    body_end = min(next_positions) if next_positions else len(description)
    return description[body_start:body_end].strip()

def _structured_result_comment_body(entry: RunningEntry, result: dict[str, Any]) -> str:
    lines = [
        "Performer implementation handoff.",
        "",
        f"Issue: {entry.issue.identifier}",
        "",
        "Implementation summary:",
        str(result.get("summary") or "").strip() or "No summary provided.",
        "",
        "Test commands and exact output:",
        _structured_list(result.get("test_commands")),
        "",
        "Changed files:",
        _structured_list(result.get("changed_files")) or "None reported.",
        "",
        "Remaining risks:",
        _structured_list(result.get("remaining_risks")) or "None.",
        "",
        f"Next action: {result.get('next_action') or 'unknown'}",
    ]
    return "\n".join(lines)

def _structured_list(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    items = [str(item).strip() for item in value if str(item).strip()]
    return "\n".join(f"- {item}" for item in items)

def _completion_verification_error_comment_body(entry: RunningEntry, error: str) -> str:
    lines = [
        "Verification failed after agent claimed success.",
        "",
        "Failure class: verifier_error",
        f"Observed evidence: {error}",
        "",
        "Required next action: fix the verifier failure, then retry the issue.",
    ]
    if entry.last_codex_message:
        lines.extend(["", f"Last observed message: {entry.last_codex_message}"])
    return "\n".join(lines)

def _issue_with_verification_context(issue: Issue, verdict: Any) -> Issue:
    evidence_lines = [f"- {check.check_name}: {check.message}" for check in getattr(verdict, "checks", []) if not check.passed]
    if not evidence_lines:
        evidence_lines = [f"- {verdict.reason}"]
    context = "Previous attempt failed verification:\n" + "\n".join(evidence_lines)
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker in description:
        description = description.split(marker, 1)[0].rstrip()
    merged = f"{context}\n\n{description}".strip() if description else context
    return Issue(
        id=issue.id,
        identifier=issue.identifier,
        title=issue.title,
        state=issue.state,
        description=merged,
        priority=issue.priority,
        branch_name=issue.branch_name,
        url=issue.url,
        labels=list(issue.labels),
        blocked_by=list(issue.blocked_by),
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        assignee_id=issue.assignee_id,
        delegate_id=issue.delegate_id,
        project_slug=issue.project_slug,
        project_name=issue.project_name,
    )

def _issue_with_retry_context(issue: Issue, retry: RetryEntry) -> Issue:
    retry_context = retry.last_message or retry.error
    if not retry_context:
        return issue
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker not in retry_context:
        return issue
    if marker in description:
        description = description.split(marker, 1)[0].rstrip()
    merged = f"{retry_context}\n\n{description}".strip() if description else retry_context
    return Issue(
        id=issue.id,
        identifier=issue.identifier,
        title=issue.title,
        state=issue.state,
        description=merged,
        priority=issue.priority,
        branch_name=issue.branch_name,
        url=issue.url,
        labels=list(issue.labels),
        blocked_by=list(issue.blocked_by),
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        assignee_id=issue.assignee_id,
        delegate_id=issue.delegate_id,
        project_slug=issue.project_slug,
        project_name=issue.project_name,
    )

def _retry_context_from_issue(issue: Issue) -> str | None:
    description = issue.description or ""
    marker = "Previous attempt failed verification:"
    if marker not in description:
        return None
    return marker + description.split(marker, 1)[1]

def _format_check_evidence(evidence: Any) -> str | None:
    if not isinstance(evidence, dict) or not evidence:
        return None
    parts: list[str] = []
    for key, value in evidence.items():
        if isinstance(value, list):
            rendered_items = []
            for item in value[:5]:
                if isinstance(item, dict):
                    identity = item.get("identifier") or item.get("id") or "unknown"
                    state = item.get("state")
                    rendered_items.append(f"{identity} ({state})" if state else str(identity))
                else:
                    rendered_items.append(str(item))
            rendered = ", ".join(rendered_items)
            if len(value) > 5:
                rendered += ", ..."
        elif isinstance(value, dict):
            rendered = ", ".join(f"{nested_key}={nested_value}" for nested_key, nested_value in list(value.items())[:5])
        else:
            rendered = str(value)
        if rendered:
            parts.append(f"{key}={rendered}")
    return "; ".join(parts)[:1000] if parts else None

