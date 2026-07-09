from __future__ import annotations

from typing import Any

import httpx


class LinearDirectProxyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class LinearDirectGraphQLBase:
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
