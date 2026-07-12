from __future__ import annotations

import httpx
import pytest

from tools import linear_fixture


def test_linear_fixture_reports_http_status_without_credentials(monkeypatch) -> None:
    request = httpx.Request("POST", "https://api.linear.app/graphql")
    response = httpx.Response(401, request=request)
    monkeypatch.setattr(linear_fixture.httpx, "post", lambda *args, **kwargs: response)
    fixture = linear_fixture.LinearFixture("not-a-real-token")

    with pytest.raises(linear_fixture.LinearFixtureError, match=r"linear_request_failed:http_401$"):
        fixture.graphql("query { viewer { id } }")
