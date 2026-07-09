from __future__ import annotations

from typing import Any

from .linear_errors import LinearError
from .linear_models import _normalize_comments, _normalize_issue_dict
from .linear_queries import (
    ISSUE_CHILDREN_QUERY,
    ISSUE_CREATE_MUTATION,
    ISSUE_CREATION_CONTEXT_QUERY,
    ISSUE_UPDATE_DELEGATE_MUTATION,
)


class LinearIssueMixin:
    async def create_issue(
        self,
        *,
        team_id: str,
        project_id: str,
        state_id: str,
        label_ids: list[str],
        title: str,
        description: str,
        parent_id: str | None = None,
        assignee_id: str | None = None,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            ISSUE_CREATE_MUTATION,
            {
                "teamId": team_id,
                "projectId": project_id,
                "stateId": state_id,
                "labelIds": label_ids,
                "title": title,
                "description": description,
                "parentId": parent_id,
                "assigneeId": assignee_id,
                "delegateId": delegate_id,
            },
        )
        result = ((payload.get("data") or {}).get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearError("linear_issue_create_failed", "Linear issueCreate returned success=false")
        current_delegate = issue.get("delegate") if isinstance(issue.get("delegate"), dict) else None
        if delegate_id and (current_delegate or {}).get("id") != delegate_id:
            issue = await self.update_issue_delegate(str(issue["id"]), delegate_id)
        return issue

    async def update_issue_delegate(self, issue_id: str, delegate_id: str) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_UPDATE_DELEGATE_MUTATION, {"issueId": issue_id, "delegateId": delegate_id})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearError("linear_issue_delegate_update_failed", "Linear issueUpdate delegate returned success=false")
        return issue

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        children_by_id: dict[str, dict[str, Any]] = {}
        children_after: str | None = None
        while True:
            payload = await self.graphql(
                ISSUE_CHILDREN_QUERY,
                {"issueId": parent_issue_id, "childrenAfter": children_after, "commentsAfter": None},
            )
            connection = self._children_connection(payload)
            for node in connection.get("nodes") or []:
                if isinstance(node, dict):
                    child = await self._child_with_all_comments(parent_issue_id, children_after, node)
                    child_id = str(child.get("id") or "")
                    if child_id:
                        children_by_id[child_id] = child
            page_info = connection.get("pageInfo") if isinstance(connection, dict) else {}
            if not isinstance(page_info, dict) or not page_info.get("hasNextPage"):
                break
            children_after = page_info.get("endCursor") if isinstance(page_info.get("endCursor"), str) else None
            if not children_after:
                break
        return _filter_children_by_label(list(children_by_id.values()), label_name)

    def _children_connection(self, payload: dict[str, Any]) -> dict[str, Any]:
        issue = ((payload.get("data") or {}).get("issue") or {})
        connection = (issue.get("children") or {}) if isinstance(issue, dict) else {}
        return connection if isinstance(connection, dict) else {}

    async def _child_with_all_comments(
        self,
        parent_issue_id: str,
        children_after: str | None,
        node: dict[str, Any],
    ) -> dict[str, Any]:
        child = _normalize_issue_dict(node)
        comments_connection = node.get("comments") if isinstance(node.get("comments"), dict) else {}
        comments = list(child.get("comments") or [])
        comments_page = comments_connection.get("pageInfo") if isinstance(comments_connection, dict) else {}
        comments_after = comments_page.get("endCursor") if isinstance(comments_page, dict) else None
        while isinstance(comments_page, dict) and comments_page.get("hasNextPage") and comments_after:
            page_node = await self._fetch_child_comment_page(parent_issue_id, children_after, comments_after, child)
            if page_node is None:
                break
            page_comments = page_node.get("comments") if isinstance(page_node.get("comments"), dict) else {}
            comments.extend(_normalize_comments((page_comments.get("nodes") or []) if isinstance(page_comments, dict) else []))
            comments_page = page_comments.get("pageInfo") if isinstance(page_comments, dict) else {}
            comments_after = comments_page.get("endCursor") if isinstance(comments_page, dict) else None
        child["comments"] = comments
        return child

    async def _fetch_child_comment_page(
        self,
        parent_issue_id: str,
        children_after: str | None,
        comments_after: str,
        child: dict[str, Any],
    ) -> dict[str, Any] | None:
        page_payload = await self.graphql(
            ISSUE_CHILDREN_QUERY,
            {"issueId": parent_issue_id, "childrenAfter": children_after, "commentsAfter": comments_after},
        )
        page_children = self._children_connection(page_payload).get("nodes") or []
        return next((item for item in page_children if isinstance(item, dict) and str(item.get("id") or "") == child.get("id")), None)

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
        assignee_id: str | None = None,
    ) -> dict[str, Any]:
        context = await self._fetch_issue_creation_context(parent_issue_id)
        labels = [await self._ensure_issue_label(context["team_id"], label_name) for label_name in label_names]
        return await self.create_issue(
            team_id=context["team_id"],
            project_id=context["project_id"],
            state_id=context["state_id"],
            label_ids=[label["id"] for label in labels],
            title=title,
            description=description,
            parent_id=parent_issue_id,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def _fetch_issue_creation_context(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_CREATION_CONTEXT_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) else {}
        project = issue.get("project") if isinstance(issue, dict) else {}
        state = issue.get("state") if isinstance(issue, dict) else {}
        team_id = team.get("id") if isinstance(team, dict) else None
        project_id = project.get("id") if isinstance(project, dict) else None
        state_id = state.get("id") if isinstance(state, dict) else None
        if not isinstance(team_id, str) or not team_id:
            raise LinearError("linear_missing_issue_team", "Linear issue.team.id missing")
        if not isinstance(project_id, str) or not project_id:
            raise LinearError("linear_missing_issue_project", "Linear issue.project.id missing")
        if not isinstance(state_id, str) or not state_id:
            raise LinearError("linear_missing_issue_state", "Linear issue.state.id missing")
        return {"issue_id": issue.get("id") if isinstance(issue, dict) else issue_id, "identifier": issue.get("identifier") if isinstance(issue, dict) else None, "team_id": team_id, "project_id": project_id, "state_id": state_id}


def _filter_children_by_label(children: list[dict[str, Any]], label_name: str | None) -> list[dict[str, Any]]:
    if label_name is None:
        return children
    wanted = label_name.strip().lower()
    return [child for child in children if wanted in {str(label).strip().lower() for label in child.get("labels", [])}]
