from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from performer_api.config import TrackerConfig
from performer.linear import LinearClient, LinearError, LinearTracker, format_linear_milestone_comment
from performer_api.models import Issue


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
        payload = self.responses.pop(0)
        return httpx.Response(200, json=payload, request=request)


class StatusTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="bad", request=request)


class RequestErrorTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)


class TextTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json", request=request)


def make_config(*, required_delegate_id: str | None = None) -> TrackerConfig:
    return TrackerConfig(
        kind="linear",
        endpoint="https://api.linear.app/graphql",
        project_slug="MT",
        api_key="linear-token",
        required_delegate_id=required_delegate_id,
    )


def issue_node(**overrides: Any) -> dict[str, Any]:
    node = {
        "id": "issue-1",
        "identifier": "MT-1",
        "title": "Build it",
        "description": "Body",
        "priority": 1,
        "branchName": "murphy/mt-1",
        "url": "https://linear.app/x/issue/MT-1",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-02T00:00:00Z",
        "state": {"name": "Todo"},
        "project": {"slugId": "MT", "name": "Main project"},
        "assignee": {"id": "codex-user"},
        "delegate": None,
        "labels": {"nodes": [{"name": " Codex "}, {"name": "Backend"}]},
        "inverseRelations": {
            "nodes": [
                {
                    "type": "blocks",
                    "issue": {
                        "id": "blocker",
                        "identifier": "MT-0",
                        "state": {"name": "Done"},
                    },
                }
            ]
        },
    }
    node.update(overrides)
    return node
