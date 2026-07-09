from __future__ import annotations

from typing import Any

from real_symphony_e2e_linear_core import linear_graphql

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
