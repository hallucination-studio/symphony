from __future__ import annotations

import json

import httpx
import pytest

from conductor.linear import ManagedRunLinearProxy


@pytest.mark.anyio
async def test_linear_proxy_creates_a_parented_child_without_unused_label_lookup() -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append(payload)
        query = str(payload["query"])
        if "ManagedRunCreationContext" in query:
            return httpx.Response(
                200,
                json={"data": {"issue": {"team": {"id": "team-1"}, "project": {"id": "project-1"}, "state": {"id": "state-1"}}}},
            )
        assert "ManagedRunCreateChild" in query
        variables = payload["variables"]
        assert "labelIds" not in variables
        assert variables["parentId"] == "parent-1"
        assert variables["delegateId"] == "app-user-1"
        return httpx.Response(
            200,
            json={
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {"id": "child-1", "identifier": "APP-2", "title": "Implement", "description": "Do it"},
                    }
                }
            },
        )

    proxy = ManagedRunLinearProxy(
        endpoint="https://podium.example/api/v1/linear/graphql",
        api_key="test-token",
        transport=httpx.MockTransport(handler),
    )

    child = await proxy.create_child_issue_for(
        parent_issue_id="parent-1",
        title="Implement",
        description="Do it",
        delegate_id="app-user-1",
    )

    assert child["id"] == "child-1"
    assert len(requests) == 2
