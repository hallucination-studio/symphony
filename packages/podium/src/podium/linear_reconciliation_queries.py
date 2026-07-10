from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .linear_constants import LINEAR_GRAPHQL_URL


ISSUE_FIELDS = """
    nodes {
      id identifier title description createdAt updatedAt
      project { id slugId }
      delegate { id }
      parent { id identifier }
      inverseRelations(first: 50) {
        nodes { type issue { id identifier } relatedIssue { id identifier } }
      }
    }
    pageInfo { hasNextPage endCursor }
"""

BASELINE_QUERY = f"""
query SymphonyDelegatedIssuesBaseline(
  $projectId: ID!, $delegateId: ID!, $first: Int!, $after: String
) {{
  issues(
    first: $first, after: $after, orderBy: updatedAt,
    filter: {{
      project: {{ id: {{ eq: $projectId }} }},
      delegate: {{ id: {{ eq: $delegateId }} }}
    }}
  ) {{
{ISSUE_FIELDS}
  }}
}}
"""

INCREMENTAL_QUERY = f"""
query SymphonyDelegatedIssuesIncremental(
  $projectId: ID!, $updatedAfter: DateTimeOrDuration!, $first: Int!, $after: String
) {{
  issues(
    first: $first, after: $after, orderBy: updatedAt,
    filter: {{
      project: {{ id: {{ eq: $projectId }} }},
      updatedAt: {{ gte: $updatedAfter }}
    }}
  ) {{
{ISSUE_FIELDS}
  }}
}}
"""


class LinearReconciliationError(RuntimeError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class LinearIssuePage:
    issues: list[dict[str, Any]]
    has_next_page: bool
    end_cursor: str


class LinearReconciliationClient:
    def __init__(
        self,
        *,
        state: Any,
        transport: Callable[[httpx.Request], httpx.Response] | None,
        page_size: int,
    ) -> None:
        self.state = state
        self.transport = transport
        self.page_size = max(1, int(page_size or 50))

    async def fetch_page(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        *,
        mode: str,
        updated_after: str | None,
        after: str | None,
    ) -> LinearIssuePage:
        payload = self._payload(installation, project, mode=mode, updated_after=updated_after, after=after)
        token = await self.state.linear_access_token(installation)
        response = await self._post(payload, token)
        if response.status_code == 401:
            token = await self.state.linear_access_token(
                installation,
                force_refresh=True,
                rejected_access_token=token,
            )
            response = await self._post(payload, token)
        if response.status_code == 401:
            current = await self.state.get_active_linear_installation(str(installation.get("user_id") or ""))
            if current is not None:
                await self.state.mark_linear_reauthorization_required(current, "linear_token_rejected_after_refresh")
            raise LinearReconciliationError(
                "linear_reauthorization_required",
                "Linear authorization must be renewed",
            )
        return _parse_page(response)

    def _payload(
        self,
        installation: dict[str, Any],
        project: dict[str, Any],
        *,
        mode: str,
        updated_after: str | None,
        after: str | None,
    ) -> dict[str, Any]:
        variables: dict[str, Any] = {
            "projectId": str(project["linear_project_id"]),
            "first": self.page_size,
            "after": after,
        }
        if mode == "baseline":
            variables["delegateId"] = str(installation["app_user_id"])
        else:
            variables["updatedAfter"] = updated_after
        return {
            "query": BASELINE_QUERY if mode == "baseline" else INCREMENTAL_QUERY,
            "variables": variables,
        }

    async def _post(self, payload: dict[str, Any], token: str) -> httpx.Response:
        transport = httpx.MockTransport(self.transport) if self.transport is not None else None
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=transport) as client:
            return await client.post(
                LINEAR_GRAPHQL_URL,
                json=payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )


def _parse_page(response: httpx.Response) -> LinearIssuePage:
    if response.status_code == 429:
        raise LinearReconciliationError("linear_reconciliation_rate_limited", "Linear reconciliation was rate limited")
    if response.status_code >= 500:
        raise LinearReconciliationError("linear_reconciliation_unavailable", "Linear reconciliation is unavailable")
    if response.status_code >= 400:
        raise LinearReconciliationError("linear_reconciliation_rejected", "Linear reconciliation was rejected")
    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise LinearReconciliationError(
            "linear_reconciliation_invalid_response",
            "Linear reconciliation returned invalid data",
        ) from exc
    if not isinstance(payload, dict) or payload.get("errors"):
        raise LinearReconciliationError(
            "linear_reconciliation_operation_failed",
            "Linear reconciliation operation failed",
        )
    connection = ((payload.get("data") or {}).get("issues") or {})
    page_info = connection.get("pageInfo") if isinstance(connection.get("pageInfo"), dict) else {}
    nodes = connection.get("nodes") if isinstance(connection, dict) else []
    if not isinstance(nodes, list) or "hasNextPage" not in page_info:
        raise LinearReconciliationError(
            "linear_reconciliation_invalid_response",
            "Linear reconciliation page metadata is invalid",
        )
    return LinearIssuePage(
        issues=[node for node in nodes if isinstance(node, dict)],
        has_next_page=bool(page_info.get("hasNextPage")),
        end_cursor=str(page_info.get("endCursor") or ""),
    )
