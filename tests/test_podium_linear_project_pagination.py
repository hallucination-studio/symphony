from __future__ import annotations

import json

import httpx
import pytest

from podium.linear_constants import LINEAR_ACCEPTANCE_QUERY
from podium.linear_installation_acceptance import LinearInstallationRejected, fetch_installation_acceptance


def _page(nodes: list[dict[str, str]], *, has_next: bool, end_cursor: str | None) -> dict[str, object]:
    return {
        "data": {
            "viewer": {"id": "app-user", "name": "Symphony", "app": True},
            "organization": {"id": "org-1", "name": "Acme", "urlKey": "acme"},
            "projects": {
                "nodes": nodes,
                "pageInfo": {"hasNextPage": has_next, "endCursor": end_cursor},
            },
        }
    }


@pytest.mark.asyncio
async def test_installation_acceptance_paginates_all_projects() -> None:
    calls: list[dict[str, object]] = []

    def transport(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload["variables"])
        after = payload["variables"]["after"]
        if after is None:
            body = _page(
                [{"id": "p-1", "name": "One", "slugId": "one"}],
                has_next=True,
                end_cursor="cursor-1",
            )
        else:
            body = _page(
                [
                    {"id": "p-2", "name": "Two", "slugId": "two"},
                    {"id": "p-3", "name": "Three", "slugId": "three"},
                ],
                has_next=False,
                end_cursor="cursor-2",
            )
        return httpx.Response(200, json=body)

    result = await fetch_installation_acceptance("access-token", transport=transport, page_size=2)

    assert [project["id"] for project in result["projects"]] == ["p-1", "p-2", "p-3"]
    assert calls == [{"first": 2, "after": None}, {"first": 2, "after": "cursor-1"}]
    assert "pageInfo" in LINEAR_ACCEPTANCE_QUERY
    assert "projects(first: $first, after: $after)" in LINEAR_ACCEPTANCE_QUERY
    assert "projects(first: 250)" not in LINEAR_ACCEPTANCE_QUERY


@pytest.mark.asyncio
async def test_installation_acceptance_rejects_non_advancing_project_cursor() -> None:
    def transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_page([], has_next=True, end_cursor="same-cursor"))

    with pytest.raises(LinearInstallationRejected) as raised:
        await fetch_installation_acceptance("access-token", transport=transport, page_size=10)

    assert raised.value.code == "linear_project_pagination_invalid"
