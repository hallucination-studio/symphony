from __future__ import annotations

import json
from typing import Any

import httpx

from performer_api.config import TrackerConfig
from performer_api.models import LIFECYCLE_LABELS, BlockerRef, Issue


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


CANDIDATE_QUERY = _issues_query("PerformerCandidateIssues", include_assignee_filter=False)
ISSUES_BY_STATES_QUERY = _issues_query("PerformerIssuesByStates", include_assignee_filter=False)


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
query PerformerIssueStates($ids: [ID!], $projectSlug: String!) {
  issues(filter: { id: { in: $ids }, project: { slugId: { eq: $projectSlug } } }) {
    nodes {
      id
      identifier
      title
      description
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
mutation PerformerCommentIssue($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}
"""


ISSUE_COMMENTS_QUERY = """
query PerformerIssueComments($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    comments(first: $first) {
      nodes {
        id
        body
        createdAt
        user { id name }
      }
    }
  }
}
"""


ISSUE_UPDATE_STATE_MUTATION = """
mutation PerformerTransitionIssue($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}
"""


ISSUE_TEAM_STATES_QUERY = """
query PerformerIssueTeamStates($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team {
      id
      states(first: 100) {
        nodes { id name }
      }
    }
  }
}
"""


ISSUE_DESCRIPTION_QUERY = """
query PerformerIssueDescription($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    description
  }
}
"""


ISSUE_UPDATE_DESCRIPTION_MUTATION = """
mutation PerformerUpdateIssueDescription($issueId: String!, $description: String!) {
  issueUpdate(id: $issueId, input: { description: $description }) {
    success
    issue { id identifier description }
  }
}
"""


ISSUE_ACCEPTANCE_RELATIONS_QUERY = """
query PerformerAcceptanceRelations($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    inverseRelations {
      nodes {
        id
        type
        issue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
        relatedIssue {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
        }
      }
    }
  }
}
"""


ISSUE_CREATE_MUTATION = """
mutation PerformerCreateIssue(
  $teamId: String!,
  $projectId: String!,
  $stateId: String!,
  $labelIds: [String!],
  $title: String!,
  $description: String!,
  $parentId: String
) {
  issueCreate(input: {
    teamId: $teamId,
    projectId: $projectId,
    stateId: $stateId,
    labelIds: $labelIds,
    title: $title,
    description: $description,
    parentId: $parentId
  }) {
    success
    issue {
      id
      identifier
      title
      url
      state { name }
      labels { nodes { name } }
    }
  }
}
"""


ISSUE_CHILDREN_QUERY = """
query PerformerIssueChildren($issueId: String!) {
  issue(id: $issueId) {
    id
    children(first: 100) {
      nodes {
        id
        identifier
        title
        description
        url
        state { name }
        labels { nodes { name } }
      }
    }
  }
}
"""


ISSUE_RELATION_CREATE_MUTATION = """
mutation PerformerCreateIssueRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation {
      id
      type
      issue { id identifier }
      relatedIssue { id identifier }
    }
  }
}
"""


ISSUE_LABEL_CONTEXT_QUERY = """
query PerformerIssueLabelContext($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team { id }
    labels { nodes { id name } }
  }
}
"""


ISSUE_CREATION_CONTEXT_QUERY = """
query PerformerIssueCreationContext($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    team { id }
    project { id }
    state { id name }
  }
}
"""


ISSUE_LABEL_BY_NAME_QUERY = """
query PerformerIssueLabelByName($name: String!, $teamId: ID!) {
  issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}
"""


ISSUE_LABEL_CREATE_MUTATION = """
mutation PerformerIssueLabelCreate($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success
    issueLabel { id name }
  }
}
"""


ISSUE_UPDATE_LABELS_MUTATION = """
mutation PerformerUpdateIssueLabels($issueId: String!, $labelIds: [String!]) {
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
        if payload.get("errors"):
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
            },
        )
        result = ((payload.get("data") or {}).get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearError("linear_issue_create_failed", "Linear issueCreate returned success=false")
        return issue

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        payload = await self.graphql(ISSUE_CHILDREN_QUERY, {"issueId": parent_issue_id})
        issue = ((payload.get("data") or {}).get("issue") or {})
        nodes = (((issue.get("children") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        children = [_normalize_issue_dict(node) for node in nodes if isinstance(node, dict)]
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
            if blocker.get("id") == issue_id:
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
        )

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        context = await self._fetch_issue_label_context(issue_id)
        target = await self._ensure_issue_label(context["team_id"], label_name)
        lifecycle_labels = {label.lower() for label in LIFECYCLE_LABELS.values()}
        preserved = [
            label
            for label in context["labels"]
            if str(label.get("name") or "").lower() not in lifecycle_labels
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
    ) -> dict[str, Any]:
        return await self.client.create_issue(
            team_id=team_id,
            project_id=project_id,
            state_id=state_id,
            label_ids=label_ids,
            title=title,
            description=description,
            parent_id=parent_id,
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
    ) -> dict[str, Any]:
        return await self.client.create_child_issue_for(
            parent_issue_id=parent_issue_id,
            title=title,
            description=description,
            label_names=label_names,
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


def format_linear_milestone_comment(
    issue_detail: dict[str, object], *, event_type: str, debug_url: str, verdict=None
) -> str:
    """
    格式化 Linear milestone comment

    Args:
        verdict: 可选的 CompletionVerdict，用于展示验证结果
    """
    latest_run = issue_detail.get("latest_run")
    if not isinstance(latest_run, dict):
        latest_run = {}
    turns = int(latest_run.get("turn_count") or 0)
    tokens = int(latest_run.get("total_tokens") or 0)
    cost = float(latest_run.get("estimated_cost_usd") or 0.0)
    reason = str(issue_detail.get("state_explanation") or "")

    # 基础信息
    lines = [
        f"Performer milestone: {event_type}",
        f"Turns: {turns}",
    ]

    # Token 信息（仅当非 0 时显示）
    if tokens > 0:
        lines.append(f"Tokens: {tokens}")

    # Cost 信息
    if cost > 0:
        lines.append(f"Cost: ${cost:.2f}")
    else:
        lines.append("Cost: N/A")

    lines.append(f"Reason: {reason}")
    lines.append(f"Debug: {debug_url}")

    # 🆕 添加验证结果
    if verdict:
        lines.append("")
        lines.append(f"✅ Completion Verification (verified at {verdict.verified_at}):")

        for check in verdict.checks:
            icon = "✅" if check.passed else "❌"
            lines.append(f"  {icon} {check.check_name}: {check.message}")

        # 添加关键证据
        if "diff_stat" in verdict.evidence:
            stat_lines = verdict.evidence["diff_stat"].split("\n")
            if stat_lines:
                lines.append(f"  - Changes: {stat_lines[0]}")
        if "test_output" in verdict.evidence:
            lines.append(f"  - Tests: {verdict.evidence['test_output']}")
        if "duration_sec" in verdict.evidence:
            lines.append(f"  - Duration: {verdict.evidence['duration_sec']}s")

        lines.append("")
        lines.append("Verified by: Performer Completion Verifier v1.0")

    return "\n".join(lines)


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


def _normalize_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    state = node.get("state")
    state_name = state.get("name") if isinstance(state, dict) else state
    labels = [
        label.get("name", "")
        for label in (((node.get("labels") or {}).get("nodes")) or [])
        if isinstance(label, dict)
    ]
    return {
        "id": node.get("id") or "",
        "identifier": node.get("identifier") or "",
        "title": node.get("title") or "",
        "url": node.get("url"),
        "state": state_name or "",
        "labels": labels,
    }


def replace_marker_block(description: str, marker_name: str, block: str) -> str:
    begin = f"<!-- BEGIN {marker_name} -->"
    end = f"<!-- END {marker_name} -->"
    replacement = f"{begin}\n{block.strip()}\n{end}"
    start = description.find(begin)
    stop = description.find(end)
    if start >= 0 and stop >= start:
        stop += len(end)
        return f"{description[:start]}{replacement}{description[stop:]}"
    if description.strip():
        return f"{description.rstrip()}\n\n{replacement}"
    return replacement
