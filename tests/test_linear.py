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
async def test_fetch_issue_comments_returns_body_created_at_and_user() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "comments": {
                            "nodes": [
                                {
                                    "id": "comment-1",
                                    "body": "/symphony approve-runtime-error MT-1",
                                    "createdAt": "2026-07-02T03:30:00Z",
                                    "user": {"id": "user-1", "name": "Reviewer"},
                                }
                            ]
                        }
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    comments = await client.fetch_issue_comments("issue-1", first=10)

    assert comments == [
        {
            "id": "comment-1",
            "body": "/symphony approve-runtime-error MT-1",
            "created_at": "2026-07-02T03:30:00Z",
            "user": {"id": "user-1", "name": "Reviewer"},
        }
    ]
    request = transport.requests[0]
    assert request["json"]["variables"] == {"issueId": "issue-1", "first": 10}
    assert "comments(first: $first)" in request["json"]["query"]


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
    assert "description" in request["json"]["query"]


@pytest.mark.asyncio
async def test_fetch_issue_state_refresh_preserves_description_for_acceptance_evidence() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [
                            issue_node(
                                description=(
                                    "Implementation summary: done\n"
                                    "Test commands and exact output: pytest -q -> passed\n"
                                    "Remaining risks: none"
                                ),
                                branchName=None,
                                createdAt=None,
                                updatedAt=None,
                            )
                        ],
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_issue_states_by_ids(["issue-1"])

    assert issues[0].description == (
        "Implementation summary: done\n"
        "Test commands and exact output: pytest -q -> passed\n"
        "Remaining risks: none"
    )


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
async def test_transition_issue_by_state_name_resolves_team_state_id() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "team": {
                            "id": "team-1",
                            "states": {
                                "nodes": [
                                    {"id": "state-progress", "name": "In Progress"},
                                    {"id": "state-review", "name": "In Review"},
                                ]
                            },
                        },
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
                            "state": {"name": "In Review"},
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    result = await tracker.transition_issue_by_state_name("issue-1", "In Review")

    assert result["state"] == "In Review"
    assert "states" in transport.requests[0]["json"]["query"]
    assert transport.requests[1]["json"]["variables"] == {
        "issueId": "issue-1",
        "stateId": "state-review",
    }


@pytest.mark.asyncio
async def test_create_issue_uses_issue_create_with_labels() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "acceptance-1",
                            "identifier": "MT-2",
                            "title": "[Acceptance] MT-1",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "labels": {"nodes": [{"name": "performer:type/acceptance"}]},
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    created = await client.create_issue(
        team_id="team-1",
        project_id="project-1",
        state_id="state-todo",
        label_ids=["label-acceptance"],
        title="[Acceptance] MT-1",
        description="Review MT-1 evidence.",
    )

    assert created["id"] == "acceptance-1"
    request = transport.requests[0]["json"]
    assert "issueCreate" in request["query"]
    assert request["variables"] == {
        "teamId": "team-1",
        "projectId": "project-1",
        "stateId": "state-todo",
        "labelIds": ["label-acceptance"],
        "title": "[Acceptance] MT-1",
        "description": "Review MT-1 evidence.",
        "parentId": None,
    }


@pytest.mark.asyncio
async def test_create_issue_supports_parent_id_for_child_issues() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "gate-1",
                            "identifier": "MT-2",
                            "title": "[Gate] MT-1: Behavior",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "labels": {"nodes": [{"name": "performer:type/gate"}]},
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    created = await client.create_issue(
        team_id="team-1",
        project_id="project-1",
        state_id="state-todo",
        label_ids=["label-gate"],
        title="[Gate] MT-1: Behavior",
        description="Gate details.",
        parent_id="issue-1",
    )

    assert created["id"] == "gate-1"
    request = transport.requests[0]["json"]
    assert "parentId" in request["query"]
    assert request["variables"]["parentId"] == "issue-1"


@pytest.mark.asyncio
async def test_fetch_child_issues_returns_direct_children_filtered_by_label() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "children": {
                            "nodes": [
                                {
                                    "id": "gate-1",
                                    "identifier": "MT-2",
                                    "title": "[Gate] MT-1: Behavior",
                                    "url": "https://linear.app/x/issue/MT-2",
                                    "state": {"name": "Todo"},
                                    "labels": {"nodes": [{"name": "performer:type/gate"}]},
                                },
                                {
                                    "id": "note-1",
                                    "identifier": "MT-3",
                                    "title": "Other",
                                    "url": "https://linear.app/x/issue/MT-3",
                                    "state": {"name": "Todo"},
                                    "labels": {"nodes": [{"name": "other"}]},
                                },
                            ]
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    children = await client.fetch_child_issues("issue-1", label_name="performer:type/gate")

    assert [child["id"] for child in children] == ["gate-1"]
    request = transport.requests[0]["json"]
    assert "children" in request["query"]
    assert request["variables"] == {"issueId": "issue-1"}


@pytest.mark.asyncio
async def test_create_acceptance_issue_for_uses_original_linear_context_and_type_label() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "team": {"id": "team-1"},
                        "project": {"id": "project-1"},
                        "state": {"id": "state-todo", "name": "Todo"},
                        "labels": {"nodes": []},
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-acceptance", "name": "performer:type/acceptance"}]
                    }
                }
            },
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "acceptance-1",
                            "identifier": "MT-2",
                            "title": "[Acceptance] MT-1: Build",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "labels": {"nodes": [{"name": "performer:type/acceptance"}]},
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    created = await tracker.create_acceptance_issue_for(
        original_issue_id="issue-1",
        title="[Acceptance] MT-1: Build",
        description="Review evidence.",
        acceptance_label_name="performer:type/acceptance",
    )

    assert created["id"] == "acceptance-1"
    create_request = transport.requests[2]["json"]
    assert create_request["variables"] == {
        "teamId": "team-1",
        "projectId": "project-1",
        "stateId": "state-todo",
        "labelIds": ["label-acceptance"],
        "title": "[Acceptance] MT-1: Build",
        "description": "Review evidence.",
        "parentId": None,
    }


@pytest.mark.asyncio
async def test_find_acceptance_issue_for_reuses_inverse_blocking_relation_with_label() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "inverseRelations": {
                            "nodes": [
                                {
                                    "type": "blocks",
                                    "issue": {
                                        "id": "acceptance-1",
                                        "identifier": "MT-A1",
                                        "title": "[Acceptance] MT-1: Build",
                                        "url": "https://linear.app/x/issue/MT-A1",
                                        "state": {"name": "Todo"},
                                        "labels": {
                                            "nodes": [{"name": "performer:type/acceptance"}]
                                        },
                                    },
                                }
                            ]
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    found = await tracker.find_acceptance_issue_for(
        original_issue=Issue(id="issue-1", identifier="MT-1", title="Build it", state="Todo", project_slug="MT"),
        acceptance_label_name="performer:type/acceptance",
    )

    assert found is not None
    assert found["id"] == "acceptance-1"
    assert found["identifier"] == "MT-A1"
    assert "inverseRelations" in transport.requests[0]["json"]["query"]


@pytest.mark.asyncio
async def test_create_issue_relation_uses_blocks_relation() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueRelationCreate": {
                        "success": True,
                        "issueRelation": {
                            "id": "relation-1",
                            "type": "blocks",
                            "issue": {"id": "acceptance-1", "identifier": "MT-2"},
                            "relatedIssue": {"id": "task-1", "identifier": "MT-1"},
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    relation = await client.create_issue_relation(
        issue_id="acceptance-1",
        related_issue_id="task-1",
        relation_type="blocks",
    )

    assert relation["id"] == "relation-1"
    request = transport.requests[0]["json"]
    assert "issueRelationCreate" in request["query"]
    assert request["variables"] == {
        "input": {
            "type": "blocks",
            "issueId": "acceptance-1",
            "relatedIssueId": "task-1",
        }
    }


@pytest.mark.asyncio
async def test_ensure_issue_relation_reuses_existing_blocks_relation() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "task-1",
                        "identifier": "MT-1",
                        "inverseRelations": {
                            "nodes": [
                                {
                                    "id": "relation-1",
                                    "type": "blocks",
                                    "issue": {"id": "acceptance-1", "identifier": "MT-A1"},
                                }
                            ]
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    relation = await client.ensure_issue_relation(
        issue_id="acceptance-1",
        related_issue_id="task-1",
        relation_type="blocks",
    )

    assert relation["id"] == "relation-1"
    assert len(transport.requests) == 1


@pytest.mark.asyncio
async def test_update_issue_description_marker_block_preserves_user_text_and_replaces_block() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "description": "User text\n\n<!-- BEGIN PERFORMER ACCEPTANCE -->\nold\n<!-- END PERFORMER ACCEPTANCE -->\n\nTail",
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
                            "description": "updated",
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    await client.update_issue_description_marker_block(
        "issue-1",
        "PERFORMER ACCEPTANCE",
        "acceptance_issue_id: acceptance-1",
    )

    updated_description = transport.requests[1]["json"]["variables"]["description"]
    assert updated_description.startswith("User text")
    assert "old" not in updated_description
    assert "acceptance_issue_id: acceptance-1" in updated_description
    assert updated_description.endswith("Tail")


@pytest.mark.asyncio
async def test_set_issue_lifecycle_label_replaces_only_performer_labels() -> None:
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
                                {"id": "label-old", "name": "performer:running"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-retrying", "name": "performer:retrying"}]
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
                                    {"id": "label-retrying", "name": "performer:retrying"},
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

    result = await tracker.set_issue_lifecycle_label("issue-1", "performer:retrying")

    assert result == {
        "success": True,
        "issue_id": "issue-1",
        "identifier": "MT-1",
        "label": "performer:retrying",
        "label_ids": ["label-business", "label-retrying"],
    }
    assert "issue(id: $issueId)" in transport.requests[0]["json"]["query"]
    assert transport.requests[0]["json"]["variables"] == {"issueId": "issue-1"}
    assert "issueLabels" in transport.requests[1]["json"]["query"]
    assert transport.requests[1]["json"]["variables"] == {
        "name": "performer:retrying",
        "teamId": "team-1",
    }
    update_request = transport.requests[2]["json"]
    assert "issueUpdate" in update_request["query"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-business", "label-retrying"],
    }


@pytest.mark.asyncio
async def test_set_issue_lifecycle_label_preserves_type_gate_and_score_labels() -> None:
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
                                {"id": "label-task", "name": "performer:type/task"},
                                {"id": "label-gate", "name": "performer:gate/pending"},
                                {"id": "label-score", "name": "performer:score/3"},
                                {"id": "label-old", "name": "performer:running"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-done", "name": "performer:done"}]
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
                                    {"id": "label-task", "name": "performer:type/task"},
                                    {"id": "label-gate", "name": "performer:gate/pending"},
                                    {"id": "label-score", "name": "performer:score/3"},
                                    {"id": "label-done", "name": "performer:done"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_lifecycle_label("issue-1", "performer:done")

    assert result["label_ids"] == ["label-task", "label-gate", "label-score", "label-done"]
    update_request = transport.requests[2]["json"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-task", "label-gate", "label-score", "label-done"],
    }


@pytest.mark.asyncio
async def test_set_issue_label_group_replaces_only_matching_prefix() -> None:
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
                                {"id": "label-done", "name": "performer:done"},
                                {"id": "label-old-gate", "name": "performer:gate/pending"},
                                {"id": "label-score", "name": "performer:score/3"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-passed", "name": "performer:gate/passed"}]
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
                                    {"id": "label-done", "name": "performer:done"},
                                    {"id": "label-score", "name": "performer:score/3"},
                                    {"id": "label-passed", "name": "performer:gate/passed"},
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

    result = await tracker.set_issue_label_group("issue-1", "performer:gate/passed", prefix="performer:gate/")

    assert result["label_ids"] == ["label-business", "label-done", "label-score", "label-passed"]
    update_request = transport.requests[2]["json"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-business", "label-done", "label-score", "label-passed"],
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
                        "issueLabel": {"id": "label-starting", "name": "performer:starting"},
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
                                    {"id": "label-starting", "name": "performer:starting"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_lifecycle_label("issue-1", "performer:starting")

    assert result["label_ids"] == ["label-business", "label-starting"]
    create_request = transport.requests[2]["json"]
    assert "issueLabelCreate" in create_request["query"]
    assert create_request["variables"] == {"name": "performer:starting", "teamId": "team-1"}


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


def test_linear_milestone_comment_includes_turns_tokens_cost_and_debug_url() -> None:
    detail = {
        "issue_identifier": "ENG-1",
        "latest_run": {"turn_count": 7, "total_tokens": 188240, "estimated_cost_usd": 0.97},
        "state_explanation": "Stalled because no Codex output arrived for 14 minutes after a tool timeout.",
    }

    comment = format_linear_milestone_comment(
        detail,
        event_type="stalled",
        debug_url="http://localhost:8801/issues/ENG-1",
    )

    assert "Turns: 7" in comment
    assert "Tokens: 188240" in comment
    assert "Cost: $0.97" in comment
    assert "Reason: Stalled because no Codex output arrived" in comment
    assert "http://localhost:8801/issues/ENG-1" in comment
