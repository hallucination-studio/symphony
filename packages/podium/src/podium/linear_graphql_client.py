from __future__ import annotations

import json
from typing import Any, Callable

import httpx

from .linear_constants import LINEAR_GRAPHQL_URL


class LinearGraphQLRequestError(RuntimeError):
    def __init__(self, code: str, reason: str, *, retryable: bool) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.retryable = retryable


async def execute_linear_graphql(
    *,
    access_token: str,
    query: str,
    variables: dict[str, Any],
    operation_name: str,
    transport: Callable[[httpx.Request], Any] | None = None,
) -> dict[str, Any]:
    client_transport = httpx.MockTransport(transport) if transport else None
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False, transport=client_transport) as client:
            response = await client.post(
                LINEAR_GRAPHQL_URL,
                json={
                    "query": query,
                    "variables": variables,
                    "operationName": operation_name,
                },
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.HTTPError as exc:
        raise LinearGraphQLRequestError(
            "linear_graphql_unavailable",
            "Linear GraphQL request was unavailable",
            retryable=True,
        ) from exc
    if response.status_code >= 500:
        raise LinearGraphQLRequestError(
            "linear_graphql_unavailable",
            "Linear GraphQL request was unavailable",
            retryable=True,
        )
    if response.status_code >= 400:
        raise LinearGraphQLRequestError(
            "linear_graphql_rejected",
            "Linear GraphQL request was rejected",
            retryable=False,
        )
    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise LinearGraphQLRequestError(
            "linear_graphql_invalid_response",
            "Linear GraphQL returned an invalid response",
            retryable=True,
        ) from exc
    if not isinstance(payload, dict) or payload.get("errors"):
        raise LinearGraphQLRequestError(
            "linear_graphql_operation_failed",
            "Linear GraphQL operation failed",
            retryable=True,
        )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise LinearGraphQLRequestError(
            "linear_graphql_invalid_response",
            "Linear GraphQL returned an invalid response",
            retryable=True,
        )
    return data
