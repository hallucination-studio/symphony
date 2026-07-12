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

    @classmethod
    def from_environment(cls, *, timeout: float = 20.0) -> "LinearFixture":
        key = (os.environ.get("LINEAR_API_KEY") or os.environ.get("PODIUM_LINEAR_APP_ACCESS_TOKEN", "")).strip()
        if not key:
            raise LinearFixtureError("LINEAR_API_KEY or PODIUM_LINEAR_APP_ACCESS_TOKEN is required for a real flow")
        return cls(
            key,
            os.environ.get("LINEAR_GRAPHQL_ENDPOINT", DEFAULT_ENDPOINT).strip() or DEFAULT_ENDPOINT,
            timeout,
        )

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = httpx.post(
                self.endpoint,
                headers={"Authorization": self.api_key, "Content-Type": "application/json"},
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
              nodes { id name slugId team { id } }
            } }
            """,
            {"slug": slug},
        )
        nodes = ((data.get("projects") or {}).get("nodes") or [])
        if not nodes:
            raise LinearFixtureError(f"linear_project_not_found:{slug}")
        return dict(nodes[0])

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
