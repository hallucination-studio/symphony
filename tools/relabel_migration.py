from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import httpx


ENDPOINT = "https://api.linear.app/graphql"

LEGACY_PREFIXES = (
    "performer:lifecycle/",
    "performer:dispatch/",
    "performer:retry/",
    "performer:error/",
    "performer:human/",
)

LEGACY_ROOT_LABELS = {
    "performer:queued",
    "performer:starting",
    "performer:running",
    "performer:continuing",
    "performer:retrying",
    "performer:error",
    "performer:failed",
    "performer:done",
    "performer:type/task",
    "performer:type/acceptance",
    "performer:phase/planned",
}

PHASE_MAP = {
    "performer:queued": "performer:phase/queued",
    "performer:starting": "performer:phase/implementation",
    "performer:running": "performer:phase/implementation",
    "performer:continuing": "performer:phase/implementation",
    "performer:retrying": "performer:phase/implementation",
    "performer:error": "performer:phase/failed",
    "performer:failed": "performer:phase/failed",
    "performer:done": "performer:phase/done",
    "performer:phase/planned": "performer:phase/queued",
    "performer:lifecycle/queued": "performer:phase/queued",
    "performer:lifecycle/starting": "performer:phase/implementation",
    "performer:lifecycle/running": "performer:phase/implementation",
    "performer:lifecycle/continuing": "performer:phase/implementation",
    "performer:lifecycle/retrying": "performer:phase/implementation",
    "performer:lifecycle/error": "performer:phase/failed",
    "performer:lifecycle/failed": "performer:phase/failed",
    "performer:lifecycle/done": "performer:phase/done",
    "performer:dispatch/failed": "performer:phase/failed",
    "performer:retry/exhausted": "performer:phase/failed",
    "performer:error/human-blocked": "performer:phase/blocked",
    "performer:human/pending": "performer:phase/blocked",
}

PHASE_PRECEDENCE = [
    "performer:phase/blocked",
    "performer:phase/failed",
    "performer:phase/done",
    "performer:phase/rework",
    "performer:phase/review",
    "performer:phase/implementation",
    "performer:phase/queued",
]


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


async def fetch_issue_page(project_slug: str, after: str | None) -> dict[str, Any]:
    return await graphql(
        """
        query RelabelIssues($projectSlug: String!, $after: String) {
          issues(
            first: 100
            after: $after
            includeArchived: false
            filter: {
              project: { slugId: { eq: $projectSlug } }
              state: { type: { nin: ["completed", "canceled"] } }
            }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              identifier
              title
              url
              team { id }
              state { name type }
              labels { nodes { id name } }
            }
          }
        }
        """,
        {"projectSlug": project_slug, "after": after},
    )


async def fetch_active_issues(project_slug: str) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    after = None
    while True:
        data = await fetch_issue_page(project_slug, after)
        page = data["issues"]
        issues.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return issues
        after = page["pageInfo"]["endCursor"]


async def ensure_label(team_id: str, name: str) -> str:
    data = await graphql(
        """
        query LabelByName($teamId: ID!, $name: String!) {
          issueLabels(first: 20, filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
            nodes { id name }
          }
        }
        """,
        {"teamId": team_id, "name": name},
    )
    nodes = data["issueLabels"]["nodes"]
    if nodes:
        return nodes[0]["id"]
    data = await graphql(
        """
        mutation CreateLabel($teamId: String!, $name: String!) {
          issueLabelCreate(input: { teamId: $teamId, name: $name }) {
            success
            issueLabel { id name }
          }
        }
        """,
        {"teamId": team_id, "name": name},
    )
    result = data["issueLabelCreate"]
    if not result.get("success"):
        raise RuntimeError(f"Could not create label {name}")
    return result["issueLabel"]["id"]


async def update_issue_labels(issue_id: str, label_ids: list[str]) -> None:
    data = await graphql(
        """
        mutation UpdateIssueLabels($issueId: String!, $labelIds: [String!]) {
          issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
            success
            issue { id identifier }
          }
        }
        """,
        {"issueId": issue_id, "labelIds": label_ids},
    )
    if not data["issueUpdate"].get("success"):
        raise RuntimeError(f"issueUpdate failed for {issue_id}")


def _target_phase(labels: list[str]) -> str | None:
    mapped = {PHASE_MAP[label] for label in labels if label in PHASE_MAP}
    mapped.update(label for label in labels if label.startswith("performer:phase/") and label != "performer:phase/planned")
    for phase in PHASE_PRECEDENCE:
        if phase in mapped:
            return phase
    return None


def _is_legacy(label: str) -> bool:
    return label in LEGACY_ROOT_LABELS or label in PHASE_MAP or label.startswith(LEGACY_PREFIXES)


async def relabel_issue(issue: dict[str, Any], *, apply: bool) -> dict[str, Any]:
    labels = issue["labels"]["nodes"]
    names = [label["name"] for label in labels]
    target_phase = _target_phase(names)
    kept = [label for label in labels if not _is_legacy(label["name"]) and not label["name"].startswith("performer:phase/")]
    target_id = None
    if target_phase:
        target_id = await ensure_label(issue["team"]["id"], target_phase)
    label_ids = [label["id"] for label in kept]
    if target_id and target_id not in label_ids:
        label_ids.append(target_id)
    current_ids = [label["id"] for label in labels]
    changed = label_ids != current_ids
    if apply and changed:
        await update_issue_labels(issue["id"], label_ids)
    return {
        "identifier": issue["identifier"],
        "url": issue["url"],
        "changed": changed,
        "before": names,
        "after": [label["name"] for label in kept] + ([target_phase] if target_phase else []),
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    issues = await fetch_active_issues(args.project_slug)
    results = [await relabel_issue(issue, apply=args.apply) for issue in issues]
    changed = [result for result in results if result["changed"]]
    evidence = {
        "project_slug": args.project_slug,
        "apply": args.apply,
        "active_issue_count": len(issues),
        "changed_count": len(changed),
        "changed": changed,
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True), encoding="utf-8")
    return evidence


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Migrate active Linear issues to the compact Performer label scheme.")
    arg_parser.add_argument("--project-slug", required=True, help="Linear project slugId to migrate.")
    arg_parser.add_argument("--apply", action="store_true", help="Apply label changes. Default is dry-run.")
    arg_parser.add_argument("--out", type=Path, help="Write JSON evidence to this path.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    print(json.dumps(asyncio.run(run(args)), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
