from __future__ import annotations

from typing import Any

from .conductor_linear_direct_base import LinearDirectProxyError
from .conductor_linear_direct_helpers import _normalize_linear_issue_dict


class ManagedRunIssueMixin:
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
        return _normalize_linear_issue_dict(issue) if isinstance(issue, dict) and issue.get("id") else {}

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        payload = await self.graphql(
            """
query ManagedRunChildren($issueId: String!) {
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
        label_ids: list[str] = []
        skipped_label_names: list[str] = []
        for name in label_names:
            label_id = await self._existing_label_id(context["team_id"], name)
            if label_id:
                label_ids.append(label_id)
            else:
                skipped_label_names.append(name)
        payload = await self.graphql(
            """
mutation ManagedRunCreateChild(
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
        normalized = _normalize_linear_issue_dict(issue)
        if skipped_label_names:
            normalized["skipped_label_names"] = skipped_label_names
        return normalized

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

    async def transition_issue_by_state_name(self, issue_id: str, state_name: str) -> dict[str, Any]:
        context = await self._issue_label_context(issue_id)
        if str(context.get("state_name") or "").strip().lower() == state_name.strip().lower():
            return {"success": True, "issue_id": issue_id, "state": context.get("state_name")}
        team_id = str(context.get("team_id") or "")
        if not team_id:
            return {"success": False, "issue_id": issue_id, "state": context.get("state_name"), "reason": "missing_team_id"}
        state_id = await self._state_id_by_name(team_id, state_name)
        if not state_id:
            return {"success": False, "issue_id": issue_id, "state": context.get("state_name"), "reason": "state_not_found"}
        return await self.transition_issue(issue_id, state_id)

    async def transition_issue_by_state_target(
        self,
        issue_id: str,
        *,
        names: list[str],
        state_type: str,
    ) -> dict[str, Any]:
        context = await self._issue_label_context(issue_id)
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

    async def _team_workflow_states(self, team_id: str) -> list[dict[str, Any]]:
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
