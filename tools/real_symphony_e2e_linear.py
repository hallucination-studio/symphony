from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx

from real_symphony_e2e_common import LINEAR_ENDPOINT

async def linear_graphql(token: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    last_error: Exception | None = None
    max_attempts = 8
    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=45, trust_env=False) as client:
                response = await client.post(
                    LINEAR_ENDPOINT,
                    json={"query": query, "variables": variables},
                    headers={"Authorization": token, "Content-Type": "application/json"},
                )
            try:
                payload = response.json()
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    json.dumps(
                        {"status": response.status_code, "body": response.text[:500]},
                        indent=2,
                    )
                ) from exc
            if response.status_code != 200 or payload.get("errors"):
                raise RuntimeError(json.dumps({"status": response.status_code, "payload": payload}, indent=2))
            return payload["data"]
        except (httpx.HTTPError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt == max_attempts:
                break
            await asyncio.sleep(min(2 ** (attempt - 1), 20))
    raise RuntimeError(f"Linear GraphQL request failed after retries: {last_error!r}") from last_error


async def fetch_linear_viewer(token: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query Viewer {
              viewer { id name email }
            }
            """,
            {},
        )
    )["viewer"]


async def create_linear_issue(
    token: str,
    project_slug: str,
    run_id: str,
    *,
    delegate_id: str | None = None,
    parent_id: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    project = await resolve_project(token, project_slug)
    teams = project.get("teams", {}).get("nodes") or []
    if not teams:
        raise RuntimeError(f"Linear project has no teams: {project_slug}")
    team = teams[0]
    states = (
        await linear_graphql(
            token,
            """
            query States($teamId: ID!) {
              workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type }
              }
            }
            """,
            {"teamId": team["id"]},
        )
    )["workflowStates"]["nodes"]
    todo = next((state for state in states if state["name"].lower() == "todo"), None)
    if todo is None:
        todo = next(state for state in states if state["type"] == "unstarted")
    issue = (
        await linear_graphql(
            token,
            """
            mutation CreateIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  description
                  url
                  state { name type }
                  assignee { id name }
                  delegate { id name }
                  parent { id identifier }
                  agentSessions(first: 5) { nodes { id status appUser { id name } } }
                  labels { nodes { name } }
                }
              }
            }
            """,
            {
                "input": {
                    "teamId": team["id"],
                    "projectId": project["id"],
                    "stateId": todo["id"],
                    "title": title or f"Symphony managed agent dispatch {run_id}",
                    "description": description or (
                        "Real Symphony e2e task. Create SYMPHONY_REAL_E2E_RESULT.md at the workspace root, "
                        "include this Linear issue identifier, say Podium, Conductor, and Performer reached Codex, "
                        "and run pytest tests/test_smoke.py -q."
                    ),
                    **({"delegateId": delegate_id} if delegate_id else {}),
                    **({"parentId": parent_id} if parent_id else {}),
                }
            },
        )
    )["issueCreate"]["issue"]
    return {"project": project, "team": team, "todo_state": todo, "issue": issue}


async def resolve_project(token: str, project: str) -> dict[str, Any]:
    by_slug = (
        await linear_graphql(
            token,
            """
            query ProjectBySlug($project: String!) {
              projects(first: 5, filter: { slugId: { eq: $project } }) {
                nodes { id name slugId teams { nodes { id key name } } }
              }
            }
            """,
            {"project": project},
        )
    )["projects"]["nodes"]
    if by_slug:
        return by_slug[0]
    by_name = (
        await linear_graphql(
            token,
            """
            query ProjectByName($project: String!) {
              projects(first: 5, filter: { name: { eq: $project } }) {
                nodes { id name slugId teams { nodes { id key name } } }
              }
            }
            """,
            {"project": project},
        )
    )["projects"]["nodes"]
    if by_name:
        return by_name[0]
    raise RuntimeError(f"Linear project not found by slugId or name: {project}")


async def create_linear_blocks_relation(token: str, blocker_id: str, blocked_id: str) -> dict[str, Any]:
    result = (
        await linear_graphql(
            token,
            """
            mutation CreateBlocksRelation($input: IssueRelationCreateInput!) {
              issueRelationCreate(input: $input) {
                success
                issueRelation {
                  id
                  type
                  issue { id identifier title }
                  relatedIssue { id identifier title }
                }
              }
            }
            """,
            {
                "input": {
                    "issueId": blocker_id,
                    "relatedIssueId": blocked_id,
                    "type": "blocks",
                }
            },
        )
    )["issueRelationCreate"]
    if not result.get("success"):
        raise RuntimeError("Linear issueRelationCreate returned success=false")
    return result["issueRelation"]


async def fetch_linear_issue(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query Issue($id: String!) {
              issue(id: $id) {
                id
                identifier
                title
                description
                url
                state { name type }
                assignee { id name }
                delegate { id name }
                parent { id identifier }
                agentSessions(first: 5) { nodes { id status appUser { id name } } }
                labels { nodes { name } }
                comments(first: 20) { nodes { body createdAt } }
              }
            }
            """,
            {"id": issue_id},
        )
    )["issue"]


async def delegate_linear_issue(token: str, issue_id: str, delegate_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation DelegateIssue($issueId: String!, $delegateId: String!) {
              issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
                success
                issue {
                  id
                  identifier
                  title
                  description
                  delegate { id name }
                  agentSessions(first: 5) { nodes { id status appUser { id name } } }
                }
              }
            }
            """,
            {"issueId": issue_id, "delegateId": delegate_id},
        )
    )["issueUpdate"]["issue"]


async def wait_for_linear_delegate_visible(
    token: str,
    issue_id: str,
    delegate_id: str,
    *,
    timeout_seconds: float = 20,
    poll_seconds: float = 0.5,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_issue: dict[str, Any] | None = None
    while True:
        last_issue = await fetch_linear_issue(token, issue_id)
        if ((last_issue.get("delegate") or {}).get("id")) == delegate_id:
            return last_issue
        if time.monotonic() >= deadline:
            return last_issue
        await asyncio.sleep(poll_seconds)


async def comment_linear_issue(token: str, issue_id: str, body: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation CommentIssue($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) {
                success
                comment { id }
              }
            }
            """,
            {"issueId": issue_id, "body": body},
        )
    )["commentCreate"]


async def fetch_linear_human_action_issue(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query HumanActionIssue($issueId: String!) {
              issue(id: $issueId) {
                id
                identifier
                description
                state { name type }
                team {
                  states(first: 50) {
                    nodes { id name type }
                  }
                }
              }
            }
            """,
            {"issueId": issue_id},
        )
    )["issue"]


async def update_linear_issue_description(token: str, issue_id: str, description: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation UpdateHumanActionDescription($issueId: String!, $description: String!) {
              issueUpdate(id: $issueId, input: { description: $description }) {
                success
                issue { id identifier }
              }
            }
            """,
            {"issueId": issue_id, "description": description},
        )
    )["issueUpdate"]


async def move_linear_issue_to_state(token: str, issue_id: str, state_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            mutation MoveHumanActionIssue($issueId: String!, $stateId: String!) {
              issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                success
                issue { id identifier state { name type } }
              }
            }
            """,
            {"issueId": issue_id, "stateId": state_id},
        )
    )["issueUpdate"]


async def fetch_linear_issue_tree(token: str, issue_id: str) -> dict[str, Any]:
    return (
        await linear_graphql(
            token,
            """
            query IssueTree($id: String!) {
              issue(id: $id) {
                id
                identifier
                title
                description
                url
                state { name type }
                assignee { id name }
                delegate { id name }
                agentSessions(first: 5) { nodes { id status appUser { id name } } }
                labels { nodes { name } }
                children(first: 50) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    state { name type }
                    delegate { id name }
                    labels { nodes { name } }
                    comments(first: 20) { nodes { body createdAt } }
                    children(first: 50) {
                      nodes {
                        id
                        identifier
                        title
                        description
                        state { name type }
                        delegate { id name }
                        labels { nodes { name } }
                        comments(first: 20) { nodes { body createdAt } }
                      }
                    }
                  }
                }
                comments(first: 20) { nodes { body createdAt } }
              }
            }
            """,
            {"id": issue_id},
        )
    )["issue"]
