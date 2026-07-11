from __future__ import annotations

from typing import Any

class LinearDirectContextMixin:
    async def _issue_label_context(self, issue_id: str) -> dict[str, Any]:
        payload = await self.graphql(
            """
query ManagedRunIssueContext($issueId: String!) {
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
query ManagedRunStateByName($teamId: ID!, $stateName: String!) {
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
        return {"team_id": str(team.get("id") or ""), "project_id": str(project.get("id") or ""), "state_id": str(state.get("id") or "")}

    async def _existing_label_id(self, team_id: str, label_name: str) -> str | None:
        payload = await self.graphql(
            """
query ManagedRunLabelByName($name: String!, $teamId: ID!) {
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
        return None
