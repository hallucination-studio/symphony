from __future__ import annotations

import asyncio
import time
from typing import Any

from real_symphony_e2e_linear_core import linear_graphql

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
