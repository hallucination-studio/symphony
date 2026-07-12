from __future__ import annotations

from typing import Any

import httpx


class LinearProxyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ManagedRunLinearProxy:
    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.endpoint = endpoint
        self.api_key = api_key
        self._transport = transport

    async def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Authorization": self.api_key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=self._transport) as client:
            response = await client.post(self.endpoint, json={"query": query, "variables": variables or {}}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise LinearProxyError("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors") and payload.get("data") is None:
            raise LinearProxyError("linear_graphql_errors", str(payload["errors"]))
        return payload

    async def fetch_issue(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ManagedRunIssue($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    title
    description
    url
    state { name type }
    parent { id identifier }
    delegate { id }
    labels { nodes { name } }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        return _normalize_issue(issue) if isinstance(issue, dict) and issue.get("id") else {}

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        context = await self._creation_context(parent_issue_id)
        payload = await self.graphql(
            """
mutation ManagedRunCreateChild(
  $teamId: String!,
  $projectId: String!,
  $stateId: String!,
  $title: String!,
  $description: String!,
  $parentId: String,
  $delegateId: String
) {
  issueCreate(input: {
    teamId: $teamId,
    projectId: $projectId,
    stateId: $stateId,
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
      parent { id identifier }
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
                "title": title,
                "description": description,
                "parentId": parent_issue_id,
                "delegateId": delegate_id,
            },
        )
        result = ((payload.get("data") or {}).get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearProxyError("linear_issue_create_failed", "Linear issueCreate returned success=false")
        child = _normalize_issue(issue)
        if child.get("parent_issue_id") != parent_issue_id:
            raise LinearProxyError("linear_child_parent_mismatch", "Linear issueCreate returned a child under another parent")
        return child

    async def transition_issue(self, issue_id: str, state_id: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
mutation ManagedRunTransitionIssue($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}
""",
            {"issueId": issue_id, "stateId": state_id},
        )
        result = ((payload.get("data") or {}).get("issueUpdate") or {})
        issue = result.get("issue") if isinstance(result, dict) else {}
        state = issue.get("state") if isinstance(issue, dict) else {}
        return {
            "success": bool(result.get("success")),
            "issue_id": issue.get("id") if isinstance(issue, dict) else issue_id,
            "identifier": issue.get("identifier") if isinstance(issue, dict) else None,
            "state": state.get("name") if isinstance(state, dict) else None,
        }

    async def transition_issue_by_state_target(
        self,
        issue_id: str,
        *,
        names: list[str],
        state_type: str,
    ) -> dict[str, Any]:
        context = await self._issue_context(issue_id)
        current = str(context.get("state_name") or "").strip()
        wanted = {name.strip().lower() for name in names if name and name.strip()}
        if current.lower() in wanted:
            return {"success": True, "issue_id": issue_id, "state": current}
        team_id = str(context.get("team_id") or "")
        if not team_id:
            return {"success": False, "issue_id": issue_id, "state": current, "reason": "missing_team_id"}
        states = await self._team_workflow_states(team_id)
        target = next((state for state in states if str(state.get("name") or "").strip().lower() in wanted), None)
        if target is None and state_type:
            target = next((state for state in states if str(state.get("type") or "") == state_type), None)
        if target is None or not target.get("id"):
            return {"success": False, "issue_id": issue_id, "state": current, "reason": "state_not_found"}
        if str(target.get("name") or "").strip().lower() == current.lower():
            return {"success": True, "issue_id": issue_id, "state": current}
        return await self.transition_issue(issue_id, str(target["id"]))

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

    async def _issue_context(self, issue_id: str) -> dict[str, str]:
        payload = await self.graphql(
            """
query ManagedRunIssueContext($issueId: String!) {
  issue(id: $issueId) {
    team { id }
    state { name }
  }
}
""",
            {"issueId": issue_id},
        )
        issue = ((payload.get("data") or {}).get("issue") or {})
        team = issue.get("team") if isinstance(issue, dict) and isinstance(issue.get("team"), dict) else {}
        state = issue.get("state") if isinstance(issue, dict) and isinstance(issue.get("state"), dict) else {}
        return {"team_id": str(team.get("id") or ""), "state_name": str(state.get("name") or "")}

    async def _creation_context(self, issue_id: str) -> dict[str, str]:
        payload = await self.graphql(
            """
query ManagedRunCreationContext($issueId: String!) {
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
        return {
            "team_id": str(team.get("id") or ""),
            "project_id": str(project.get("id") or ""),
            "state_id": str(state.get("id") or ""),
        }

    async def _team_workflow_states(self, team_id: str) -> list[dict[str, str]]:
        payload = await self.graphql(
            """
query ConductorTeamWorkflowStates($teamId: ID!) {
  workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
    nodes { id name type }
  }
}
""",
            {"teamId": team_id},
        )
        nodes = (((payload.get("data") or {}).get("workflowStates") or {}).get("nodes") or [])
        return [
            {"id": str(node.get("id") or ""), "name": str(node.get("name") or ""), "type": str(node.get("type") or "")}
            for node in nodes
            if isinstance(node, dict) and node.get("id")
        ]

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

def _normalize_issue(node: dict[str, Any]) -> dict[str, Any]:
    labels = node.get("labels") if isinstance(node.get("labels"), dict) else {}
    label_nodes = labels.get("nodes") if isinstance(labels, dict) else []
    delegate = node.get("delegate") if isinstance(node.get("delegate"), dict) else None
    parent = node.get("parent") if isinstance(node.get("parent"), dict) else None
    state = node.get("state") if isinstance(node.get("state"), dict) else {}
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
        "labels": [
            str(label.get("name") or "")
            for label in (label_nodes or [])
            if isinstance(label, dict) and label.get("name")
        ],
    }


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


__all__ = ["LinearProxyError", "ManagedRunLinearProxy"]
