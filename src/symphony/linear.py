from __future__ import annotations

import json
from typing import Any

import httpx

from .config import TrackerConfig
from .models import LIFECYCLE_LABEL_PREFIX, BlockerRef, Issue


class LinearError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


ISSUE_FIELDS = """
nodes {
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  project { slugId name }
  assignee { id }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
}
pageInfo { hasNextPage endCursor }
"""


def _issues_query(operation_name: str, *, include_assignee_filter: bool) -> str:
    assignee_variable = ", $assigneeId: ID" if include_assignee_filter else ""
    assignee_filter = "\n      assignee: { id: { eq: $assigneeId } }" if include_assignee_filter else ""
    return f"""
query {operation_name}($projectSlug: String!, $stateNames: [String!], $first: Int!, $after: String{assignee_variable}) {{
  issues(
    first: $first
    after: $after
    filter: {{
      project: {{ slugId: {{ eq: $projectSlug }} }}
      state: {{ name: {{ in: $stateNames }} }}{assignee_filter}
    }}
  ) {{
    {ISSUE_FIELDS}
  }}
}}
"""


CANDIDATE_QUERY = _issues_query("SymphonyCandidateIssues", include_assignee_filter=False)
ISSUES_BY_STATES_QUERY = _issues_query("SymphonyIssuesByStates", include_assignee_filter=False)


def _issues_query_and_variables(
    operation_name: str,
    config: TrackerConfig,
    state_names: list[str],
    *,
    page_size: int,
) -> tuple[str, dict[str, Any]]:
    include_assignee_filter = config.assignee_id is not None
    variables: dict[str, Any] = {
        "projectSlug": config.project_slug,
        "stateNames": state_names,
        "first": page_size,
        "after": None,
    }
    if config.assignee_id is not None:
        variables["assigneeId"] = config.assignee_id
    return _issues_query(operation_name, include_assignee_filter=include_assignee_filter), variables


ISSUE_STATES_QUERY = """
query SymphonyIssueStates($ids: [ID!], $projectSlug: String!) {
  issues(filter: { id: { in: $ids }, project: { slugId: { eq: $projectSlug } } }) {
    nodes {
      id
      identifier
      title
      state { name }
      project { slugId name }
      assignee { id }
      labels { nodes { name } }
      url
      inverseRelations { nodes { type issue { id identifier state { name } } } }
    }
  }
}
"""


COMMENT_CREATE_MUTATION = """
mutation SymphonyCommentIssue($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
"""


ISSUE_UPDATE_STATE_MUTATION = """
mutation SymphonyTransitionIssue($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}
"""


ISSUE_LABEL_CONTEXT_QUERY = """
query SymphonyIssueLabelContext($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team { id }
    labels { nodes { id name } }
  }
}
"""


ISSUE_LABEL_BY_NAME_QUERY = """
query SymphonyIssueLabelByName($name: String!, $teamId: ID!) {
  issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}
"""


ISSUE_LABEL_CREATE_MUTATION = """
mutation SymphonyIssueLabelCreate($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success
    issueLabel { id name }
  }
}
"""


ISSUE_UPDATE_LABELS_MUTATION = """
mutation SymphonyUpdateIssueLabels($issueId: String!, $labelIds: [String!]) {
  issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
    success
    issue {
      id
      identifier
      labels { nodes { id name } }
    }
  }
}
"""


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
            async with httpx.AsyncClient(timeout=self.timeout, transport=self._transport) as client:
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
        if payload.get("errors"):
            raise LinearError("linear_graphql_errors", str(payload["errors"]))
        return payload

    async def fetch_candidate_issues(self, config: TrackerConfig, *, page_size: int = 50) -> list[Issue]:
        query, variables = _issues_query_and_variables(
            "SymphonyCandidateIssues",
            config,
            config.active_states,
            page_size=page_size,
        )
        return await self._fetch_paginated(query, variables)

    async def fetch_issues_by_states(self, config: TrackerConfig, state_names: list[str]) -> list[Issue]:
        if not state_names:
            return []
        query, variables = _issues_query_and_variables(
            "SymphonyIssuesByStates",
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

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        context = await self._fetch_issue_label_context(issue_id)
        target = await self._ensure_issue_label(context["team_id"], label_name)
        preserved = [
            label
            for label in context["labels"]
            if not str(label.get("name") or "").lower().startswith(LIFECYCLE_LABEL_PREFIX)
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

    async def transition_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        return await self.client.transition_issue(issue_id, state_id)

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        return await self.client.set_issue_lifecycle_label(issue_id, label_name)


def _normalize_issue(node: dict[str, Any]) -> Issue:
    labels = [label.get("name", "") for label in (((node.get("labels") or {}).get("nodes")) or [])]
    blockers: list[BlockerRef] = []
    for relation in (((node.get("inverseRelations") or {}).get("nodes")) or []):
        blocker = BlockerRef.from_linear_relation(relation)
        if blocker:
            blockers.append(blocker)
    state = node.get("state")
    state_name = state.get("name") if isinstance(state, dict) else state
    project = node.get("project")
    assignee = node.get("assignee")
    return Issue(
        id=node.get("id") or "",
        identifier=node.get("identifier") or "",
        title=node.get("title") or "",
        description=node.get("description"),
        priority=node.get("priority"),
        state=state_name or "",
        branch_name=node.get("branchName"),
        url=node.get("url"),
        labels=labels,
        blocked_by=blockers,
        created_at=node.get("createdAt"),
        updated_at=node.get("updatedAt"),
        assignee_id=assignee.get("id") if isinstance(assignee, dict) else None,
        project_slug=project.get("slugId") if isinstance(project, dict) else None,
        project_name=project.get("name") if isinstance(project, dict) else None,
    )
