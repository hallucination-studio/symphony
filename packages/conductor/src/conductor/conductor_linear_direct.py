from __future__ import annotations

from typing import Any

import httpx


class LinearDirectProxyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class RepositoryHandoffLinearProxy:
    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        project_slug: str = "",
        required_delegate_id: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = endpoint
        self.api_key = api_key
        self.project_slug = project_slug
        self.required_delegate_id = required_delegate_id
        self._transport = transport

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": self.api_key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=self._transport) as client:
            response = await client.post(self.endpoint, json={"query": query, "variables": variables or {}}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise LinearDirectProxyError("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors") and payload.get("data") is None:
            raise LinearDirectProxyError("linear_graphql_errors", str(payload["errors"]))
        return payload

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        payload = await self.graphql(
            """
query RepositoryHandoffChildren($issueId: String!) {
  issue(id: $issueId) {
    children(first: 100) {
        nodes {
        id
        identifier
        title
        description
        url
        state { name type }
        delegate { id }
        labels { nodes { name } }
        relations(first: 100) {
          nodes {
            id
            type
            issue { id identifier }
            relatedIssue { id identifier }
          }
        }
      }
    }
  }
}
""",
            {"issueId": parent_issue_id},
        )
        nodes = ((((payload.get("data") or {}).get("issue") or {}).get("children") or {}).get("nodes") or [])
        children = [_normalize_linear_issue_dict(node) for node in nodes if isinstance(node, dict)]
        if label_name is None:
            return children
        wanted = label_name.strip().lower()
        return [child for child in children if wanted in {str(label).lower() for label in child.get("labels", [])}]

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        assignee_id: str | None = None,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        _ = assignee_id
        context = await self._creation_context(parent_issue_id)
        label_ids = [await self._ensure_label_id(context["team_id"], name) for name in label_names]
        payload = await self.graphql(
            """
mutation RepositoryHandoffCreateChild(
  $teamId: String!,
  $projectId: String!,
  $stateId: String!,
  $labelIds: [String!],
  $title: String!,
  $description: String!,
  $parentId: String,
  $delegateId: String
) {
  issueCreate(input: {
    teamId: $teamId,
    projectId: $projectId,
    stateId: $stateId,
    labelIds: $labelIds,
    title: $title,
    description: $description,
    parentId: $parentId,
    delegateId: $delegateId
  }) {
    success
    issue {
      id
      identifier
      title
      description
      url
      delegate { id }
      labels { nodes { name } }
    }
  }
}
""",
            {
                "teamId": context["team_id"],
                "projectId": context["project_id"],
                "stateId": context["state_id"],
                "labelIds": label_ids,
                "title": title,
                "description": description,
                "parentId": parent_issue_id,
                "delegateId": delegate_id,
            },
        )
        result = ((payload.get("data") or {}).get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearDirectProxyError("linear_issue_create_failed", "Linear issueCreate returned success=false")
        return _normalize_linear_issue_dict(issue)

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
query RepositoryHandoffDescription($issueId: String!) {
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
mutation RepositoryHandoffUpdateDescription($issueId: String!, $description: String!) {
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
mutation RepositoryHandoffComment($issueId: String!, $body: String!) {
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

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ConductorCreateIssueRelation($input: IssueRelationCreateInput!) {
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
""",
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
            raise LinearDirectProxyError("linear_issue_relation_create_failed", "Linear issueRelationCreate returned success=false")
        return relation

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ConductorInverseIssueRelations($issueId: String!) {
  issue(id: $issueId) {
    inverseRelations(first: 100) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
}
""",
            {"issueId": related_issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        inverse_relations = (((issue.get("inverseRelations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in inverse_relations:
            if _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        payload = await self.graphql(
            """
query ConductorDirectIssueRelations($issueId: String!) {
  issue(id: $issueId) {
    relations(first: 100) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        direct_relations = (((issue.get("relations") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        for relation in direct_relations:
            if _relation_matches(relation, relation_type=relation_type, issue_id=issue_id, related_issue_id=related_issue_id):
                return relation
        return await self.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def _issue_label_context(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ProjectIssuePhaseContext($issueId: String!) {
  issue(id: $issueId) {
    id
    team { id }
    state { name }
    labels(first: 100) { nodes { id name } }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        labels = (((issue.get("labels") or {}).get("nodes")) or []) if isinstance(issue, dict) else []
        state = issue.get("state") if isinstance(issue, dict) and isinstance(issue.get("state"), dict) else {}
        team = issue.get("team") if isinstance(issue, dict) and isinstance(issue.get("team"), dict) else {}
        return {
            "team_id": str(team.get("id") or ""),
            "state_name": str(state.get("name") or ""),
            "labels": [dict(label) for label in labels if isinstance(label, dict)],
        }

    async def _state_id_by_name(self, team_id: str, state_name: str) -> str | None:
        payload = await self.graphql(
            """
query ProjectIssuePhaseStateByName($teamId: ID!, $stateName: String!) {
  workflowStates(first: 20, filter: { team: { id: { eq: $teamId } }, name: { eq: $stateName } }) {
    nodes { id name }
  }
}
""",
            {"teamId": team_id, "stateName": state_name},
        )
        nodes = (((payload.get("data") or {}).get("workflowStates") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id"):
                return str(node["id"])
        return None

    async def _creation_context(self, issue_id: str) -> dict[str, str]:
        payload = await self.graphql(
            """
query RepositoryHandoffCreationContext($issueId: String!) {
  issue(id: $issueId) {
    team { id }
    project { id }
    state { id }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) and isinstance(issue.get("team"), dict) else {}
        project = issue.get("project") if isinstance(issue, dict) and isinstance(issue.get("project"), dict) else {}
        state = issue.get("state") if isinstance(issue, dict) and isinstance(issue.get("state"), dict) else {}
        return {"team_id": str(team.get("id") or ""), "project_id": str(project.get("id") or ""), "state_id": str(state.get("id") or "")}

    async def _ensure_label_id(self, team_id: str, label_name: str) -> str:
        payload = await self.graphql(
            """
query RepositoryHandoffLabelByName($name: String!, $teamId: ID!) {
  issueLabels(first: 20, filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) {
    nodes { id name }
  }
}
""",
            {"name": label_name, "teamId": team_id},
        )
        nodes = (((payload.get("data") or {}).get("issueLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id"):
                return str(node["id"])
        payload = await self.graphql(
            """
mutation RepositoryHandoffCreateLabel($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success
    issueLabel { id name }
  }
}
""",
            {"name": label_name, "teamId": team_id},
        )
        label = (((payload.get("data") or {}).get("issueLabelCreate") or {}).get("issueLabel") or {})
        if not isinstance(label, dict) or not label.get("id"):
            raise LinearDirectProxyError("linear_label_create_failed", f"Could not create Linear label: {label_name}")
        return str(label["id"])


class ProjectLabelLinearProxy(RepositoryHandoffLinearProxy):
    """Reads and writes project-level labels through Podium's Linear proxy.

    Linear models project labels (`ProjectLabel`) separately from issue labels,
    so this cannot reuse `issueLabel*`. `projectUpdate.labelIds` is a full
    replacement; callers merge before writing (see `_merge_project_labels`).
    """

    async def find_project_id(self, project_slug: str) -> str | None:
        payload = await self.graphql(
            """
query ProjectLabelFindProject($slug: String!) {
  projects(filter: { slugId: { eq: $slug } }, first: 1) {
    nodes { id slugId name }
  }
}
""",
            {"slug": project_slug},
        )
        nodes = (((payload.get("data") or {}).get("projects") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id"):
                return str(node["id"])
        return None

    async def fetch_project_labels(self, project_id: str) -> list[dict[str, str]]:
        payload = await self.graphql(
            """
query ProjectLabels($projectId: String!) {
  project(id: $projectId) {
    id
    labels(first: 100) { nodes { id name } }
  }
}
""",
            {"projectId": project_id},
        )
        project = ((payload.get("data") or {}).get("project") or {})
        nodes = ((project.get("labels") or {}).get("nodes") or []) if isinstance(project, dict) else []
        return [
            {"id": str(node.get("id")), "name": str(node.get("name") or "")}
            for node in nodes
            if isinstance(node, dict) and node.get("id")
        ]

    async def ensure_project_label_id(self, name: str) -> str:
        payload = await self.graphql(
            """
query ProjectLabelByName($name: String!) {
  projectLabels(filter: { name: { eq: $name } }, first: 20) {
    nodes { id name }
  }
}
""",
            {"name": name},
        )
        nodes = (((payload.get("data") or {}).get("projectLabels") or {}).get("nodes") or [])
        for node in nodes:
            if isinstance(node, dict) and node.get("id"):
                return str(node["id"])
        payload = await self.graphql(
            """
mutation ProjectLabelCreate($name: String!) {
  projectLabelCreate(input: { name: $name }) {
    success
    projectLabel { id name }
  }
}
""",
            {"name": name},
        )
        label = (((payload.get("data") or {}).get("projectLabelCreate") or {}).get("projectLabel") or {})
        if not isinstance(label, dict) or not label.get("id"):
            raise LinearDirectProxyError("linear_project_label_create_failed", f"Could not create project label: {name}")
        return str(label["id"])

    async def set_project_labels(self, project_id: str, label_ids: list[str]) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ProjectSetLabels($projectId: String!, $labelIds: [String!]) {
  projectUpdate(id: $projectId, input: { labelIds: $labelIds }) {
    success
    project { id }
  }
}
""",
            {"projectId": project_id, "labelIds": label_ids},
        )
        result = ((payload.get("data") or {}).get("projectUpdate") or {})
        if not result.get("success"):
            raise LinearDirectProxyError("linear_project_update_failed", "projectUpdate returned success=false")
        return {"success": True, "project_id": project_id, "label_ids": label_ids}


def _normalize_linear_issue_dict(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    parent = node.get("parent") if isinstance(node.get("parent"), dict) else None
    state = node.get("state") if isinstance(node.get("state"), dict) else {}
    blocked_by: list[dict[str, str | None]] = []
    direct_relations: list[dict[str, Any]] = []
    inverse_relations = node.get("inverseRelations") if isinstance(node.get("inverseRelations"), dict) else {}
    for relation in inverse_relations.get("nodes") or []:
        if not isinstance(relation, dict) or relation.get("type") != "blocks":
            continue
        issue = relation.get("issue") or relation.get("relatedIssue") or {}
        if not isinstance(issue, dict):
            continue
        blocker_state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
        blocked_by.append(
            {
                "id": issue.get("id"),
                "identifier": issue.get("identifier"),
                "state": blocker_state.get("name") if isinstance(blocker_state, dict) else issue.get("state"),
            }
        )
    relations = node.get("relations") if isinstance(node.get("relations"), dict) else {}
    for relation in relations.get("nodes") or []:
        if isinstance(relation, dict):
            direct_relations.append(relation)
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier"),
        "title": node.get("title"),
        "description": node.get("description") or "",
        "url": node.get("url"),
        "state": state.get("name") if isinstance(state, dict) else node.get("state"),
        "state_type": state.get("type") if isinstance(state, dict) else None,
        "delegate_id": delegate.get("id") if delegate else None,
        "parent_issue_id": parent.get("id") if parent else None,
        "parent_identifier": parent.get("identifier") if parent else None,
        "blocked_by": blocked_by,
        "relations": direct_relations,
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
    }


def _relation_matches(
    relation: Any,
    *,
    relation_type: str,
    issue_id: str,
    related_issue_id: str,
) -> bool:
    if not isinstance(relation, dict) or relation.get("type") != relation_type:
        return False
    issue = relation.get("issue") if isinstance(relation.get("issue"), dict) else {}
    related_issue = relation.get("relatedIssue") if isinstance(relation.get("relatedIssue"), dict) else {}
    return issue.get("id") == issue_id and related_issue.get("id") == related_issue_id


def _replace_marker_block(current: str, marker_name: str, block: str) -> str:
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    replacement = f"{start}\n{block.strip()}\n{end}"
    if start in current and end in current:
        prefix, rest = current.split(start, 1)
        _old, suffix = rest.split(end, 1)
        return f"{prefix.rstrip()}\n\n{replacement}\n\n{suffix.lstrip()}".strip()
    base = current.strip()
    return f"{base}\n\n{replacement}".strip() if base else replacement
