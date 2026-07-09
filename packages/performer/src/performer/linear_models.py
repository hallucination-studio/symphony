from __future__ import annotations

from typing import Any

from performer_api.labels import LABEL_SCHEME
from performer_api.models import BlockerRef, Issue

def format_linear_milestone_comment(
    issue_detail: dict[str, object], *, event_type: str, debug_url: str, verdict=None
) -> str:
    """
    格式化 Linear milestone comment

    Args:
        verdict: 可选的 CompletionVerdict，用于展示验证结果
    """
    latest_run = issue_detail.get("latest_run")
    if not isinstance(latest_run, dict):
        latest_run = {}
    turns = int(latest_run.get("turn_count") or 0)
    tokens = int(latest_run.get("total_tokens") or 0)
    cost = float(latest_run.get("estimated_cost_usd") or 0.0)
    reason = str(issue_detail.get("state_explanation") or "")

    # 基础信息
    lines = [
        f"Performer milestone: {event_type}",
        f"Turns: {turns}",
    ]

    # Token 信息（仅当非 0 时显示）
    if tokens > 0:
        lines.append(f"Tokens: {tokens}")

    # Cost 信息
    if cost > 0:
        lines.append(f"Cost: ${cost:.2f}")
    else:
        lines.append("Cost: N/A")

    lines.append(f"Reason: {reason}")
    lines.append(f"Debug: {debug_url}")

    # 🆕 添加验证结果
    if verdict:
        lines.append("")
        lines.append(f"✅ Completion Verification (verified at {verdict.verified_at}):")

        for check in verdict.checks:
            icon = "✅" if check.passed else "❌"
            lines.append(f"  {icon} {check.check_name}: {check.message}")

        # 添加关键证据
        if "diff_stat" in verdict.evidence:
            stat_lines = verdict.evidence["diff_stat"].split("\n")
            if stat_lines:
                lines.append(f"  - Changes: {stat_lines[0]}")
        if "test_output" in verdict.evidence:
            lines.append(f"  - Tests: {verdict.evidence['test_output']}")
        if "duration_sec" in verdict.evidence:
            lines.append(f"  - Duration: {verdict.evidence['duration_sec']}s")

        lines.append("")
        lines.append("Verified by: Performer Completion Verifier v1.0")

    return "\n".join(lines)


def _normalize_issue(node: dict[str, Any]) -> Issue:
    labels = [label.get("name", "") for label in (((node.get("labels") or {}).get("nodes")) or [])]
    blockers: list[BlockerRef] = []
    for relation in (((node.get("inverseRelations") or {}).get("nodes")) or []):
        blocker = BlockerRef.from_linear_relation(relation)
        if blocker:
            blockers.append(blocker)
    state = node.get("state")
    state_name = state.get("name") if isinstance(state, dict) else state
    project = node.get("project")
    assignee = node.get("assignee")
    delegate = node.get("delegate")
    return Issue(
        id=node.get("id") or "",
        identifier=node.get("identifier") or "",
        title=node.get("title") or "",
        description=node.get("description"),
        priority=node.get("priority"),
        state=state_name or "",
        branch_name=node.get("branchName"),
        url=node.get("url"),
        labels=labels,
        blocked_by=blockers,
        created_at=node.get("createdAt"),
        updated_at=node.get("updatedAt"),
        assignee_id=assignee.get("id") if isinstance(assignee, dict) else None,
        delegate_id=delegate.get("id") if isinstance(delegate, dict) else None,
        project_slug=project.get("slugId") if isinstance(project, dict) else None,
        project_name=project.get("name") if isinstance(project, dict) else None,
    )


def _normalize_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    state = node.get("state")
    state_name = state.get("name") if isinstance(state, dict) else state
    labels = [
        label.get("name", "")
        for label in (((node.get("labels") or {}).get("nodes")) or [])
        if isinstance(label, dict)
    ]
    assignee = node.get("assignee") if isinstance(node.get("assignee"), dict) else None
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    comments = _normalize_comments(
        (((node.get("comments") or {}).get("nodes")) or []) if isinstance(node.get("comments"), dict) else []
    )
    blocked_by: list[dict[str, str | None]] = []
    for relation in (((node.get("inverseRelations") or {}).get("nodes")) or []):
        blocker = BlockerRef.from_linear_relation(relation) if isinstance(relation, dict) else None
        if blocker is None:
            continue
        blocked_by.append({"id": blocker.id, "identifier": blocker.identifier, "state": blocker.state})
    return {
        "id": node.get("id") or "",
        "identifier": node.get("identifier") or "",
        "title": node.get("title") or "",
        "url": node.get("url"),
        "state": state_name or "",
        "labels": labels,
        "description": node.get("description") if isinstance(node.get("description"), str) else None,
        "assignee_id": assignee.get("id") if assignee else None,
        "delegate_id": delegate.get("id") if delegate else None,
        "comments": comments,
        "blocked_by": blocked_by,
    }


def _relation_matches(
    relation: Any,
    *,
    relation_type: str,
    issue_id: str,
    related_issue_id: str,
) -> bool:
    if not isinstance(relation, dict) or relation.get("type") != relation_type:
        return False
    issue = relation.get("issue") if isinstance(relation.get("issue"), dict) else {}
    related_issue = relation.get("relatedIssue") if isinstance(relation.get("relatedIssue"), dict) else {}
    issue_matches_related = issue.get("id") == related_issue_id and related_issue.get("id") == issue_id
    issue_matches_source = issue.get("id") == issue_id and related_issue.get("id") == related_issue_id
    return issue_matches_related or issue_matches_source


def _normalize_comments(nodes: list[Any]) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    for comment in nodes:
        if not isinstance(comment, dict):
            continue
        user = comment.get("user") if isinstance(comment.get("user"), dict) else None
        comments.append(
            {
                "id": comment.get("id"),
                "body": comment.get("body") or "",
                "created_at": comment.get("createdAt"),
                "user": {"id": user.get("id"), "name": user.get("name")} if user else None,
            }
        )
    return comments


def _preserve_managed_run_projection_label(name: str) -> bool:
    lowered = name.lower()
    if not lowered.startswith("performer:"):
        return True
    return lowered in {label.lower() for label in LABEL_SCHEME.types.values()}


def _preserve_non_phase_performer_label(name: str) -> bool:
    return _preserve_managed_run_projection_label(name)


def replace_marker_block(description: str, marker_name: str, block: str) -> str:
    begin = f"<!-- BEGIN {marker_name} -->"
    end = f"<!-- END {marker_name} -->"
    replacement = f"{begin}\n{block.strip()}\n{end}"
    start = description.find(begin)
    stop = description.find(end)
    if start >= 0 and stop >= start:
        stop += len(end)
        return f"{description[:start]}{replacement}{description[stop:]}"
    if description.strip():
        return f"{description.rstrip()}\n\n{replacement}"
    return replacement

__all__ = [name for name in globals() if name.startswith("_") or name in {"format_linear_milestone_comment", "replace_marker_block"}]
