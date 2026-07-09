from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from linear_project_issues import graphql


WORK_ITEM_LABEL = "symphony:type/work-item"


async def fetch_issue_tree(issue_id: str) -> dict[str, Any]:
    data = await graphql(
        """
        query IssueTree($issueId: String!) {
          issue(id: $issueId) {
            id
            identifier
            title
            url
            description
            state { name type }
            labels { nodes { name } }
            parent { id identifier }
            children(first: 100) {
              nodes {
                id
                identifier
                title
                url
                description
                parent { id identifier }
                state { name type }
                labels { nodes { name } }
                inverseRelations {
                  nodes {
                    id
                    type
                    issue { id identifier title }
                    relatedIssue { id identifier title }
                  }
                }
                children(first: 100) {
                  nodes {
                    id
                    identifier
                    title
                    url
                    description
                    parent { id identifier }
                    state { name type }
                    labels { nodes { name } }
                  }
                }
              }
            }
            inverseRelations {
              nodes {
                id
                type
                issue { id identifier title }
                relatedIssue { id identifier title }
              }
            }
          }
        }
        """,
        {"issueId": issue_id},
    )
    issue = data["issue"]
    if issue is None:
        raise RuntimeError(f"Issue not found: {issue_id}")
    return issue


def labels(node: dict[str, Any]) -> list[str]:
    return [label["name"] for label in node.get("labels", {}).get("nodes", [])]


def audit_tree(tree: dict[str, Any]) -> dict[str, Any]:
    children = tree.get("children", {}).get("nodes", [])
    work_items = [child for child in children if is_work_item_child(child)]
    blocks_relations = [
        relation
        for child in work_items
        for relation in child.get("inverseRelations", {}).get("nodes", [])
        if relation.get("type") == "blocks"
    ]
    failures: list[str] = []
    if "<!-- symphony:run-summary:start -->" not in str(tree.get("description") or ""):
        failures.append(f"managed_run_summary_missing:{tree.get('identifier')}")
    for item in work_items:
        identifier = item.get("identifier")
        if (item.get("parent") or {}).get("id") != tree.get("id"):
            failures.append(f"work_item_parent_mismatch:{identifier}")
        description = str(item.get("description") or "")
        for heading, code in [
            ("Objective:", "work_item_objective_missing"),
            ("Acceptance Criteria:", "work_item_acceptance_missing"),
            ("Likely Files:", "work_item_files_missing"),
            ("Verification:", "work_item_verification_missing"),
            ("Managed Run State:", "work_item_state_missing"),
        ]:
            if heading not in description:
                failures.append(f"{code}:{identifier}")
        state = _managed_run_state(description)
        if not state.get("state"):
            failures.append(f"work_item_state_value_missing:{identifier}")
        if not state.get("gate"):
            failures.append(f"work_item_gate_missing:{identifier}")
        if str((item.get("state") or {}).get("type") or "").lower() == "completed" and state.get("state") != "done":
            failures.append(f"work_item_done_state_mismatch:{identifier}:{state.get('state')}")
    return {
        "business_issue": _issue_row(tree),
        "work_item_count": len(work_items),
        "blocks_relation_count": len(blocks_relations),
        "work_items": [
            {
                **_issue_row(item),
                "managed_run_state": _managed_run_state(str(item.get("description") or "")),
                "children": [_issue_row(child) for child in item.get("children", {}).get("nodes", [])],
            }
            for item in work_items
        ],
        "blocks_relations": blocks_relations,
        "failures": failures,
        "pass": not failures,
    }


def summarize_tree(tree: dict[str, Any]) -> dict[str, Any]:
    children = tree.get("children", {}).get("nodes", [])
    return {
        "business_issue": _issue_row(tree),
        "children": [_issue_with_relations(child) for child in children],
        "blocks_relations": _blocks_relations(tree, scope="business")
        + [
            relation
            for child in children
            for relation in _blocks_relations(child, scope="child")
        ],
        "raw": tree,
    }


def is_work_item_child(issue: dict[str, Any]) -> bool:
    if WORK_ITEM_LABEL in labels(issue):
        return True
    description = str(issue.get("description") or "")
    required_headings = ["Objective:", "Acceptance Criteria:", "Verification:", "Managed Run State:"]
    return all(heading in description for heading in required_headings)


def _issue_with_relations(issue: dict[str, Any]) -> dict[str, Any]:
    return {
        **_issue_row(issue),
        "blocks_relations": _blocks_relations(issue, scope="issue"),
        "children": [_issue_row(child) for child in issue.get("children", {}).get("nodes", [])],
    }


def _blocks_relations(issue: dict[str, Any], *, scope: str) -> list[dict[str, Any]]:
    return [
        {
            "id": relation.get("id"),
            "type": relation.get("type"),
            "issue": relation.get("issue"),
            "relatedIssue": relation.get("relatedIssue"),
            "scope": scope,
        }
        for relation in issue.get("inverseRelations", {}).get("nodes", [])
        if relation.get("type") == "blocks"
    ]


def _managed_run_state(description: str) -> dict[str, str]:
    result: dict[str, str] = {}
    in_state = False
    for line in description.splitlines():
        stripped = line.strip()
        if stripped == "Managed Run State:":
            in_state = True
            continue
        if in_state and not stripped:
            break
        if not in_state or not stripped.startswith("- ") or ":" not in stripped:
            continue
        key, value = stripped[2:].split(":", 1)
        result[key.strip()] = value.strip()
    return result


def _issue_row(issue: dict[str, Any]) -> dict[str, Any]:
    state = issue.get("state") or {}
    return {
        "id": issue.get("id"),
        "identifier": issue.get("identifier"),
        "title": issue.get("title"),
        "url": issue.get("url"),
        "state": state.get("name"),
        "state_type": state.get("type"),
        "labels": labels(issue),
        "parent": issue.get("parent"),
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    tree = await fetch_issue_tree(args.issue)
    result = summarize_tree(tree) if args.mode == "summary" else audit_tree(tree)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    return result


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Audit a Linear projection of a Symphony Managed Run.")
    arg_parser.add_argument("issue", help="Linear issue id or identifier accepted by Linear's issue(id:) field.")
    arg_parser.add_argument(
        "--mode",
        choices=["audit", "summary"],
        default="audit",
        help="Use audit for Managed Run projection checks or summary to export parent/child/blocks relationships.",
    )
    arg_parser.add_argument("--out", type=Path, help="Write JSON evidence to this path.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    result = asyncio.run(run(args))
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.mode == "audit" and not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
