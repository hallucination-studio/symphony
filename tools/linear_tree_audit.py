from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from linear_project_issues import graphql


GATE_LABEL = "performer:type/gate"
EVIDENCE_LABEL = "performer:type/evidence"


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


def has_label(node: dict[str, Any], label: str) -> bool:
    return label in labels(node)


def audit_tree(tree: dict[str, Any]) -> dict[str, Any]:
    children = tree.get("children", {}).get("nodes", [])
    gates = [child for child in children if has_label(child, GATE_LABEL)]
    evidence = [
        grandchild
        for gate in gates
        for grandchild in gate.get("children", {}).get("nodes", [])
        if has_label(grandchild, EVIDENCE_LABEL)
    ]
    gate_ids = {gate["id"] for gate in gates}
    acceptance_siblings = [child for child in children if str(child.get("title", "")).startswith("[Acceptance]")]
    blocks_relations = [
        relation for relation in tree.get("inverseRelations", {}).get("nodes", []) if relation.get("type") == "blocks"
    ]
    failures: list[str] = []
    for gate in gates:
        if (gate.get("parent") or {}).get("id") != tree.get("id"):
            failures.append(f"gate_parent_mismatch:{gate.get('identifier')}")
    for item in evidence:
        if (item.get("parent") or {}).get("id") not in gate_ids:
            failures.append(f"evidence_parent_mismatch:{item.get('identifier')}")
    if acceptance_siblings:
        failures.append("acceptance_sibling_present")
    if blocks_relations:
        failures.append("blocks_relation_present")
    return {
        "business_issue": _issue_row(tree),
        "gate_count": len(gates),
        "evidence_count": len(evidence),
        "acceptance_sibling_count": len(acceptance_siblings),
        "blocks_relation_count": len(blocks_relations),
        "gates": [
            {
                **_issue_row(gate),
                "children": [_issue_row(child) for child in gate.get("children", {}).get("nodes", [])],
            }
            for gate in gates
        ],
        "evidence": [_issue_row(item) for item in evidence],
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
    arg_parser = argparse.ArgumentParser(description="Audit a Linear business issue gate/evidence tree.")
    arg_parser.add_argument("issue", help="Linear issue id or identifier accepted by Linear's issue(id:) field.")
    arg_parser.add_argument(
        "--mode",
        choices=["audit", "summary"],
        default="audit",
        help="Use audit for gate/evidence checks or summary to export parent/child/blocks relationships.",
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
