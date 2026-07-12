"""Small Linear fixture client used by the single real-flow runner.

The fixture helper intentionally owns only the operations needed by the product
flow.  It never prints the API key or stores it in an evidence file.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

import httpx


DEFAULT_ENDPOINT = "https://api.linear.app/graphql"


class LinearFixtureError(RuntimeError):
    """A sanitized, actionable fixture failure."""


@dataclass
class LinearFixture:
    api_key: str
    endpoint: str = DEFAULT_ENDPOINT
    timeout: float = 20.0
    authorization_scheme: str = ""

    @classmethod
    def from_environment(cls, *, timeout: float = 20.0) -> "LinearFixture":
        api_key = os.environ.get("LINEAR_API_KEY", "").strip()
        if api_key:
            return cls(
                api_key,
                os.environ.get("LINEAR_GRAPHQL_ENDPOINT", DEFAULT_ENDPOINT).strip() or DEFAULT_ENDPOINT,
                timeout,
            )
        api_key = os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "").strip()
        if not api_key:
            raise LinearFixtureError("LINEAR_API_KEY or PODIUM_LINEAR_APP_ACCESS_TOKEN is required for a real flow")
        return cls(
            api_key,
            os.environ.get("LINEAR_GRAPHQL_ENDPOINT", DEFAULT_ENDPOINT).strip() or DEFAULT_ENDPOINT,
            timeout,
            "Bearer",
        )

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = httpx.post(
                self.endpoint,
                headers={
                    "Authorization": " ".join(part for part in (self.authorization_scheme, self.api_key) if part),
                    "Content-Type": "application/json",
                },
                json={"query": query, "variables": variables or {}},
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            raise LinearFixtureError(f"linear_request_failed:http_{status_code}") from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise LinearFixtureError(f"linear_request_failed:{type(exc).__name__}") from exc
        if not isinstance(payload, dict):
            raise LinearFixtureError("linear_response_invalid")
        errors = payload.get("errors")
        if errors:
            code = "graphql_error"
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                code = str(errors[0].get("extensions", {}).get("code") or code)
            raise LinearFixtureError(f"linear_request_failed:{code}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise LinearFixtureError("linear_data_missing")
        return data

    def project(self, slug: str) -> dict[str, Any]:
        data = self.graphql(
            """
            query($slug: String!) { projects(filter: {slugId: {eq: $slug}}, first: 1) {
              nodes { id name slugId teams { nodes { id } } }
            } }
            """,
            {"slug": slug},
        )
        nodes = ((data.get("projects") or {}).get("nodes") or [])
        if not nodes:
            raise LinearFixtureError(f"linear_project_not_found:{slug}")
        project = dict(nodes[0])
        teams = project.get("teams") if isinstance(project.get("teams"), dict) else {}
        team_nodes = teams.get("nodes") if isinstance(teams.get("nodes"), list) else []
        first_team = team_nodes[0] if team_nodes and isinstance(team_nodes[0], dict) else None
        project["team"] = {"id": str(first_team.get("id"))} if first_team and first_team.get("id") else None
        return project

    def workflow_states(self, team_id: str) -> list[dict[str, str]]:
        data = self.graphql(
            """
            query($teamId: ID!) { workflowStates(first: 100, filter: {team: {id: {eq: $teamId}}}) {
              nodes { id name type }
            } }
            """,
            {"teamId": team_id},
        )
        nodes = ((data.get("workflowStates") or {}).get("nodes") or [])
        return [
            {
                "id": str(node.get("id") or ""),
                "name": str(node.get("name") or ""),
                "type": str(node.get("type") or ""),
            }
            for node in nodes
            if isinstance(node, dict) and node.get("id")
        ]

    def create_parent_issue(
        self,
        *,
        team_id: str,
        project_id: str,
        state_id: str,
        title: str,
        description: str,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        data = self.graphql(
            """
            mutation($teamId: String!, $projectId: String!, $stateId: String!,
              $title: String!, $description: String!, $delegateId: String) {
              issueCreate(input: {
                teamId: $teamId,
                projectId: $projectId,
                stateId: $stateId,
                title: $title,
                description: $description,
                parentId: null,
                delegateId: $delegateId
              }) {
                success
                issue {
                  id identifier title
                  parent { id identifier }
                  delegate { id }
                }
              }
            }
            """,
            {
                "teamId": team_id,
                "projectId": project_id,
                "stateId": state_id,
                "title": title,
                "description": description,
                "delegateId": delegate_id,
            },
        )
        result = (data.get("issueCreate") or {})
        issue = result.get("issue") if isinstance(result, dict) else None
        if not result.get("success") or not isinstance(issue, dict) or not issue.get("id"):
            raise LinearFixtureError("linear_issue_create_failed")
        if issue.get("parent") is not None:
            raise LinearFixtureError("linear_parent_parent_mismatch")
        return dict(issue)

    def issue(self, issue_id: str) -> dict[str, Any]:
        data = self.graphql(
            "query($id: String!) { issue(id: $id) { id identifier title state { name } parent { id identifier } } }",
            {"id": issue_id},
        )
        issue = data.get("issue")
        if not isinstance(issue, dict):
            raise LinearFixtureError(f"linear_issue_not_found:{issue_id}")
        return issue

    def children(self, issue_id: str) -> list[dict[str, Any]]:
        data = self.graphql(
            """
            query($id: String!) { issue(id: $id) { children(first: 100) {
              nodes { id identifier title state { name } parent { id identifier } }
            } } }
            """,
            {"id": issue_id},
        )
        nodes = ((data.get("issue") or {}).get("children") or {}).get("nodes") or []
        return [dict(node) for node in nodes if isinstance(node, dict)]


def required_environment() -> dict[str, str]:
    """Return non-secret real-flow settings without exposing secret values."""

    return {
        "project_slug": os.environ.get("SYMPHONY_E2E_PROJECT_SLUG", "").strip(),
        "podium_url": os.environ.get("SYMPHONY_E2E_PODIUM_URL", "").strip(),
        "codex_seed": os.environ.get("SYMPHONY_E2E_CODEX_HOME_SEED", "").strip(),
    }


__all__ = ["DEFAULT_ENDPOINT", "LinearFixture", "LinearFixtureError", "required_environment"]
