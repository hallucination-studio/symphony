from __future__ import annotations

from typing import Any


def _normalize_linear_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    parent = node.get("parent") if isinstance(node.get("parent"), dict) else None
    state = node.get("state") if isinstance(node.get("state"), dict) else {}
    blocked_by: list[dict[str, str | None]] = []
    direct_relations: list[dict[str, Any]] = []
    inverse_relations = node.get("inverseRelations") if isinstance(node.get("inverseRelations"), dict) else {}
    for relation in inverse_relations.get("nodes") or []:
        if not isinstance(relation, dict) or relation.get("type") != "blocks":
            continue
        issue = relation.get("issue") or relation.get("relatedIssue") or {}
        if not isinstance(issue, dict):
            continue
        blocker_state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
        blocked_by.append(
            {
                "id": issue.get("id"),
                "identifier": issue.get("identifier"),
                "state": blocker_state.get("name") if isinstance(blocker_state, dict) else issue.get("state"),
            }
        )
    relations = node.get("relations") if isinstance(node.get("relations"), dict) else {}
    for relation in relations.get("nodes") or []:
        if isinstance(relation, dict):
            direct_relations.append(relation)
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "description": node.get("description") or "",
        "url": node.get("url"),
        "state": state.get("name") if isinstance(state, dict) else node.get("state"),
        "state_type": state.get("type") if isinstance(state, dict) else None,
        "delegate_id": delegate.get("id") if delegate else None,
        "parent_issue_id": parent.get("id") if parent else None,
        "parent_identifier": parent.get("identifier") if parent else None,
        "blocked_by": blocked_by,
        "relations": direct_relations,
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
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
    return issue.get("id") == issue_id and related_issue.get("id") == related_issue_id


def _replace_marker_block(current: str, marker_name: str, block: str) -> str:
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    replacement = f"{start}\n{block.strip()}\n{end}"
    if start in current and end in current:
        prefix, rest = current.split(start, 1)
        _old, suffix = rest.split(end, 1)
        return f"{prefix.rstrip()}\n\n{replacement}\n\n{suffix.lstrip()}".strip()
    base = current.strip()
    return f"{base}\n\n{replacement}".strip() if base else replacement
