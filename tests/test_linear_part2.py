from test_linear_support import *  # noqa: F401,F403

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
                            "issue": {"id": "pipeline-node-1", "identifier": "MT-2"},
                            "relatedIssue": {"id": "task-1", "identifier": "MT-1"},
                        },
                    }
                }
            }
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    relation = await client.create_issue_relation(
        issue_id="pipeline-node-1",
        related_issue_id="task-1",
        relation_type="blocks",
    )

    assert relation["id"] == "relation-1"
    request = transport.requests[0]["json"]
    assert "issueRelationCreate" in request["query"]
    assert request["variables"] == {
        "input": {
            "type": "blocks",
            "issueId": "pipeline-node-1",
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
                                    "issue": {"id": "pipeline-node-1", "identifier": "MT-A1"},
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
        issue_id="pipeline-node-1",
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
                        "id": "pipeline-node-1",
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
        issue_id="pipeline-node-1",
        related_issue_id="task-1",
        relation_type="blocks",
    )

    assert relation["id"] == "relation-1"
    assert len(transport.requests) == 2

async def test_update_issue_description_marker_block_preserves_user_text_and_replaces_block() -> None:
    transport = RecordingTransport(
        [
            {
                "data": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "MT-1",
                        "description": "User text\n\n<!-- BEGIN SYMPHONY PIPELINE -->\nold\n<!-- END SYMPHONY PIPELINE -->\n\nTail",
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
        "SYMPHONY PIPELINE",
        "pipeline_node_id: pipeline-node-1",
    )

    updated_description = transport.requests[1]["json"]["variables"]["description"]
    assert updated_description.startswith("User text")
    assert "old" not in updated_description
    assert "pipeline_node_id: pipeline-node-1" in updated_description
    assert updated_description.endswith("Tail")

async def test_set_issue_pipeline_label_replaces_only_pipeline_labels() -> None:
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
                                {"id": "label-old", "name": "performer:pipeline/planning"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                            "nodes": [{"id": "label-executing", "name": "performer:pipeline/executing"}]
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
                                        {"id": "label-executing", "name": "performer:pipeline/executing"},
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

    result = await tracker.set_issue_pipeline_label("issue-1", "performer:pipeline/executing")

    assert result == {
        "success": True,
        "issue_id": "issue-1",
        "identifier": "MT-1",
        "label": "performer:pipeline/executing",
        "label_ids": ["label-business", "label-executing"],
    }
    assert "issue(id: $issueId)" in transport.requests[0]["json"]["query"]
    assert transport.requests[0]["json"]["variables"] == {"issueId": "issue-1"}
    assert "issueLabels" in transport.requests[1]["json"]["query"]
    assert transport.requests[1]["json"]["variables"] == {
        "name": "performer:pipeline/executing",
        "teamId": "team-1",
    }
    update_request = transport.requests[2]["json"]
    assert "issueUpdate" in update_request["query"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-business", "label-executing"],
    }

async def test_set_issue_pipeline_label_drops_legacy_gate_and_score_labels() -> None:
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
                                {"id": "label-node", "name": "performer:type/pipeline-node"},
                                {"id": "label-human", "name": "performer:gate/pending"},
                                {"id": "label-score", "name": "performer:score/3/4"},
                                {"id": "label-old", "name": "performer:pipeline/executing"},
                            ]
                        },
                    }
                }
            },
            {
                "data": {
                    "issueLabels": {
                        "nodes": [{"id": "label-verified", "name": "performer:pipeline/verify-passed"}]
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
                                    {"id": "label-node", "name": "performer:type/pipeline-node"},
                                        {"id": "label-verified", "name": "performer:pipeline/verify-passed"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_pipeline_label("issue-1", "performer:pipeline/verify-passed")

    assert result["label_ids"] == ["label-node", "label-verified"]
    update_request = transport.requests[2]["json"]
    assert update_request["variables"] == {
        "issueId": "issue-1",
        "labelIds": ["label-node", "label-verified"],
    }

async def test_tracker_does_not_publish_generic_label_group_api() -> None:
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=RecordingTransport([]))
    tracker = LinearTracker(make_config(), client=client)

    assert not hasattr(tracker, "set_issue_label_group")

async def test_set_issue_pipeline_label_creates_missing_label_for_issue_team() -> None:
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
                                    {"id": "label-starting", "name": "performer:pipeline/executing"},
                                ]
                            },
                        },
                    }
                }
            },
        ]
    )
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=transport)

    result = await client.set_issue_pipeline_label("issue-1", "performer:pipeline/executing")

    assert result["label_ids"] == ["label-business", "label-starting"]
    create_request = transport.requests[2]["json"]
    assert "issueLabelCreate" in create_request["query"]
    assert create_request["variables"] == {"name": "performer:pipeline/executing", "teamId": "team-1"}

async def test_set_issue_pipeline_label_rejects_phase_labels() -> None:
    client = LinearClient("https://api.linear.app/graphql", "linear-token", transport=RecordingTransport([]))

    with pytest.raises(ValueError):
        await client.set_issue_pipeline_label("issue-1", "performer:phase/implementation")

async def test_graphql_errors_are_mapped() -> None:
    transport = RecordingTransport([{"errors": [{"message": "bad query"}]}])
    client = LinearClient("https://api.linear.app/graphql", "token", transport=transport)

    with pytest.raises(LinearError) as exc:
        await client.fetch_issue_states_by_ids(make_config(), ["issue-1"])

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

    issues = await client.fetch_issue_states_by_ids(make_config(), ["issue-1"])

    assert [issue.identifier for issue in issues] == ["MT-1"]

async def test_non_200_status_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=StatusTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_issue_states_by_ids(make_config(), ["issue-1"])

    assert exc.value.code == "linear_api_status"

async def test_request_error_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=RequestErrorTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_issue_states_by_ids(make_config(), ["issue-1"])

    assert exc.value.code == "linear_api_request"

async def test_malformed_json_payload_is_mapped() -> None:
    client = LinearClient("https://api.linear.app/graphql", "token", transport=TextTransport())

    with pytest.raises(LinearError) as exc:
        await client.fetch_issue_states_by_ids(make_config(), ["issue-1"])

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
