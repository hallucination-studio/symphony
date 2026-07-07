from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from linear_project_issues import graphql


PIPELINE_NODE_LABEL = "performer:type/pipeline-node"


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
    pipeline_nodes = [child for child in children if PIPELINE_NODE_LABEL in labels(child)]
    blocks_relations = [
        relation
        for child in pipeline_nodes
        for relation in child.get("inverseRelations", {}).get("nodes", [])
        if relation.get("type") == "blocks"
    ]
    failures: list[str] = []
    for node in pipeline_nodes:
        if (node.get("parent") or {}).get("id") != tree.get("id"):
            failures.append(f"pipeline_node_parent_mismatch:{node.get('identifier')}")
        metadata = _pipeline_metadata(node)
        missing = [
            key
            for key in [
                "graph_id",
                "node_id",
                "plan_attempt_id",
                "gate_snapshot_hash",
                "conductor_revision",
                "operator_status",
            ]
            if not metadata.get(key)
        ]
        if missing:
            failures.append(f"pipeline_metadata_missing:{node.get('identifier')}:{','.join(missing)}")
        if metadata.get("operator_status") == "waiting_for_runtime_input":
            description = str(node.get("description") or "")
            if not metadata.get("operator_wait_kind"):
                failures.append(f"pipeline_runtime_wait_kind_missing:{node.get('identifier')}")
            if "Runtime Wait" not in description or "runtime_wait:" not in description:
                failures.append(f"pipeline_runtime_wait_block_missing:{node.get('identifier')}")
        if "Frozen Gate" not in str(node.get("description") or ""):
            failures.append(f"frozen_gate_missing:{node.get('identifier')}")
    return {
        "business_issue": _issue_row(tree),
        "pipeline_node_count": len(pipeline_nodes),
        "blocks_relation_count": len(blocks_relations),
        "pipeline_nodes": [
            {
                **_issue_row(node),
                "metadata": _pipeline_metadata(node),
                "children": [_issue_row(child) for child in node.get("children", {}).get("nodes", [])],
            }
            for node in pipeline_nodes
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


def _pipeline_metadata(issue: dict[str, Any]) -> dict[str, str]:
    description = str(issue.get("description") or "")
    result: dict[str, str] = {}
    in_symphony = False
    for line in description.splitlines():
        stripped = line.strip()
        if stripped == "symphony:":
            in_symphony = True
            continue
        if in_symphony and stripped.startswith("```"):
            break
        if not in_symphony or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
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
    arg_parser = argparse.ArgumentParser(description="Audit a Linear projection of a Symphony pipeline graph.")
    arg_parser.add_argument("issue", help="Linear issue id or identifier accepted by Linear's issue(id:) field.")
    arg_parser.add_argument(
        "--mode",
        choices=["audit", "summary"],
        default="audit",
        help="Use audit for pipeline projection checks or summary to export parent/child/blocks relationships.",
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
