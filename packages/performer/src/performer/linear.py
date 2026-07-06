from __future__ import annotations

import json
from typing import Any

import httpx

from performer_api.config import TrackerConfig
from performer_api.labels import LABEL_SCHEME
from performer_api.models import Issue
from .linear_queries import *  # noqa: F403
from .linear_models import *  # noqa: F403


class LinearError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class LinearClient:
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        timeout_ms: int = 30_000,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = endpoint
        self.api_key = api_key
        self.timeout = timeout_ms / 1000
        self._transport = transport

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": self.api_key, "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self._transport, trust_env=False) as client:
                response = await client.post(
                    self.endpoint,
                    json={"query": query, "variables": variables or {}},
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            raise LinearError("linear_api_request", str(exc)) from exc

        if response.status_code != 200:
            raise LinearError("linear_api_status", f"Linear returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise LinearError("linear_unknown_payload", "Linear response was not valid JSON") from exc
        if not isinstance(payload, dict):
            raise LinearError("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors") and payload.get("data") is None:
            raise LinearError("linear_graphql_errors", str(payload["errors"]))
        return payload

    async def fetch_candidate_issues(self, config: TrackerConfig, *, page_size: int = 50) -> list[Issue]:
        query, variables = _issues_query_and_variables(
            "PerformerCandidateIssues",
            config,
            config.active_states,
            page_size=page_size,
        )
        return await self._fetch_paginated(query, variables)

    async def fetch_issues_by_states(self, config: TrackerConfig, state_names: list[str]) -> list[Issue]:
        if not state_names:
            return []
        query, variables = _issues_query_and_variables(
            "PerformerIssuesByStates",
            config,
            state_names,
            page_size=50,
        )
        return await self._fetch_paginated(query, variables)

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
        return {
            "success": bool(result.get("success")),
            "comment_id": comment.get("id") if isinstance(comment, dict) else None,
        }

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 20) -> list[dict[str, Any]]:
        payload = await self.graphql(ISSUE_COMMENTS_QUERY, {"issueId": issue_id, "first": first})
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
            if not isinstance(state, dict):
                continue
            if str(state.get("name") or "").strip().lower() == wanted and state.get("id"):
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
        payload = await self.graphql(
            ISSUE_UPDATE_DESCRIPTION_MUTATION,
            {"issueId": issue_id, "description": updated},
        )
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        updated_issue = result.get("issue") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": updated_issue.get("id") if isinstance(updated_issue, dict) else None,
            "identifier": updated_issue.get("identifier") if isinstance(updated_issue, dict) else None,
            "description": updated,
        }

    async def find_acceptance_issue_for(
        self,
        *,
        original_issue: Issue,
        acceptance_label_name: str,
    ) -> dict[str, Any] | None:
        payload = await self.graphql(ISSUE_ACCEPTANCE_RELATIONS_QUERY, {"issueId": original_issue.id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        relations = (((issue.get("inverseRelations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in relations:
            if not isinstance(relation, dict) or relation.get("type") != "blocks":
                continue
            candidate = relation.get("issue")
            if not isinstance(candidate, dict):
                continue
            labels = [
                str(label.get("name") or "").strip().lower()
                for label in (((candidate.get("labels") or {}).get("nodes")) or [])
                if isinstance(label, dict)
            ]
            if acceptance_label_name.strip().lower() in labels:
                return _normalize_issue_dict(candidate)
        return None

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
        payload = await self.graphql(
            ISSUE_UPDATE_DELEGATE_MUTATION,
            {"issueId": issue_id, "delegateId": delegate_id},
        )
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
            issue = ((payload.get("data") or {}).get("issue") or {})
            connection = (issue.get("children") or {}) if isinstance(issue, dict) else {}
            nodes = (connection.get("nodes") or []) if isinstance(connection, dict) else []
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                child = _normalize_issue_dict(node)
                comments_connection = node.get("comments") if isinstance(node.get("comments"), dict) else {}
                comments = list(child.get("comments") or [])
                comments_page = comments_connection.get("pageInfo") if isinstance(comments_connection, dict) else {}
                comments_after = comments_page.get("endCursor") if isinstance(comments_page, dict) else None
                while isinstance(comments_page, dict) and comments_page.get("hasNextPage") and comments_after:
                    page_payload = await self.graphql(
                        ISSUE_CHILDREN_QUERY,
                        {"issueId": parent_issue_id, "childrenAfter": children_after, "commentsAfter": comments_after},
                    )
                    page_issue = ((page_payload.get("data") or {}).get("issue") or {})
                    page_children = ((page_issue.get("children") or {}).get("nodes") or []) if isinstance(page_issue, dict) else []
                    page_node = next(
                        (
                            item
                            for item in page_children
                            if isinstance(item, dict) and str(item.get("id") or "") == child.get("id")
                        ),
                        None,
                    )
                    if page_node is None:
                        break
                    page_comments_connection = page_node.get("comments") if isinstance(page_node.get("comments"), dict) else {}
                    comments.extend(_normalize_comments((page_comments_connection.get("nodes") or []) if isinstance(page_comments_connection, dict) else []))
                    comments_page = page_comments_connection.get("pageInfo") if isinstance(page_comments_connection, dict) else {}
                    comments_after = comments_page.get("endCursor") if isinstance(comments_page, dict) else None
                child["comments"] = comments
                child_id = str(child.get("id") or "")
                if child_id:
                    children_by_id[child_id] = child
            page_info = connection.get("pageInfo") if isinstance(connection, dict) else {}
            if not isinstance(page_info, dict) or not page_info.get("hasNextPage"):
                break
            children_after = page_info.get("endCursor") if isinstance(page_info.get("endCursor"), str) else None
            if not children_after:
                break
        children = list(children_by_id.values())
        if label_name is None:
            return children
        wanted = label_name.strip().lower()
        return [
            child
            for child in children
            if wanted in {str(label).strip().lower() for label in child.get("labels", [])}
        ]

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            ISSUE_RELATION_CREATE_MUTATION,
            {
                "input": {
                    "type": relation_type,
                    "issueId": issue_id,
                    "relatedIssueId": related_issue_id,
                }
            },
        )
        result = ((payload.get("data") or {}).get("issueRelationCreate") or {})
        relation = result.get("issueRelation") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(relation, dict) or not relation.get("id"):
            raise LinearError("linear_issue_relation_create_failed", "Linear issueRelationCreate returned success=false")
        return relation

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_ACCEPTANCE_RELATIONS_QUERY, {"issueId": related_issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        relations = (((issue.get("inverseRelations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in relations:
            if not isinstance(relation, dict) or relation.get("type") != relation_type:
                continue
            blocker = relation.get("issue") if isinstance(relation.get("issue"), dict) else {}
            if blocker.get("id") == issue_id or _relation_matches(
                relation,
                relation_type=relation_type,
                issue_id=issue_id,
                related_issue_id=related_issue_id,
            ):
                return relation
        payload = await self.graphql(ISSUE_ACCEPTANCE_RELATIONS_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        direct_relations = (((issue.get("relations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in direct_relations:
            if not isinstance(relation, dict) or relation.get("type") != relation_type:
                continue
            related_issue = relation.get("relatedIssue") if isinstance(relation.get("relatedIssue"), dict) else {}
            if related_issue.get("id") == related_issue_id or _relation_matches(
                relation,
                relation_type=relation_type,
                issue_id=issue_id,
                related_issue_id=related_issue_id,
            ):
                return relation
        return await self.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def create_acceptance_issue_for(
        self,
        *,
        original_issue_id: str,
        title: str,
        description: str,
        acceptance_label_name: str,
    ) -> dict[str, Any]:
        context = await self._fetch_issue_creation_context(original_issue_id)
        label = await self._ensure_issue_label(context["team_id"], acceptance_label_name)
        return await self.create_issue(
            team_id=context["team_id"],
            project_id=context["project_id"],
            state_id=context["state_id"],
            label_ids=[label["id"]],
            title=title,
            description=description,
        )

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

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        context = await self._fetch_issue_label_context(issue_id)
        target = await self._ensure_issue_label(context["team_id"], label_name)
        preserved = [
            label
            for label in context["labels"]
            if _preserve_non_phase_performer_label(str(label.get("name") or ""))
        ]
        label_ids = [label["id"] for label in preserved if label.get("id")]
        if target["id"] not in label_ids:
            label_ids.append(target["id"])
        payload = await self.graphql(ISSUE_UPDATE_LABELS_MUTATION, {"issueId": issue_id, "labelIds": label_ids})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": issue.get("id") if isinstance(issue, dict) else None,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "label": label_name,
            "label_ids": label_ids,
        }

    async def set_issue_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> dict[str, Any]:
        context = await self._fetch_issue_label_context(issue_id)
        target = await self._ensure_issue_label(context["team_id"], label_name)
        lowered_prefix = prefix.lower()
        preserved = [
            label
            for label in context["labels"]
            if not str(label.get("name") or "").lower().startswith(lowered_prefix)
        ]
        label_ids = [label["id"] for label in preserved if label.get("id")]
        if target["id"] not in label_ids:
            label_ids.append(target["id"])
        payload = await self.graphql(ISSUE_UPDATE_LABELS_MUTATION, {"issueId": issue_id, "labelIds": label_ids})
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": issue.get("id") if isinstance(issue, dict) else None,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "label": label_name,
            "label_ids": label_ids,
        }

    async def _fetch_issue_label_context(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(ISSUE_LABEL_CONTEXT_QUERY, {"issueId": issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) else {}
        team_id = team.get("id") if isinstance(team, dict) else None
        if not isinstance(team_id, str) or not team_id:
            raise LinearError("linear_missing_issue_team", "Linear issue.team.id missing")
        labels = (((issue.get("labels") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        return {
            "issue_id": issue.get("id") if isinstance(issue, dict) else issue_id,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "team_id": team_id,
            "labels": [label for label in labels if isinstance(label, dict)],
        }

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
        return {
            "issue_id": issue.get("id") if isinstance(issue, dict) else issue_id,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "team_id": team_id,
            "project_id": project_id,
            "state_id": state_id,
        }

    async def _ensure_issue_label(self, team_id: str, label_name: str) -> dict[str, str]:
        payload = await self.graphql(ISSUE_LABEL_BY_NAME_QUERY, {"name": label_name, "teamId": team_id})
        nodes = (((payload.get("data") or {}).get("issueLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id") and node.get("name") == label_name:
                return {"id": node["id"], "name": node["name"]}
        payload = await self.graphql(ISSUE_LABEL_CREATE_MUTATION, {"name": label_name, "teamId": team_id})
        result = ((payload.get("data") or {}).get("issueLabelCreate") or {})
        label = result.get("issueLabel") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(label, dict) or not label.get("id"):
            raise LinearError("linear_label_create_failed", f"Could not create Linear label: {label_name}")
        return {"id": label["id"], "name": label.get("name") or label_name}

    async def _fetch_paginated(self, query: str, variables: dict[str, Any]) -> list[Issue]:
        issues: list[Issue] = []
        while True:
            payload = await self.graphql(query, variables)
            connection = ((payload.get("data") or {}).get("issues") or {})
            nodes = connection.get("nodes")
            page_info = connection.get("pageInfo") or {}
            if not isinstance(nodes, list):
                raise LinearError("linear_unknown_payload", "Linear issues.nodes missing")
            issues.extend(_normalize_issue(node) for node in nodes)
            if not page_info.get("hasNextPage"):
                return issues
            end_cursor = page_info.get("endCursor")
            if not end_cursor:
                raise LinearError("linear_missing_end_cursor", "Linear pageInfo.endCursor missing")
            variables = dict(variables)
            variables["after"] = end_cursor


class LinearTracker:
    def __init__(
        self,
        config: TrackerConfig,
        *,
        client: LinearClient | None = None,
    ):
        self.config = config
        self.client = client or LinearClient(config.endpoint, config.api_key)

    def update_config(self, config: TrackerConfig) -> None:
        if config.endpoint != self.config.endpoint or config.api_key != self.config.api_key:
            self.client = LinearClient(config.endpoint, config.api_key)
        self.config = config

    async def fetch_candidate_issues(self) -> list[Issue]:
        return await self.client.fetch_candidate_issues(self.config)

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]:
        return await self.client.fetch_issues_by_states(self.config, state_names)

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        return await self.client.fetch_issue_states_by_ids(self.config, issue_ids)

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        return await self.client.comment_issue(issue_id, body)

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 20) -> list[dict[str, Any]]:
        return await self.client.fetch_issue_comments(issue_id, first=first)

    async def transition_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        return await self.client.transition_issue(issue_id, state_id)

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]:
        return await self.client.transition_issue_by_state_name(issue_id, state_name)

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        return await self.client.update_issue_description_marker_block(issue_id, marker_name, block)

    async def find_acceptance_issue_for(
        self,
        *,
        original_issue: Issue,
        acceptance_label_name: str,
    ) -> dict[str, Any] | None:
        return await self.client.find_acceptance_issue_for(
            original_issue=original_issue,
            acceptance_label_name=acceptance_label_name,
        )

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
        return await self.client.create_issue(
            team_id=team_id,
            project_id=project_id,
            state_id=state_id,
            label_ids=label_ids,
            title=title,
            description=description,
            parent_id=parent_id,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        return await self.client.fetch_child_issues(parent_issue_id, label_name=label_name)

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
        return await self.client.create_child_issue_for(
            parent_issue_id=parent_issue_id,
            title=title,
            description=description,
            label_names=label_names,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        return await self.client.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        return await self.client.ensure_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def create_acceptance_issue_for(
        self,
        *,
        original_issue_id: str,
        title: str,
        description: str,
        acceptance_label_name: str,
    ) -> dict[str, Any]:
        return await self.client.create_acceptance_issue_for(
            original_issue_id=original_issue_id,
            title=title,
            description=description,
            acceptance_label_name=acceptance_label_name,
        )

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        return await self.client.set_issue_lifecycle_label(issue_id, label_name)

    async def set_issue_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> dict[str, Any]:
        return await self.client.set_issue_label_group(issue_id, label_name, prefix=prefix)


