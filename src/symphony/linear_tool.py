from __future__ import annotations

import json
import re
from typing import Any

import httpx


class LinearGraphQLTool:
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        timeout_ms: int = 30_000,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.endpoint = endpoint
        self.api_key = api_key
        self.timeout = timeout_ms / 1000
        self.transport = transport

    async def __call__(self, arguments: Any) -> dict[str, Any]:
        parsed = self._parse_arguments(arguments)
        if parsed.get("success") is False:
            return parsed
        if not self.api_key:
            return _failure("missing_auth", "Linear API key is missing")

        query = parsed["query"]
        variables = parsed["variables"]
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport, trust_env=False) as client:
                response = await client.post(
                    self.endpoint,
                    json={"query": query, "variables": variables},
                    headers={"Authorization": self.api_key, "Content-Type": "application/json"},
                )
        except httpx.HTTPError as exc:
            return _failure("linear_api_request", str(exc))

        if response.status_code != 200:
            return _failure("linear_api_status", f"Linear returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except json.JSONDecodeError:
            return _failure("linear_unknown_payload", "Linear response was not valid JSON")
        if not isinstance(payload, dict):
            return _failure("linear_unknown_payload", "Linear response was not an object")
        if payload.get("errors"):
            return {
                "success": False,
                "error": {"code": "linear_graphql_errors", "message": "Linear returned GraphQL errors"},
                "response": payload,
            }
        return {"success": True, "response": payload}

    def _parse_arguments(self, arguments: Any) -> dict[str, Any]:
        if isinstance(arguments, str):
            query = arguments
            variables: dict[str, Any] = {}
        elif isinstance(arguments, dict):
            query = arguments.get("query")
            variables = arguments.get("variables", {})
        else:
            return _failure("invalid_arguments", "Expected a GraphQL query string or argument object")

        if not isinstance(query, str) or not query.strip():
            return _failure("invalid_query", "query must be a non-empty string")
        if not isinstance(variables, dict):
            return _failure("invalid_variables", "variables must be an object")
        if _operation_count(query) != 1:
            return _failure("multiple_operations", "query must contain exactly one GraphQL operation")
        return {"success": True, "query": query, "variables": variables}


def _operation_count(query: str) -> int:
    without_comments = re.sub(r"(?m)#.*$", "", query)
    return len(re.findall(r"\b(query|mutation|subscription)\b", without_comments))


def _failure(code: str, message: str) -> dict[str, Any]:
    return {"success": False, "error": {"code": code, "message": message}}
