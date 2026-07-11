from __future__ import annotations

from typing import Any

from .conductor_linear_direct_helpers import _replace_marker_block


class ManagedRunCommentMixin:
    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ManagedRunDescription($issueId: String!) {
  issue(id: $issueId) { id identifier description }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        current = str(issue.get("description") or "") if isinstance(issue, dict) else ""
        description = _replace_marker_block(current, marker_name, block)
        payload = await self.graphql(
            """
mutation ManagedRunUpdateDescription($issueId: String!, $description: String!) {
  issueUpdate(id: $issueId, input: { description: $description }) {
    success
    issue { id identifier description }
  }
}
""",
            {"issueId": issue_id, "description": description},
        )
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        return {"success": bool(result.get("success")), "issue_id": issue_id, "description": description}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ManagedRunComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
""",
            {"issueId": issue_id, "body": body},
        )
        result = ((payload.get("data") or {}).get("commentCreate") or {})
        comment = result.get("comment") if isinstance(result, dict) else {}
        return {"success": bool(result.get("success")), "comment_id": comment.get("id") if isinstance(comment, dict) else None}

    async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ManagedRunCommentUpdate($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) {
    success
    comment { id body }
  }
}
""",
            {"commentId": comment_id, "body": body},
        )
        result = ((payload.get("data") or {}).get("commentUpdate") or {})
        comment = result.get("comment") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "comment_id": comment.get("id") if isinstance(comment, dict) else comment_id,
            "body": body,
        }

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 50) -> list[dict[str, Any]]:
        payload = await self.graphql(
            """
query ManagedRunComments($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    comments(first: $first) {
      nodes { id body createdAt user { id name } }
    }
  }
}
""",
            {"issueId": issue_id, "first": first},
        )
        nodes = ((((payload.get("data") or {}).get("issue") or {}).get("comments") or {}).get("nodes") or [])
        comments: list[dict[str, Any]] = []
        for node in nodes:
            if not isinstance(node, dict):
                continue
            user = node.get("user") if isinstance(node.get("user"), dict) else None
            comments.append(
                {
                    "id": node.get("id"),
                    "body": node.get("body") or "",
                    "created_at": node.get("createdAt"),
                    "user": {"id": user.get("id"), "name": user.get("name")} if user else None,
                }
            )
        return comments

    async def update_issue_comment_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        comments = await self.fetch_issue_comments(issue_id, first=50)
        start = f"<!-- {marker_name}:START -->"
        existing = next((comment for comment in comments if start in str(comment.get("body") or "")), None)
        body = _replace_marker_block(str((existing or {}).get("body") or ""), marker_name, block)
        if existing and existing.get("id"):
            payload = await self.graphql(
                """
mutation ManagedRunCommentUpdate($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) {
    success
    comment { id body }
  }
}
""",
                {"commentId": str(existing["id"]), "body": body},
            )
            result = ((payload.get("data") or {}).get("commentUpdate") or {})
            comment = result.get("comment") if isinstance(result, dict) else {}
            return {
                "success": bool(result.get("success")),
                "comment_id": comment.get("id") if isinstance(comment, dict) else existing["id"],
                "body": body,
            }
        created = await self.comment_issue(issue_id, body)
        created["body"] = body
        return created
