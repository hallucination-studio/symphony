from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from linear_tree_audit import audit_tree
from real_symphony_e2e_linear import fetch_linear_issue_tree


def audit_managed_run_linear_tree(view: dict[str, Any], tree: dict[str, Any]) -> dict[str, Any]:
    expected_work_item_ids, expected_dependencies = managed_run_projection_expectations(view)
    result = audit_tree(
        tree,
        expected_work_item_ids=expected_work_item_ids,
        expected_dependencies=expected_dependencies,
    )
    return {
        **result,
        "expected_work_item_ids": expected_work_item_ids,
        "expected_dependencies": expected_dependencies,
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
