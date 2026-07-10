from __future__ import annotations

from typing import Any

from performer_api.config import TrackerConfig
from performer_api.models import Issue

from .linear_errors import LinearError
from .linear_models import _normalize_comments, _normalize_issue, replace_marker_block
from .linear_queries import (
    COMMENT_CREATE_MUTATION,
    COMMENT_UPDATE_MUTATION,
    ISSUE_COMMENTS_QUERY,
    ISSUE_DESCRIPTION_QUERY,
    ISSUE_STATES_QUERY,
    ISSUE_TEAM_STATES_QUERY,
    ISSUE_UPDATE_DESCRIPTION_MUTATION,
    ISSUE_UPDATE_STATE_MUTATION,
)


class LinearCommentMixin:
    async def fetch_issue_states_by_ids(self, config: TrackerConfig, issue_ids: list[str]) -> list[Issue]:
        if not issue_ids:
            return []
        payload = await self.graphql(ISSUE_STATES_QUERY, {"ids": issue_ids, "projectSlug": config.project_slug})
        nodes = (((payload.get("data") or {}).get("issues") or {}).get("nodes") or [])
        return [_normalize_issue(node) for node in nodes]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        payload = await self.graphql(COMMENT_CREATE_MUTATION, {"issueId": issue_id, "body": body})
        result = ((payload.get("data") or {}).get("commentCreate") or {})
        comment = result.get("comment") if isinstance(result, dict) else {}
        return {"success": bool(result.get("success")), "comment_id": comment.get("id") if isinstance(comment, dict) else None}

    async def update_issue_comment_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        comments = await self.fetch_issue_comments(issue_id, first=50)
        begin = f"<!-- BEGIN {marker_name} -->"
        existing = next((comment for comment in comments if begin in str(comment.get("body") or "")), None)
        body = replace_marker_block(str((existing or {}).get("body") or ""), marker_name, block)
        if existing and existing.get("id"):
            return await self._update_existing_comment(str(existing["id"]), body, fallback_id=str(existing["id"]))
        created = await self.comment_issue(issue_id, body)
        created["body"] = body
        return created

    async def _update_existing_comment(self, comment_id: str, body: str, *, fallback_id: str) -> dict[str, Any]:
        payload = await self.graphql(COMMENT_UPDATE_MUTATION, {"commentId": comment_id, "body": body})
        result = ((payload.get("data") or {}).get("commentUpdate") or {})
        comment = result.get("comment") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "comment_id": comment.get("id") if isinstance(comment, dict) else fallback_id,
            "body": body,
        }

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 20) -> list[dict[str, Any]]:
        payload = await self.graphql(ISSUE_COMMENTS_QUERY, {"issueId": issue_id, "first": first})
        nodes = ((((payload.get("data") or {}).get("issue") or {}).get("comments") or {}).get("nodes") or [])
        return _normalize_comments(nodes)

    async def transition_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_UPDATE_STATE_MUTATION, {"issueId": issue_id, "stateId": state_id})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        state = issue.get("state") if isinstance(issue, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": issue.get("id") if isinstance(issue, dict) else None,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "state": state.get("name") if isinstance(state, dict) else None,
        }

    async def resolve_state_id_by_name(self, issue_id: str, state_name: str) -> str:
        payload = await self.graphql(ISSUE_TEAM_STATES_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) else {}
        states = (((team.get("states") or {}).get("nodes")) or []) if isinstance(team, dict) else []
        wanted = state_name.strip().lower()
        for state in states:
            if isinstance(state, dict) and str(state.get("name") or "").strip().lower() == wanted and state.get("id"):
                return str(state["id"])
        raise LinearError("linear_state_not_found", f"Linear state not found for issue {issue_id}: {state_name}")

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]:
        state_id = await self.resolve_state_id_by_name(issue_id, state_name)
        return await self.transition_issue(issue_id, state_id)

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_DESCRIPTION_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        current = issue.get("description") if isinstance(issue, dict) else None
        updated = replace_marker_block(str(current or ""), marker_name, block)
        payload = await self.graphql(ISSUE_UPDATE_DESCRIPTION_MUTATION, {"issueId": issue_id, "description": updated})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        updated_issue = result.get("issue") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": updated_issue.get("id") if isinstance(updated_issue, dict) else None,
            "identifier": updated_issue.get("identifier") if isinstance(updated_issue, dict) else None,
            "description": updated,
        }
