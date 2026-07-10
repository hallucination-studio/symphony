from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from linear_tree_audit import audit_tree
from real_symphony_e2e_linear import fetch_linear_issue_tree


TERMINAL_ATTEMPT_STATES = {"succeeded", "failed", "blocked", "cancelled", "timed_out"}


def audit_managed_run_linear_tree(view: dict[str, Any], tree: dict[str, Any]) -> dict[str, Any]:
    expected_work_item_ids, expected_dependencies = managed_run_projection_expectations(view)
    result = audit_tree(
        tree,
        expected_work_item_ids=expected_work_item_ids,
        expected_dependencies=expected_dependencies,
    )
    managed_run_audit = _managed_run_audit(view, tree)
    failures = [*result["failures"], *managed_run_audit["failures"]]
    return {
        **result,
        "pass": not failures,
        "failures": failures,
        "expected_work_item_ids": expected_work_item_ids,
        "expected_dependencies": expected_dependencies,
        "managed_run_audit": managed_run_audit,
    }


def managed_run_projection_expectations(view: dict[str, Any]) -> tuple[list[str], dict[str, list[str]]]:
    items = [
        item
        for run in view.get("runs") or []
        if isinstance(run, dict)
        for item in run.get("work_items") or []
        if isinstance(item, dict)
    ]
    expected_work_item_ids = [str(item.get("work_item_id") or "") for item in items]
    expected_work_item_ids = [work_item_id for work_item_id in expected_work_item_ids if work_item_id]
    expected_dependencies: dict[str, list[str]] = {}
    for item in items:
        work_item_id = str(item.get("work_item_id") or "")
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        dependencies = [str(dependency) for dependency in payload.get("dependencies") or [] if str(dependency)]
        if work_item_id:
            expected_dependencies[work_item_id] = dependencies
    return expected_work_item_ids, expected_dependencies


def _managed_run_audit(view: dict[str, Any], tree: dict[str, Any]) -> dict[str, Any]:
    runs = _runs_for_parent(view, str(tree.get("id") or ""))
    failures: list[str] = []
    if len(runs) != 1:
        failures.append(f"managed_run_parent_count_mismatch:expected_1:actual_{len(runs)}")
        return {"run_ids": [str(run.get("run_id") or "") for run in runs], "failures": failures}
    run = runs[0]
    children = _work_item_children(tree)
    failures.extend(_state_failures(run, tree, children))
    failures.extend(_dependency_failures(run, children))
    failures.extend(_attempt_failures(run, tree, children))
    return {"run_ids": [str(run.get("run_id") or "")], "failures": failures}


def _runs_for_parent(view: dict[str, Any], parent_issue_id: str) -> list[dict[str, Any]]:
    runs = [run for run in view.get("runs") or [] if isinstance(run, dict)]
    matched = [run for run in runs if str(run.get("parent_issue_id") or "") == parent_issue_id]
    if matched or len(runs) != 1:
        return matched
    return runs


def _work_item_children(tree: dict[str, Any]) -> dict[str, dict[str, Any]]:
    children = tree.get("children") if isinstance(tree.get("children"), dict) else {}
    result: dict[str, dict[str, Any]] = {}
    for child in children.get("nodes") or []:
        if not isinstance(child, dict):
            continue
        work_item_id = _work_item_id(child)
        if work_item_id:
            result[work_item_id] = child
    return result


def _state_failures(run: dict[str, Any], tree: dict[str, Any], children: dict[str, dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    expected_parent = _state_type(str(run.get("state") or ""), parent=True)
    actual_parent = str((tree.get("state") or {}).get("type") or "")
    if expected_parent and actual_parent != expected_parent:
        failures.append(f"parent_state_mismatch:expected_{expected_parent}:actual_{actual_parent or 'missing'}")
    for item in run.get("work_items") or []:
        if not isinstance(item, dict):
            continue
        work_item_id = str(item.get("work_item_id") or "")
        expected = _state_type(str(item.get("state") or ""), parent=False)
        actual = str(((children.get(work_item_id) or {}).get("state") or {}).get("type") or "")
        if work_item_id and expected and actual != expected:
            failures.append(f"work_item_state_mismatch:{work_item_id}:expected_{expected}:actual_{actual or 'missing'}")
    return failures


def _state_type(state: str, *, parent: bool) -> str:
    if not state:
        return ""
    if state in {"verified", "done"}:
        return "completed"
    if state in {"blocked", "failed", "awaiting_approval"}:
        return "unstarted"
    if not parent and state == "cancelled":
        return "canceled"
    if state in {"todo", ""}:
        return "unstarted"
    return "started"


def _dependency_failures(run: dict[str, Any], children: dict[str, dict[str, Any]]) -> list[str]:
    ids_by_issue = {str(child.get("id") or ""): work_item_id for work_item_id, child in children.items()}
    actual = {
        (ids_by_issue.get(str((relation.get("issue") or {}).get("id") or "")), ids_by_issue.get(str((relation.get("relatedIssue") or {}).get("id") or "")))
        for child in children.values()
        for relation in ((child.get("inverseRelations") or {}).get("nodes") or [])
        if isinstance(relation, dict) and relation.get("type") == "blocks"
    }
    actual = {(source, target) for source, target in actual if source and target}
    expected = {
        (str(dependency), str(item.get("work_item_id") or ""))
        for item in run.get("work_items") or []
        if isinstance(item, dict)
        for dependency in ((item.get("payload") or {}).get("dependencies") or [])
        if str(dependency) and str(item.get("work_item_id") or "")
    }
    return [
        *[f"work_item_dependency_projection_missing:{source}->{target}" for source, target in sorted(expected - actual)],
        *[f"work_item_dependency_projection_unexpected:{source}->{target}" for source, target in sorted(actual - expected)],
    ]


def _attempt_failures(run: dict[str, Any], tree: dict[str, Any], children: dict[str, dict[str, Any]]) -> list[str]:
    payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
    integrity = run.get("attempt_integrity") if isinstance(run.get("attempt_integrity"), dict) else {}
    failures = [f"attempt_integrity_error:{error}" for error in integrity.get("errors") or [] if str(error)]
    attempts = [dict(attempt) for attempt in run.get("attempts") or [] if isinstance(attempt, dict)]
    if not attempts:
        attempts = [dict(attempt) for attempt in payload.get("completed_attempts") or [] if isinstance(attempt, dict)]
    mappings = payload.get("attempt_comment_projections") if isinstance(payload.get("attempt_comment_projections"), dict) else {}
    comments = _comments_by_issue(tree, children)
    seen_attempts: set[str] = set()
    seen_comments: set[str] = set()
    for attempt in attempts:
        attempt_id = str(attempt.get("attempt_id") or "")
        if not attempt_id:
            failures.append("attempt_id_missing")
            continue
        if attempt_id in seen_attempts:
            failures.append(f"attempt_id_duplicate:{attempt_id}")
            continue
        seen_attempts.add(attempt_id)
        if str(run.get("state") or "") == "done" and str(attempt.get("state") or "") not in TERMINAL_ATTEMPT_STATES:
            failures.append(f"attempt_nonterminal_after_done:{attempt_id}")
        mapping = mappings.get(attempt_id) if isinstance(mappings.get(attempt_id), dict) else {}
        comment_id = str(mapping.get("linear_comment_id") or "")
        expected_issue = str(tree.get("id") or "") if not str(attempt.get("work_item_id") or "") else str((children.get(str(attempt.get("work_item_id") or "")) or {}).get("id") or "")
        if not comment_id:
            failures.append(f"attempt_comment_mapping_missing:{attempt_id}")
            continue
        if comment_id in seen_comments:
            failures.append(f"attempt_comment_id_duplicate:{comment_id}")
        seen_comments.add(comment_id)
        if str(mapping.get("linear_issue_id") or "") != expected_issue:
            failures.append(f"attempt_comment_issue_mismatch:{attempt_id}")
        body = comments.get(expected_issue, {}).get(comment_id)
        if body is None:
            failures.append(f"attempt_comment_missing:{attempt_id}:{comment_id}")
        elif f"attempt_id: {attempt_id}" not in body:
            failures.append(f"attempt_comment_body_mismatch:{attempt_id}:{comment_id}")
    unexpected = sorted(set(mappings) - seen_attempts)
    failures.extend(f"attempt_comment_mapping_unexpected:{attempt_id}" for attempt_id in unexpected)
    return failures


def _comments_by_issue(tree: dict[str, Any], children: dict[str, dict[str, Any]]) -> dict[str, dict[str, str]]:
    issues = [tree, *children.values()]
    return {
        str(issue.get("id") or ""): {
            str(comment.get("id") or ""): str(comment.get("body") or "")
            for comment in ((issue.get("comments") or {}).get("nodes") or [])
            if isinstance(comment, dict) and comment.get("id")
        }
        for issue in issues
        if str(issue.get("id") or "")
    }


def _work_item_id(issue: dict[str, Any]) -> str:
    for line in str(issue.get("description") or "").splitlines():
        if line.startswith("Managed Run Work Item:"):
            return line.partition(":")[2].strip()
    return ""


async def record_managed_run_linear_tree_audit(
    *,
    token: str,
    issue_id: str,
    root: Path,
    evidence: Any,
    view: dict[str, Any],
) -> dict[str, Any]:
    tree = await fetch_linear_issue_tree(token, issue_id)
    audit = audit_managed_run_linear_tree(view, tree)
    path = root / "final-linear-tree-audit.json"
    path.write_text(json.dumps(audit, indent=2, sort_keys=True), encoding="utf-8")
    evidence.artifact("final_linear_tree_audit", path)
    evidence.check(
        "stage:managed-run-linear-tree-audited",
        bool(audit.get("pass")),
        expected_work_item_ids=audit.get("expected_work_item_ids"),
        expected_dependencies=audit.get("expected_dependencies"),
        work_item_count=audit.get("work_item_count"),
        failures=audit.get("failures"),
    )
    return audit


__all__ = [
    "audit_managed_run_linear_tree",
    "managed_run_projection_expectations",
    "record_managed_run_linear_tree_audit",
]
