from __future__ import annotations

from typing import Any

from performer_api.models import Issue, RunningEntry, normalize_state_key, utc_now

__all__ = [
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

def _acceptance_issue_description(entry: RunningEntry, verdict: Any) -> str:
    return _acceptance_issue_description_for_issue(entry.issue, verdict, acceptance_issue=None, workspace_path=entry.workspace_path)

def _acceptance_issue_description_for_issue(
    issue: Issue,
    verdict: Any,
    acceptance_issue: dict[str, Any] | None,
    workspace_path: str | None = None,
) -> str:
    _ = acceptance_issue
    return "\n".join(
        [
            f"Original issue: {issue.identifier}",
            f"Original issue ID: {issue.id}",
            f"Workspace: {workspace_path or '<workspace path unavailable>'}",
            f"Completion verdict: {getattr(verdict, 'status', 'unknown')}",
            f"Completion reason: {getattr(verdict, 'reason', 'unknown')}",
            "",
            "Review the implementation evidence and produce a score from 0 to 4.",
        ]
    )

def _acceptance_marker_block(issue: Issue, acceptance_issue: dict[str, Any], acceptance: Any) -> str:
    return "\n".join(
        [
            f"acceptance_issue_id: {acceptance_issue.get('id', '')}",
            f"acceptance_issue_identifier: {acceptance_issue.get('identifier', '')}",
            f"acceptance_issue_url: {acceptance_issue.get('url', '')}",
            f"plan_revision: {acceptance.plan_revision}",
            "",
            "Execution plan:",
            f"- Implement the Linear task described by {issue.identifier}.",
            "- Run focused verification and capture exact output.",
            "- Report implementation summary, test evidence, and remaining risks.",
            "",
            "Acceptance requirements:",
            "- The original issue requirements are satisfied.",
            "- The implementation is maintainable and scoped.",
            "- Verification evidence is concrete enough for independent review.",
            "",
            "Evidence required:",
            "- Implementation summary.",
            "- Test commands and exact output.",
            "- Remaining risks or explicit none.",
        ]
    )

def _gate_plan_marker_block(issue: Issue, gates: list[dict[str, Any]], acceptance: Any) -> str:
    lines = [
        f"plan_revision: {acceptance.plan_revision}",
        f"gate_count: {len(gates)}",
        "",
        "Gate plan:",
    ]
    for index, gate in enumerate(gates, start=1):
        lines.append(f"- Gate {index}: {gate.get('identifier', gate.get('id', ''))} {gate.get('title', '')}".rstrip())
    lines.extend(
        [
            "",
            "Implementation boundary:",
            f"- Implement only the business issue described by {issue.identifier}.",
            "- Do not move the Linear issue to In Review or Done.",
            "- Performer will run each gate and close the tree after acceptance.",
            "",
            "Evidence required:",
            "- Implementation summary.",
            "- Test commands and exact output.",
            "- Remaining risks or explicit none.",
        ]
    )
    return "\n".join(lines)

def _gate_issue_description(issue: Issue, gate: GatePlan, *, index: int) -> str:
    lines = [
        f"Business issue: {issue.identifier}",
        f"Gate index: {index}",
        "",
        "Purpose:",
        gate.purpose,
        "",
        "Acceptance criteria:",
    ]
    for criterion in gate.acceptance_criteria:
        lines.append(f"- {criterion}")
    lines.extend(["", "Required evidence:"])
    for evidence in gate.required_evidence:
        lines.append(f"- {evidence}")
    return "\n".join(lines)

def _evidence_issue_description(
    issue: Issue,
    gate: dict[str, Any],
    report: AcceptanceReport,
    raw_report: str,
    workspace_path: str | None,
) -> str:
    lines = [
        f"Business issue: {issue.identifier}",
        f"Gate: {gate.get('identifier', gate.get('id', ''))}",
        f"Workspace: {workspace_path or '<workspace path unavailable>'}",
        "",
        "Reviewer conclusion:",
        f"- Score: {report.score}",
        f"- Result: {report.result}",
        f"- Accepted: {report.accepted}",
        f"- Reason: {report.score_reason}",
        "",
        "Evidence citations:",
    ]
    for citation in report.evidence_citations:
        lines.append(f"- {citation}")
    if report.residual_findings:
        lines.extend(["", "Residual findings:"])
        for finding in report.residual_findings:
            lines.append(f"- {finding}")
    if report.rejection_reasons:
        lines.extend(["", "Gate rejection reasons:"])
        for reason in report.rejection_reasons:
            lines.append(f"- {reason}")
    lines.extend(["", "Raw reviewer JSON:", raw_report.strip()])
    return "\n".join(lines)

def _gate_plan_needs_more_info_comment(issue: Issue, questions: list[str]) -> str:
    lines = [
        "Performer needs more information before planning acceptance gates.",
        "",
        f"Business issue: {issue.identifier}",
        "",
        "Questions:",
    ]
    for question in questions:
        lines.append(f"- {question}")
    return "\n".join(lines)

def _gate_plan_rejected_comment(issue: Issue, reasons: list[str]) -> str:
    lines = [
        "Performer could not validate the acceptance gate plan.",
        "",
        f"Business issue: {issue.identifier}",
        "",
        "Planner rejection reasons:",
    ]
    for reason in reasons:
        lines.append(f"- {reason}")
    return "\n".join(lines)

def _entry_for_issue(issue: Issue, workspace_path: str | None) -> RunningEntry:
    return RunningEntry(
        issue=issue,
        task=None,
        started_at=utc_now(),
        retry_attempt=0,
        workspace_path=workspace_path,
    )

def _has_acceptance_evidence(issue: Issue) -> bool:
    text = _strip_marker_block(issue.description or "", "PERFORMER ACCEPTANCE").lower()
    evidence_fields = {
        "implementation": ("implementation summary:", "implemented:", "changed:"),
        "tests": (
            "test commands and exact output:",
            "test command:",
            "test commands:",
            "test output:",
        ),
        "risks": ("remaining risks:", "residual risk:", "risks:"),
    }
    return all(_has_nonempty_evidence_field(text, prefixes) for prefixes in evidence_fields.values())

def _has_nonempty_evidence_field(text: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        start = text.find(prefix)
        if start < 0:
            continue
        value = text[start + len(prefix):].strip()
        if not value:
            continue
        first_line = value.splitlines()[0].strip(" -*\t")
        if _is_placeholder_evidence_value(first_line):
            continue
        return True
    return False

def _is_placeholder_evidence_value(value: str) -> bool:
    normalized = value.strip().rstrip(".:").lower()
    if not normalized:
        return True
    placeholder_prefixes = (
        "must include",
        "required",
        "todo",
        "tbd",
        "none provided",
        "no description",
    )
    return any(normalized.startswith(prefix) for prefix in placeholder_prefixes)

def _strip_marker_block(description: str, marker_name: str) -> str:
    begin = f"<!-- BEGIN {marker_name} -->"
    end = f"<!-- END {marker_name} -->"
    remaining = description
    while begin in remaining and end in remaining:
        prefix, after_begin = remaining.split(begin, 1)
        if end not in after_begin:
            break
        _, suffix = after_begin.split(end, 1)
        remaining = (prefix + suffix).strip()
    return remaining

def _has_passed_acceptance_gate(issue: Issue, acceptance: Any) -> bool:
    labels = {str(label).strip().lower() for label in issue.labels}
    return (
        acceptance.gate_passed_label.strip().lower() in labels
        or acceptance.gate_pass_with_findings_label.strip().lower() in labels
    )

def _issue_dict_has_label(issue: dict[str, Any], label_name: str) -> bool:
    labels = issue.get("labels")
    if not isinstance(labels, list):
        labels = issue.get("label_ids")
    if not isinstance(labels, list):
        return False
    wanted = label_name.strip().lower()
    return wanted in {str(label).strip().lower() for label in labels}

def _policy_violation_comment_body(issue: Issue, *, has_evidence: bool) -> str:
    if has_evidence:
        next_action = "Evidence was present, so Performer is pulling the issue back to In Review and running acceptance."
    else:
        next_action = "Evidence was missing, so Performer is pulling the issue back to In Progress for rework."
    return "\n".join(
        [
            "Policy violation: direct Done bypass before acceptance gate passed.",
            "",
            f"Original issue: {issue.identifier}",
            next_action,
            "",
            "Required evidence before Done: implementation summary, test commands and exact output, and remaining risks.",
        ]
    )

def _acceptance_report_comment_body(entry: RunningEntry, report: AcceptanceReport) -> str:
    lines = [
        f"Acceptance score: {report.score}",
        f"Result: {report.result}",
        "",
        f"Reason: {report.score_reason}",
        "",
        "Evidence citations:",
    ]
    for citation in report.evidence_citations:
        lines.append(f"- {citation}")
    if report.residual_findings:
        lines.extend(["", "Residual findings:"])
        for finding in report.residual_findings:
            lines.append(f"- {finding}")
    if report.rejection_reasons:
        lines.extend(["", "Gate rejection reasons:"])
        for reason in report.rejection_reasons:
            lines.append(f"- {reason}")
    lines.extend(
        [
            "",
            f"Recommended next action: {report.recommended_next_action}",
            f"Original issue: {entry.issue.identifier}",
        ]
    )
    return "\n".join(lines)

def _handoff_preserved_comment_body(entry: RunningEntry, refreshed_issue: Issue) -> str:
    evidence_path = entry.workspace_path or "<workspace path unavailable>"
    lines = [
        "Performer stopped automation for human review.",
        "",
        f"Tracker state: {refreshed_issue.state}",
        "Handoff type: non-active, non-terminal",
        f"Workspace preserved for review: {evidence_path}",
    ]
    if entry.session_id:
        lines.append(f"Codex session: {entry.session_id}")
    if entry.last_codex_message:
        lines.append(f"Last observed message: {entry.last_codex_message}")
    lines.append("Required next action: inspect the preserved workspace and validation evidence before closing this issue.")
    return "\n".join(lines)
