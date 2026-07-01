from __future__ import annotations

import os

import httpx
import pytest


pytestmark = pytest.mark.skipif(
    os.environ.get("PERFORMER_REAL_INTEGRATION") != "1" or not os.environ.get("LINEAR_API_KEY"),
    reason="set PERFORMER_REAL_INTEGRATION=1 and LINEAR_API_KEY to run real integration checks",
)


@pytest.mark.asyncio
async def test_real_linear_api_key_can_query_viewer() -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "https://api.linear.app/graphql",
            json={"query": "query Viewer { viewer { id } }", "variables": {}},
            headers={
                "Authorization": os.environ["LINEAR_API_KEY"],
                "Content-Type": "application/json",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert "errors" not in payload
    assert payload["data"]["viewer"]["id"]
