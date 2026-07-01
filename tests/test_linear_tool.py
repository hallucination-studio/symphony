from __future__ import annotations

from typing import Any

import httpx
import pytest

from performer.linear_tool import LinearGraphQLTool


class RecordingTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[dict[str, Any]]):
        self.responses = responses
        self.requests: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "url": str(request.url),
                "headers": request.headers,
                "json": __import__("json").loads(request.content.decode()),
            }
        )
        return httpx.Response(200, json=self.responses.pop(0), request=request)


class ErrorTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)


@pytest.mark.asyncio
async def test_linear_graphql_tool_executes_raw_query_string() -> None:
    transport = RecordingTransport([{"data": {"viewer": {"id": "user-1"}}}])
    tool = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await tool({"query": "query Viewer { viewer { id } }"})

    assert result["success"] is True
    assert result["response"] == {"data": {"viewer": {"id": "user-1"}}}
    assert transport.requests[0]["headers"]["authorization"] == "linear-token"
    assert transport.requests[0]["json"]["query"] == "query Viewer { viewer { id } }"
    assert transport.requests[0]["json"]["variables"] == {}


@pytest.mark.asyncio
async def test_linear_graphql_tool_accepts_string_shorthand() -> None:
    transport = RecordingTransport([{"data": {"ok": True}}])
    tool = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await tool("query Ping { viewer { id } }")

    assert result["success"] is True
    assert transport.requests[0]["json"]["query"] == "query Ping { viewer { id } }"


@pytest.mark.asyncio
async def test_linear_graphql_tool_sends_variables_object() -> None:
    transport = RecordingTransport([{"data": {"issue": {"id": "issue-1"}}}])
    tool = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await tool(
        {
            "query": "query Issue($id: String!) { issue(id: $id) { id } }",
            "variables": {"id": "AI-1"},
        }
    )

    assert result["success"] is True
    assert transport.requests[0]["json"]["variables"] == {"id": "AI-1"}


@pytest.mark.asyncio
async def test_linear_graphql_tool_rejects_invalid_arguments_without_request() -> None:
    transport = RecordingTransport([])
    tool = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=transport)

    empty = await tool({"query": " "})
    variables = await tool({"query": "query Viewer { viewer { id } }", "variables": []})
    multi = await tool("query A { viewer { id } } mutation B { noop }")

    assert empty["success"] is False
    assert empty["error"]["code"] == "invalid_query"
    assert variables["success"] is False
    assert variables["error"]["code"] == "invalid_variables"
    assert multi["success"] is False
    assert multi["error"]["code"] == "multiple_operations"
    assert transport.requests == []


@pytest.mark.asyncio
async def test_linear_graphql_tool_preserves_graphql_errors() -> None:
    payload = {"errors": [{"message": "bad"}], "data": None}
    transport = RecordingTransport([payload])
    tool = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await tool("query Viewer { viewer { id } }")

    assert result["success"] is False
    assert result["response"] == payload
    assert result["error"]["code"] == "linear_graphql_errors"


@pytest.mark.asyncio
async def test_linear_graphql_tool_reports_missing_auth_and_transport_errors() -> None:
    missing = LinearGraphQLTool("https://api.linear.app/graphql", "")
    missing_result = await missing("query Viewer { viewer { id } }")

    erroring = LinearGraphQLTool("https://api.linear.app/graphql", "linear-token", transport=ErrorTransport())
    transport_result = await erroring("query Viewer { viewer { id } }")

    assert missing_result["success"] is False
    assert missing_result["error"]["code"] == "missing_auth"
    assert transport_result["success"] is False
    assert transport_result["error"]["code"] == "linear_api_request"
