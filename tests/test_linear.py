from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from symphony.config import TrackerConfig
from symphony.linear import LinearClient, LinearError, LinearTracker


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


def make_config(*, assignee_id: str | None = None) -> TrackerConfig:
    return TrackerConfig(
        kind="linear",
        endpoint="https://api.linear.app/graphql",
        project_slug="MT",
        api_key="linear-token",
        assignee_id=assignee_id,
        required_labels=["codex"],
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


@pytest.mark.asyncio
async def test_fetch_candidate_issues_uses_project_and_active_states() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    issues = await client.fetch_candidate_issues(make_config())

    assert issues[0].identifier == "MT-1"
    assert issues[0].labels == ["codex", "backend"]
    assert issues[0].blocked_by[0].identifier == "MT-0"
    assert issues[0].created_at == datetime(2024, 1, 1, tzinfo=timezone.utc)
    assert issues[0].project_slug == "MT"
    assert issues[0].project_name == "Main project"
    request = transport.requests[0]
    assert request["headers"]["authorization"] == "linear-token"
    variables = request["json"]["variables"]
    assert variables["projectSlug"] == "MT"
    assert variables["stateNames"] == ["Todo", "In Progress"]
    assert "assigneeId" not in variables
    assert "assignee:" not in request["json"]["query"]
    assert "slugId" in request["json"]["query"]


@pytest.mark.asyncio
async def test_fetch_candidate_issues_filters_by_configured_assignee() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    issues = await client.fetch_candidate_issues(make_config(assignee_id="codex-user"))

    assert [issue.identifier for issue in issues] == ["MT-1"]
    request = transport.requests[0]
    variables = request["json"]["variables"]
    assert variables["assigneeId"] == "codex-user"
    assert "$assigneeId: ID" in request["json"]["query"]
    assert "assignee: { id: { eq: $assigneeId } }" in request["json"]["query"]


@pytest.mark.asyncio
async def test_fetch_issues_by_states_filters_by_configured_assignee() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(assignee_id="codex-user"), client=client)

    issues = await tracker.fetch_issues_by_states(["Done"])

    assert [issue.identifier for issue in issues] == ["MT-1"]
    request = transport.requests[0]
    variables = request["json"]["variables"]
    assert variables["stateNames"] == ["Done"]
    assert variables["assigneeId"] == "codex-user"
    assert "$assigneeId: ID" in request["json"]["query"]
    assert "assignee: { id: { eq: $assigneeId } }" in request["json"]["query"]


@pytest.mark.asyncio
async def test_fetch_issues_by_states_omits_assignee_filter_when_unset() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_issues_by_states(["Done"])

    assert [issue.identifier for issue in issues] == ["MT-1"]
    request = transport.requests[0]
    variables = request["json"]["variables"]
    assert variables["stateNames"] == ["Done"]
    assert "assigneeId" not in variables
    assert "assignee:" not in request["json"]["query"]


@pytest.mark.asyncio
async def test_fetch_candidate_issues_paginates_in_order() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node(id="1", identifier="MT-1")],
                        "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                    }
                }
            },
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node(id="2", identifier="MT-2")],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "token", transport=transport)

    issues = await client.fetch_candidate_issues(make_config())

    assert [issue.identifier for issue in issues] == ["MT-1", "MT-2"]
    assert transport.requests[1]["json"]["variables"]["after"] == "cursor-1"


@pytest.mark.asyncio
async def test_fetch_issue_state_refresh_uses_project_scope() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node(description=None, branchName=None, createdAt=None, updatedAt=None)],
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_issue_states_by_ids(["issue-1"])

    assert [issue.identifier for issue in issues] == ["MT-1"]
    request = transport.requests[0]
    variables = request["json"]["variables"]
    assert variables["ids"] == ["issue-1"]
    assert variables["projectSlug"] == "MT"
    assert "project: { slugId: { eq: $projectSlug } }" in request["json"]["query"]
    assert "$ids: [ID!]" in request["json"]["query"]


@pytest.mark.asyncio
async def test_comment_issue_uses_comment_create() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "commentCreate": {
                        "success": True,
                        "comment": {"id": "comment-1"},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    result = await tracker.comment_issue("issue-1", "done")

    assert result == {"success": True, "comment_id": "comment-1"}
    request = transport.requests[0]
    assert "commentCreate" in request["json"]["query"]
    assert request["json"]["variables"] == {"issueId": "issue-1", "body": "done"}


@pytest.mark.asyncio
async def test_transition_issue_uses_issue_update() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {
                            "id": "issue-1",
                            "identifier": "MT-1",
                            "state": {"name": "Done"},
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    result = await tracker.transition_issue("issue-1", "state-done")

    assert result == {"success": True, "issue_id": "issue-1", "identifier": "MT-1", "state": "Done"}
    request = transport.requests[0]
    assert "issueUpdate" in request["json"]["query"]
    assert request["json"]["variables"] == {"issueId": "issue-1", "stateId": "state-done"}


@pytest.mark.asyncio
async def test_set_issue_lifecycle_label_replaces_only_symphony_labels() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "team": {"id": "team-1"},
                        "labels": {
                            "nodes": [
                                {"id": "label-business", "name": "codex2"},
                                {"id": "label-old", "name": "symphony:running"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-retrying", "name": "symphony:retrying"}]
                    }
                }
            },
            {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {
                            "id": "issue-1",
                            "identifier": "MT-1",
                            "labels": {
                                "nodes": [
                                    {"id": "label-business", "name": "codex2"},
                                    {"id": "label-retrying", "name": "symphony:retrying"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    result = await tracker.set_issue_lifecycle_label("issue-1", "symphony:retrying")

    assert result == {
        "success": True,
        "issue_id": "issue-1",
        "identifier": "MT-1",
        "label": "symphony:retrying",
        "label_ids": ["label-business", "label-retrying"],
    }
    assert "issue(id: $issueId)" in transport.requests[0]["json"]["query"]
    assert transport.requests[0]["json"]["variables"] == {"issueId": "issue-1"}
    assert "issueLabels" in transport.requests[1]["json"]["query"]
    assert transport.requests[1]["json"]["variables"] == {
        "name": "symphony:retrying",
        "teamId": "team-1",
    }
    update_request = transport.requests[2]["json"]
    assert "issueUpdate" in update_request["query"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-business", "label-retrying"],
    }


@pytest.mark.asyncio
async def test_set_issue_lifecycle_label_creates_missing_label_for_issue_team() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "team": {"id": "team-1"},
                        "labels": {"nodes": [{"id": "label-business", "name": "codex"}]},
                    }
                }
            },
            {"data": {"issueLabels": {"nodes": []}}},
            {
                "data": {
                    "issueLabelCreate": {
                        "success": True,
                        "issueLabel": {"id": "label-starting", "name": "symphony:starting"},
                    }
                }
            },
            {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {
                            "id": "issue-1",
                            "identifier": "MT-1",
                            "labels": {
                                "nodes": [
                                    {"id": "label-business", "name": "codex"},
                                    {"id": "label-starting", "name": "symphony:starting"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_lifecycle_label("issue-1", "symphony:starting")

    assert result["label_ids"] == ["label-business", "label-starting"]
    create_request = transport.requests[2]["json"]
    assert "issueLabelCreate" in create_request["query"]
    assert create_request["variables"] == {"name": "symphony:starting", "teamId": "team-1"}


@pytest.mark.asyncio
async def test_empty_fetch_issues_by_states_returns_empty_without_api_call() -> None:
    transport = RecordingTransport([])
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_issues_by_states([])

    assert issues == []
    assert transport.requests == []


@pytest.mark.asyncio
async def test_linear_tracker_uses_single_configured_api_key() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_candidate_issues()

    assert [issue.identifier for issue in issues] == ["MT-1"]
    request = transport.requests[0]
    assert request["headers"]["authorization"] == "linear-token"


@pytest.mark.asyncio
async def test_graphql_errors_are_mapped() -> None:
    transport = RecordingTransport([{"errors": [{"message": "bad query"}]}])
    client = LinearClient("https://api.linear.app/graphql", "token", transport=transport)

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_graphql_errors"


@pytest.mark.asyncio
async def test_non_200_status_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=StatusTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_api_status"


@pytest.mark.asyncio
async def test_request_error_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=RequestErrorTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_api_request"


@pytest.mark.asyncio
async def test_malformed_json_payload_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=TextTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_unknown_payload"
