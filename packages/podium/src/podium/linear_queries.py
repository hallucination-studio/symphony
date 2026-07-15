from __future__ import annotations

from dataclasses import dataclass

PROJECTS_PAGE = "projects_page"


@dataclass(frozen=True)
class LinearQuery:
    operation_name: str
    document: str


LINEAR_QUERIES = {
    PROJECTS_PAGE: LinearQuery(
        "SymphonyProjectsPage",
        """query SymphonyProjectsPage($first: Int!, $after: String) {
          viewer { id app }
          organization { id }
          projects(first: $first, after: $after) {
            nodes { id name slugId }
            pageInfo { hasNextPage endCursor }
          }
        }""",
    )
}
