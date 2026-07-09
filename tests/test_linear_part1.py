from test_linear_support import *  # noqa: F401,F403

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

async def test_fetch_issue_state_refresh_preserves_description_for_node_evidence() -> None:
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


async def test_update_issue_comment_marker_block_creates_then_updates_comment() -> None:
    transport = RecordingTransport(
        [
            {"data": {"issue": {"comments": {"nodes": []}}}},
            {
                "data": {
                    "commentCreate": {
                        "success": True,
                        "comment": {"id": "comment-1", "body": "created"},
                    }
                }
            },
            {
                "data": {
                    "issue": {
                        "comments": {
                            "nodes": [
                                {
                                    "id": "comment-1",
                                    "body": "<!-- BEGIN SYMPHONY STATUS -->\nold\n<!-- END SYMPHONY STATUS -->",
                                }
                            ]
                        }
                    }
                }
            },
            {
                "data": {
                    "commentUpdate": {
                        "success": True,
                        "comment": {"id": "comment-1", "body": "updated"},
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    created = await tracker.update_issue_comment_marker_block("issue-1", "SYMPHONY STATUS", "first body")
    updated = await tracker.update_issue_comment_marker_block("issue-1", "SYMPHONY STATUS", "second body")

    assert created["comment_id"] == "comment-1"
    assert updated["comment_id"] == "comment-1"
    assert "commentCreate" in transport.requests[1]["json"]["query"]
    assert "commentUpdate" in transport.requests[3]["json"]["query"]
    assert "second body" in transport.requests[3]["json"]["variables"]["body"]


async def test_agent_activity_create_uses_agent_session_mutation() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "agentActivityCreate": {
                        "success": True,
                        "agentActivity": {"id": "activity-1"},
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    result = await tracker.agent_activity_create(
        agent_session_id="session-1",
        content={"type": "thought", "body": "running execute"},
    )

    assert result == {"success": True, "activity_id": "activity-1"}
    request = transport.requests[0]
    assert "agentActivityCreate" in request["json"]["query"]
    assert "AgentActivityCreateInput" in request["json"]["query"]
    assert request["json"]["variables"] == {
        "input": {
            "agentSessionId": "session-1",
            "content": {"type": "thought", "body": "running execute"},
        }
    }

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

async def test_create_issue_uses_issue_create_with_labels() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "pipeline-node-1",
                            "identifier": "MT-2",
                            "title": "[Work Item] MT-1",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "labels": {"nodes": [{"name": "symphony:type/work-item"}]},
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
        label_ids=["label-node"],
        title="[Work Item] MT-1",
        description="Review MT-1 evidence.",
    )

    assert created["id"] == "pipeline-node-1"
    request = transport.requests[0]["json"]
    assert "issueCreate" in request["query"]
    assert request["variables"] == {
        "teamId": "team-1",
        "projectId": "project-1",
        "stateId": "state-todo",
        "labelIds": ["label-node"],
        "title": "[Work Item] MT-1",
        "description": "Review MT-1 evidence.",
        "parentId": None,
        "assigneeId": None,
        "delegateId": None,
    }

async def test_create_issue_supports_parent_id_for_child_issues() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "human-action-1",
                            "identifier": "MT-2",
                            "title": "[Human Action] MT-1: Behavior",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "labels": {"nodes": [{"name": "performer:type/human-action"}]},
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
        label_ids=["label-human"],
        title="[Human Action] MT-1: Behavior",
        description="Human action details.",
        parent_id="issue-1",
        assignee_id="human-1",
    )

    assert created["id"] == "human-action-1"
    request = transport.requests[0]["json"]
    assert "parentId" in request["query"]
    assert "assigneeId" in request["query"]
    assert request["variables"]["parentId"] == "issue-1"
    assert request["variables"]["assigneeId"] == "human-1"

async def test_create_issue_updates_delegate_when_create_does_not_apply_delegate() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {
                            "id": "human-action-1",
                            "identifier": "MT-2",
                            "title": "[Human Action] MT-1: Behavior",
                            "url": "https://linear.app/x/issue/MT-2",
                            "state": {"name": "Todo"},
                            "delegate": None,
                            "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                        },
                    }
                }
            },
            {
                "data": {
                    "issueUpdate": {
                        "success": True,
                        "issue": {
                            "id": "human-action-1",
                            "identifier": "MT-2",
                            "delegate": {"id": "agent-user-1"},
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    created = await client.create_issue(
        team_id="team-1",
        project_id="project-1",
        state_id="state-todo",
        label_ids=["label-human"],
        title="[Human Action] MT-1: Behavior",
        description="Human action details.",
        parent_id="issue-1",
        delegate_id="agent-user-1",
    )

    assert created["delegate"]["id"] == "agent-user-1"
    assert "issueCreate" in transport.requests[0]["json"]["query"]
    update_request = transport.requests[1]["json"]
    assert "issueUpdate" in update_request["query"]
    assert update_request["variables"] == {
        "issueId": "human-action-1",
        "delegateId": "agent-user-1",
    }

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
                                    "id": "human-action-1",
                                    "identifier": "MT-2",
                                    "title": "[Human Action] MT-1: Behavior",
                                    "description": "Human response:\nApproved",
                                    "url": "https://linear.app/x/issue/MT-2",
                                    "state": {"name": "Todo"},
                                    "assignee": {"id": "human-1"},
                                    "delegate": {"id": "agent-user-1"},
                                    "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "comment-1",
                                                "body": "Looks good",
                                                "createdAt": "2026-07-02T03:30:00Z",
                                                "user": {"id": "human-1", "name": "Human"},
                                            }
                                        ]
                                    },
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

    children = await client.fetch_child_issues("issue-1", label_name="performer:type/human-action")

    assert [child["id"] for child in children] == ["human-action-1"]
    assert children[0]["description"] == "Human response:\nApproved"
    assert children[0]["assignee_id"] == "human-1"
    assert children[0]["delegate_id"] == "agent-user-1"
    assert children[0]["comments"][0]["body"] == "Looks good"
    request = transport.requests[0]["json"]
    assert "children" in request["query"]
    assert request["variables"] == {"issueId": "issue-1", "childrenAfter": None, "commentsAfter": None}

async def test_fetch_child_issues_paginates_children_and_comments() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "children": {
                            "pageInfo": {"hasNextPage": True, "endCursor": "child-cursor-1"},
                            "nodes": [
                                {
                                    "id": "human-action-1",
                                    "identifier": "MT-2",
                                    "title": "Human action 1",
                                    "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                                    "comments": {
                                        "pageInfo": {"hasNextPage": True, "endCursor": "comment-cursor-1"},
                                        "nodes": [{"id": "comment-1", "body": "first"}],
                                    },
                                }
                            ],
                        },
                    }
                }
            },
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "children": {
                            "pageInfo": {"hasNextPage": True, "endCursor": "child-cursor-1"},
                            "nodes": [
                                {
                                    "id": "human-action-1",
                                    "identifier": "MT-2",
                                    "title": "Human action 1",
                                    "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                                    "comments": {
                                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                                        "nodes": [{"id": "comment-2", "body": "second"}],
                                    },
                                }
                            ],
                        },
                    }
                }
            },
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "children": {
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                            "nodes": [
                                {
                                    "id": "gate-2",
                                    "identifier": "MT-3",
                                    "title": "Human action 2",
                                    "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                                    "comments": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []},
                                }
                            ],
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    children = await client.fetch_child_issues("issue-1", label_name="performer:type/human-action")

    assert [child["id"] for child in children] == ["human-action-1", "gate-2"]
    assert [comment["body"] for comment in children[0]["comments"]] == ["first", "second"]
    assert transport.requests[0]["json"]["variables"]["childrenAfter"] is None
    assert transport.requests[1]["json"]["variables"]["commentsAfter"] == "comment-cursor-1"
    assert transport.requests[2]["json"]["variables"]["childrenAfter"] == "child-cursor-1"
