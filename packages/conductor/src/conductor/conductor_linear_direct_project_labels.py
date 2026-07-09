from __future__ import annotations

from typing import Any

from .conductor_linear_direct_base import LinearDirectProxyError


class ProjectLabelLinearProxyMixin:
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
