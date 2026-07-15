from __future__ import annotations

import pytest

from podium.linear_gateway import LinearGateway, LinearGatewayFailure
from podium.linear_graphql_client import LinearGraphQLRequestError
from podium.linear_tokens import LinearTokenFailure


def page(*, has_next: bool = False, cursor: str | None = None):
    return {
        "viewer": {"id": "app-user-1", "app": True},
        "organization": {"id": "organization-1"},
        "projects": {
            "nodes": [{"id": "project-1", "name": "Project", "slugId": "project"}],
            "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
        }
    }


@pytest.mark.asyncio
async def test_gateway_injects_token_only_into_fixed_operation() -> None:
    calls = []

    async def access(installation_id: str) -> str:
        assert installation_id == "installation-1"
        return "access-token-sentinel"

    async def transport(**request):
        calls.append(request)
        return page()

    result = await LinearGateway(access, transport=transport).execute(
        "installation-1",
        "projects_page",
        {"first": 25, "after": None},
        correlation_id="correlation-1",
    )

    assert result == {
        "viewer": {"id": "app-user-1", "app": True},
        "organization": {"id": "organization-1"},
        "nodes": [{"id": "project-1", "name": "Project", "slug": "project"}],
        "page_info": {"has_next_page": False, "end_cursor": None},
    }
    assert calls[0]["access_token"] == "access-token-sentinel"
    assert calls[0]["operation_name"] == "SymphonyProjectsPage"
    assert set(calls[0]) == {"access_token", "query", "variables", "operation_name"}
    assert "url" not in calls[0] and "headers" not in calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "variables", "code"),
    [
        ("raw_graphql", {"first": 25, "after": None}, "linear_gateway_operation_denied"),
        ("projects_page", {"first": 51, "after": None}, "linear_gateway_request_invalid"),
        ("projects_page", {"first": 25, "after": None, "query": "{viewer{id}}"}, "linear_gateway_request_invalid"),
        ("projects_page", {"first": 25, "after": None, "headers": {}}, "linear_gateway_request_invalid"),
    ],
)
async def test_gateway_rejects_unapproved_operation_or_variables(
    operation: str, variables: object, code: str
) -> None:
    async def access(_installation_id: str) -> str:
        raise AssertionError("token must not be loaded")

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access).execute(
            "installation-1",
            operation,
            variables,
            correlation_id="correlation-1",
        )
    assert raised.value.code == code


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("installation_id", "correlation_id", "reported_correlation"),
    [
        ("bad\ninstallation", "correlation-1", "correlation-1"),
        ("installation-1", "bad\ncorrelation", "invalid"),
    ],
)
async def test_gateway_rejects_invalid_envelope_without_reflecting_it(
    installation_id: str, correlation_id: str, reported_correlation: str
) -> None:
    async def access(_installation_id: str) -> str:
        raise AssertionError("token must not be loaded")

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access).execute(
            installation_id,
            "projects_page",
            {"first": 25, "after": None},
            correlation_id=correlation_id,
        )
    assert raised.value.code == "linear_gateway_envelope_invalid"
    assert raised.value.correlation_id == reported_correlation


@pytest.mark.asyncio
async def test_gateway_rejects_invalid_token_before_transport() -> None:
    called = False

    async def access(_installation_id: str):
        return ""

    async def transport(**_request):
        nonlocal called
        called = True

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access, transport=transport).execute(
            "installation-1",
            "projects_page",
            {"first": 25, "after": None},
            correlation_id="correlation-1",
        )
    assert raised.value.code == "linear_gateway_authorization_failed"
    assert called is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {"errors": [{"message": "raw"}]},
        {"projects": {"nodes": [], "pageInfo": {"hasNextPage": True, "endCursor": None}}},
        {"projects": {"nodes": [{"id": "p", "name": "n", "token": "secret"}], "pageInfo": {"hasNextPage": False, "endCursor": None}}},
        {"projects": {"nodes": [{"id": "p", "name": "n"}] * 26, "pageInfo": {"hasNextPage": False, "endCursor": None}}},
    ],
)
async def test_gateway_rejects_malformed_or_unbounded_response(response: object) -> None:
    async def access(_installation_id: str) -> str:
        return "access-token-sentinel"

    async def transport(**_request):
        return response

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access, transport=transport).execute(
            "installation-1",
            "projects_page",
            {"first": 25, "after": None},
            correlation_id="correlation-1",
        )
    assert raised.value.code == "linear_gateway_response_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "code", "retryable"),
    [
        (
            LinearGraphQLRequestError(
                "linear_graphql_unavailable", "timeout", retryable=True
            ),
            "linear_gateway_upstream_failed",
            True,
        ),
        (
            LinearGraphQLRequestError(
                "linear_graphql_unauthorized", "denied", retryable=False, status_code=401
            ),
            "linear_gateway_authorization_failed",
            False,
        ),
    ],
)
async def test_timeout_and_auth_failure_are_correlated_and_sanitized(
    failure: Exception, code: str, retryable: bool, caplog
) -> None:
    async def access(_installation_id: str) -> str:
        return "access-token-sentinel"

    async def transport(**_request):
        raise failure

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access, transport=transport).execute(
            "installation-1",
            "projects_page",
            {"first": 25, "after": None},
            correlation_id="correlation-1",
        )
    assert raised.value.to_dict() == {
        "code": code,
        "correlation_id": "correlation-1",
        "sanitized_reason": code,
        "retryable": retryable,
    }
    assert "correlation_id=correlation-1" in caplog.text
    assert "access-token-sentinel" not in caplog.text
    assert "timeout" not in caplog.text
    assert "denied" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("token_code", "gateway_code", "retryable"),
    [
        ("linear_token_refresh_failed", "linear_gateway_upstream_failed", True),
        (
            "linear_identity_verification_failed",
            "linear_gateway_upstream_failed",
            True,
        ),
        ("linear_invalid_grant", "linear_gateway_authorization_failed", False),
        ("linear_credentials_missing", "linear_gateway_authorization_failed", False),
    ],
)
async def test_gateway_preserves_transient_and_terminal_token_semantics(
    token_code: str, gateway_code: str, retryable: bool, caplog
) -> None:
    async def access(_installation_id: str) -> str:
        raise LinearTokenFailure(token_code)

    with pytest.raises(LinearGatewayFailure) as raised:
        await LinearGateway(access).execute(
            "installation-1",
            "projects_page",
            {"first": 25, "after": None},
            correlation_id="correlation-1",
        )
    assert raised.value.code == gateway_code
    assert raised.value.retryable is retryable
    assert "correlation_id=correlation-1" in caplog.text
    assert "access-token-sentinel" not in caplog.text
