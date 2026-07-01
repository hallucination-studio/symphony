from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import httpx


ENDPOINT = "https://api.linear.app/graphql"


async def graphql(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    token = os.environ.get("LINEAR_API_KEY", "").strip()
    if not token:
        raise RuntimeError("LINEAR_API_KEY is required")
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        response = await client.post(
            ENDPOINT,
            json={"query": query, "variables": variables},
            headers={"Authorization": token, "Content-Type": "application/json"},
        )
    payload = response.json()
    if response.status_code != 200 or payload.get("errors"):
        raise RuntimeError(json.dumps({"status": response.status_code, "payload": payload}, indent=2))
    return payload["data"]


async def project_by_name(name: str) -> dict[str, Any]:
    data = await graphql(
        """
        query ProjectByName($name: String!) {
          projects(first: 50, filter: { name: { eq: $name } }) {
            nodes { id name slugId teams { nodes { id key name } } }
          }
        }
        """,
        {"name": name},
    )
    projects = data["projects"]["nodes"]
    if not projects:
        raise RuntimeError(f"Project not found: {name}")
    return projects[0]


async def fetch_unarchived_issue_page(project_slug: str, after: str | None) -> dict[str, Any]:
    return await graphql(
        """
        query ProjectIssues($projectSlug: String!, $after: String) {
          issues(
            first: 100
            after: $after
            includeArchived: false
            filter: { project: { slugId: { eq: $projectSlug } } }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              identifier
              title
              url
              state { name type }
              labels { nodes { name } }
              parent { id identifier }
            }
          }
        }
        """,
        {"projectSlug": project_slug, "after": after},
    )


async def fetch_all_unarchived(project_slug: str) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    after = None
    while True:
        data = await fetch_unarchived_issue_page(project_slug, after)
        page = data["issues"]
        issues.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return issues
        after = page["pageInfo"]["endCursor"]


async def archive_issue(issue_id: str) -> dict[str, Any]:
    data = await graphql(
        """
        mutation ArchiveIssue($id: String!) {
          issueArchive(id: $id) {
            success
            entity { id }
          }
        }
        """,
        {"id": issue_id},
    )
    return data["issueArchive"]


def _labels(issue: dict[str, Any]) -> list[str]:
    return [label["name"] for label in issue["labels"]["nodes"]]


def _matches_filters(issue: dict[str, Any], *, label_prefix: str | None, include_completed: bool) -> bool:
    if label_prefix and not any(label.startswith(label_prefix) for label in _labels(issue)):
        return False
    if not include_completed and issue["state"]["type"] in {"completed", "canceled"}:
        return False
    return True


async def run(args: argparse.Namespace) -> dict[str, Any]:
    project = await project_by_name(args.project)
    before_all = await fetch_all_unarchived(project["slugId"])
    before = [
        issue
        for issue in before_all
        if _matches_filters(issue, label_prefix=args.label_prefix, include_completed=args.include_completed)
    ]
    archived: list[str] = []
    if args.action == "archive":
        for issue in before:
            result = await archive_issue(issue["id"])
            if not result.get("success"):
                raise RuntimeError(f"archive failed for {issue['identifier']}: {result}")
            archived.append(issue["identifier"])
    after_all = await fetch_all_unarchived(project["slugId"])
    after = [
        issue
        for issue in after_all
        if _matches_filters(issue, label_prefix=args.label_prefix, include_completed=args.include_completed)
    ]
    evidence = {
        "action": args.action,
        "project": {"id": project["id"], "name": project["name"], "slugId": project["slugId"]},
        "team": project["teams"]["nodes"][0] if project["teams"]["nodes"] else None,
        "filters": {
            "label_prefix": args.label_prefix,
            "include_completed": args.include_completed,
        },
        "before_count": len(before),
        "before_identifiers": [issue["identifier"] for issue in before],
        "archived_identifiers": archived,
        "after_count": len(after),
        "after_identifiers": [issue["identifier"] for issue in after],
        "after_issues": [
            {
                "identifier": issue["identifier"],
                "title": issue["title"],
                "state": issue["state"]["name"],
                "state_type": issue["state"]["type"],
                "labels": _labels(issue),
                "parent": issue.get("parent"),
                "url": issue["url"],
            }
            for issue in after
        ],
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True), encoding="utf-8")
    return evidence


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Audit or archive unarchived Linear issues for a project.")
    arg_parser.add_argument("action", choices=["audit", "archive"])
    arg_parser.add_argument("--project", default="HELL", help="Linear project name. Default: HELL")
    arg_parser.add_argument("--label-prefix", help="Only include issues with a label starting with this prefix.")
    arg_parser.add_argument(
        "--include-completed",
        action="store_true",
        help="Include completed/canceled issues in the selected set. By default only active unarchived issues are selected.",
    )
    arg_parser.add_argument("--out", type=Path, help="Write JSON evidence to this path.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    evidence = asyncio.run(run(args))
    print(json.dumps(evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
