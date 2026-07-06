from test_linear_support import *  # noqa: F401,F403

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

async def test_ensure_issue_relation_reuses_existing_relation_from_related_side() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "task-1",
                        "identifier": "MT-1",
                        "inverseRelations": {"nodes": []},
                    }
                }
            },
            {
                "data": {
                    "issue": {
                        "id": "acceptance-1",
                        "identifier": "MT-A1",
                        "relations": {
                            "nodes": [
                                {
                                    "id": "relation-1",
                                    "type": "blocks",
                                    "relatedIssue": {"id": "task-1", "identifier": "MT-1"},
                                }
                            ]
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    relation = await client.ensure_issue_relation(
        issue_id="acceptance-1",
        related_issue_id="task-1",
        relation_type="blocks",
    )

    assert relation["id"] == "relation-1"
    assert len(transport.requests) == 2

async def test_find_acceptance_issue_preserves_blocked_by_metadata() -> None:
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
                                    "issue": {
                                        "id": "acceptance-1",
                                        "identifier": "MT-A1",
                                        "title": "Acceptance",
                                        "state": {"name": "Todo"},
                                        "labels": {"nodes": [{"name": "acceptance"}]},
                                        "comments": {"nodes": []},
                                        "inverseRelations": {
                                            "nodes": [
                                                {
                                                    "type": "blocks",
                                                    "issue": {
                                                        "id": "blocker-1",
                                                        "identifier": "MT-0",
                                                        "state": {"name": "In Progress"},
                                                    },
                                                }
                                            ]
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

    acceptance = await client.find_acceptance_issue_for(
        original_issue=Issue(id="task-1", identifier="MT-1", title="Task", state="Todo"),
        acceptance_label_name="acceptance",
    )

    assert acceptance is not None
    assert acceptance["blocked_by"] == [
        {"id": "blocker-1", "identifier": "MT-0", "state": "In Progress"}
    ]

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
                            "nodes": [{"id": "label-implementation", "name": "performer:phase/implementation"}]
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
                                        {"id": "label-implementation", "name": "performer:phase/implementation"},
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

    result = await tracker.set_issue_lifecycle_label("issue-1", "performer:phase/implementation")

    assert result == {
        "success": True,
        "issue_id": "issue-1",
        "identifier": "MT-1",
        "label": "performer:phase/implementation",
        "label_ids": ["label-business", "label-implementation"],
    }
    assert "issue(id: $issueId)" in transport.requests[0]["json"]["query"]
    assert transport.requests[0]["json"]["variables"] == {"issueId": "issue-1"}
    assert "issueLabels" in transport.requests[1]["json"]["query"]
    assert transport.requests[1]["json"]["variables"] == {
        "name": "performer:phase/implementation",
        "teamId": "team-1",
    }
    update_request = transport.requests[2]["json"]
    assert "issueUpdate" in update_request["query"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-business", "label-implementation"],
    }

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
                                {"id": "label-score", "name": "performer:score/3/4"},
                                {"id": "label-old", "name": "performer:running"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-done", "name": "performer:phase/done"}]
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
                                    {"id": "label-score", "name": "performer:score/3/4"},
                                        {"id": "label-done", "name": "performer:phase/done"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_lifecycle_label("issue-1", "performer:phase/done")

    assert result["label_ids"] == ["label-gate", "label-score", "label-done"]
    update_request = transport.requests[2]["json"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-gate", "label-score", "label-done"],
    }

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
                                {"id": "label-score", "name": "performer:score/3/4"},
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
                                    {"id": "label-score", "name": "performer:score/3/4"},
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
                                    {"id": "label-starting", "name": "performer:phase/implementation"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_lifecycle_label("issue-1", "performer:phase/implementation")

    assert result["label_ids"] == ["label-business", "label-starting"]
    create_request = transport.requests[2]["json"]
    assert "issueLabelCreate" in create_request["query"]
    assert create_request["variables"] == {"name": "performer:phase/implementation", "teamId": "team-1"}

async def test_empty_fetch_issues_by_states_returns_empty_without_api_call() -> None:
    transport = RecordingTransport([])
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)
    tracker = LinearTracker(make_config(), client=client)

    issues = await tracker.fetch_issues_by_states([])

    assert issues == []
    assert transport.requests == []

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

async def test_graphql_errors_are_mapped() -> None:
    transport = RecordingTransport([{"errors": [{"message": "bad query"}]}])
    client = LinearClient("https://api.linear.app/graphql", "token", transport=transport)

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_graphql_errors"

async def test_graphql_partial_success_uses_data_and_does_not_fail_round() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [issue_node()],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                },
                "errors": [{"message": "optional field failed"}],
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "token", transport=transport)

    issues = await client.fetch_candidate_issues(make_config())

    assert [issue.identifier for issue in issues] == ["MT-1"]

async def test_non_200_status_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=StatusTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_api_status"

async def test_request_error_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=RequestErrorTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(make_config())

    assert exc.value.code == "linear_api_request"

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
