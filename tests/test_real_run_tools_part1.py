from test_real_run_tools_support import *  # noqa: F401,F403

def test_runtime_claims_audit_flags_errorless_retry_and_claim_stall() -> None:
    tool = load_tool("runtime_claims_audit")

    result = tool.audit_runtime_state(
        {
            "sessions": [],
            "retry_attempts": [
                {
                    "issue_id": "issue-1",
                    "identifier": "HELL-1",
                    "attempt": 2,
                    "error": None,
                    "status_label": "performer:pipeline/verify-passed",
                }
            ],
            "continuations": [],
        },
        "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
    )

    assert result["pass"] is False
    assert "retry_without_error:HELL-1" in result["failures"]
    assert "log_repeated_running_0_claimed_positive" in result["failures"]

def test_runtime_claims_audit_allows_blocked_human_approval_state() -> None:
    tool = load_tool("runtime_claims_audit")

    result = tool.audit_runtime_state(
        {
            "sessions": [],
            "retry_attempts": [],
            "continuations": [],
            "blocked": [
                {
                    "issue_id": "issue-1",
                    "identifier": "HELL-1",
                    "attempt": 2,
                    "error": "runtime_permission_blocked: writing outside of the project",
                    "status_label": "performer:pipeline/awaiting-human",
                }
            ],
        },
        "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
    )

    assert result["pass"] is True
    assert result["counts"]["blocked"] == 1
    assert result["blocked"][0]["identifier"] == "HELL-1"

def test_linear_tree_audit_requires_pipeline_projection_metadata() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "state": {"name": "In Review", "type": "started"},
            "labels": {"nodes": [{"name": "performer:type/task"}]},
            "children": {
                "nodes": [
                    {
                        "id": "node-1",
                        "identifier": "HELL-2",
                        "title": "Pipeline node",
                        "description": "```yaml\nsymphony:\n  graph_id: graph-1\n  node_id: node-1\n```\n",
                        "parent": {"id": "other", "identifier": "HELL-X"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": [{"name": "performer:type/pipeline-node"}]},
                        "children": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": [{"id": "rel-1", "type": "blocks"}]},
        }
    )

    assert result["pass"] is False
    assert "pipeline_node_parent_mismatch:HELL-2" in result["failures"]
    assert (
        "pipeline_metadata_missing:HELL-2:plan_attempt_id,gate_snapshot_hash,conductor_revision,operator_status"
        in result["failures"]
    )
    assert "frozen_gate_missing:HELL-2" in result["failures"]


def test_linear_tree_audit_requires_runtime_wait_projection_details() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "state": {"name": "In Progress", "type": "started"},
            "labels": {"nodes": []},
            "children": {
                "nodes": [
                    {
                        "id": "node-1",
                        "identifier": "HELL-2",
                        "title": "Pipeline node",
                        "description": "\n".join(
                            [
                                "```yaml",
                                "symphony:",
                                "  graph_id: graph-1",
                                "  node_id: node-1",
                                "  plan_attempt_id: plan-1",
                                "  gate_snapshot_hash: sha256:gate",
                                "  conductor_revision: 1",
                                "  operator_status: waiting_for_runtime_input",
                                "```",
                                "",
                                "### Frozen Gate",
                            ]
                        ),
                        "parent": {"id": "business-1", "identifier": "HELL-1"},
                        "state": {"name": "In Progress", "type": "started"},
                        "labels": {"nodes": [{"name": "performer:type/pipeline-node"}]},
                        "children": {"nodes": []},
                        "inverseRelations": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": []},
        }
    )

    assert result["pass"] is False
    assert "pipeline_runtime_wait_kind_missing:HELL-2" in result["failures"]
    assert "pipeline_runtime_wait_block_missing:HELL-2" in result["failures"]

def test_linear_tree_audit_summarizes_children_and_blocks_relations() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.summarize_tree(
        {
            "id": "parent-1",
            "identifier": "HELL-1",
            "title": "Parent",
            "state": {"name": "Todo", "type": "unstarted"},
            "labels": {"nodes": []},
            "children": {
                "nodes": [
                    {
                        "id": "child-a",
                        "identifier": "HELL-2",
                        "title": "Child A",
                        "parent": {"id": "parent-1", "identifier": "HELL-1"},
                        "state": {"name": "Done", "type": "completed"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                    },
                    {
                        "id": "child-c",
                        "identifier": "HELL-3",
                        "title": "Child C",
                        "parent": {"id": "parent-1", "identifier": "HELL-1"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                        "inverseRelations": {
                            "nodes": [
                                {
                                    "id": "rel-1",
                                    "type": "blocks",
                                    "issue": {"id": "child-a", "identifier": "HELL-2", "title": "Child A"},
                                    "relatedIssue": {"id": "child-c", "identifier": "HELL-3", "title": "Child C"},
                                }
                            ]
                        },
                    },
                ]
            },
            "inverseRelations": {"nodes": []},
        }
    )

    assert result["business_issue"]["id"] == "parent-1"
    assert [child["id"] for child in result["children"]] == ["child-a", "child-c"]
    assert result["blocks_relations"] == [
        {
            "id": "rel-1",
            "type": "blocks",
            "issue": {"id": "child-a", "identifier": "HELL-2", "title": "Child A"},
            "relatedIssue": {"id": "child-c", "identifier": "HELL-3", "title": "Child C"},
            "scope": "child",
        }
    ]


@pytest.mark.asyncio
async def test_real_e2e_linear_project_lookup_falls_back_from_slug_to_name(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_linear")
    calls: list[dict[str, object]] = []

    async def fake_graphql(token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        if "filter: { slugId" in query:
            return {"projects": {"nodes": []}}
        return {
            "projects": {
                "nodes": [
                    {
                        "id": "project-1",
                        "name": "HELL",
                        "slugId": "8ab43179fb54",
                        "teams": {"nodes": [{"id": "team-1", "key": "HELL", "name": "Hallucination"}]},
                    }
                ]
            }
        }

    monkeypatch.setattr(tool, "linear_graphql", fake_graphql)

    project = await tool.resolve_project("token", "HELL")

    assert project["id"] == "project-1"
    assert [call["variables"] for call in calls] == [{"project": "HELL"}, {"project": "HELL"}]

async def test_real_symphony_e2e_create_issue_accepts_parent_id(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[dict[str, object]] = []

    async def fake_linear_graphql(_token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        if "query Project" in query:
            return {
                "projects": {
                    "nodes": [
                        {
                            "id": "project-1",
                            "name": "HELL",
                            "slugId": "HELL",
                            "teams": {"nodes": [{"id": "team-1", "key": "HELL", "name": "HELL"}]},
                        }
                    ]
                }
            }
        if "query States" in query:
            return {"workflowStates": {"nodes": [{"id": "state-1", "name": "Todo", "type": "unstarted"}]}}
        if "mutation CreateIssue" in query:
            return {
                "issueCreate": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "HELL-1",
                        "title": "Child",
                        "url": "https://linear.app/x/issue/HELL-1",
                        "state": {"name": "Todo", "type": "unstarted"},
                        "assignee": None,
                        "delegate": None,
                        "agentSessions": {"nodes": []},
                        "labels": {"nodes": []},
                        "parent": {"id": "parent-1", "identifier": "HELL-0"},
                    }
                }
            }
        raise AssertionError(query)

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    result = await tool.create_linear_issue("token", "HELL", "run-1", parent_id="parent-1")

    create_call = calls[-1]
    assert create_call["variables"]["input"]["parentId"] == "parent-1"
    assert result["issue"]["parent"]["id"] == "parent-1"

def test_real_symphony_e2e_pushes_runtime_config_before_agent_webhook() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    config_index = source.index('"/api/v1/runtime/config"')
    webhook_index = source.index('"/api/v1/linear/webhooks/agent-session"')

    assert config_index < webhook_index
    assert "build_runtime_config_payload" in source
    assert "runtime-config:podium-pushed" in source


def test_real_symphony_e2e_runtime_config_uses_explicit_codex_home_source() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=7,
        codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
    )

    assert payload["version"] == 7
    for profile in payload["profiles"].values():
        assert profile["settings"]["codex_home_source"] == "$SYMPHONY_E2E_CODEX_HOME_SOURCE"
        assert "model" not in profile["settings"]
        assert "auth.json" not in str(profile)


def test_real_symphony_e2e_runtime_config_model_is_explicit_override_only(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    monkeypatch.delenv("SYMPHONY_E2E_CODEX_MODEL", raising=False)

    inherited = tool.build_runtime_config_payload(runtime_group_id="group-1", version=1)
    explicit = tool.build_runtime_config_payload(runtime_group_id="group-1", version=1, model="gpt-5.5")

    assert all("model" not in profile["settings"] for profile in inherited["profiles"].values())
    assert all(profile["settings"]["model"] == "gpt-5.5" for profile in explicit["profiles"].values())


def test_real_symphony_e2e_runtime_config_carries_codex_execution_settings() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=7,
        codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
        codex_settings={"hard_turn_timeout_ms": 120000, "config_overrides": ["model_provider=custom"]},
    )

    for profile in payload["profiles"].values():
        assert profile["settings"]["hard_turn_timeout_ms"] == 120000
        assert profile["settings"]["config_overrides"] == ["model_provider=custom"]


def test_real_symphony_e2e_defaults_to_bounded_codex_turn_timeout() -> None:
    tool = load_tool("real_symphony_e2e_run")
    entry = load_tool("real_symphony_e2e")
    args = entry.parser().parse_args([])

    settings = tool._codex_settings_from_args(args)

    assert settings["hard_turn_timeout_ms"] == 180000


def test_real_symphony_e2e_cli_rejects_codex_home_source_override() -> None:
    tool = load_tool("real_symphony_e2e")

    with pytest.raises(SystemExit):
        tool.parser().parse_args(["--codex-home-source", "~/.codex"])


def test_real_symphony_e2e_run_does_not_default_to_user_codex_home() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert 'Path.home() / ".codex"' not in source
    assert "args.codex_home_source" not in source


def test_real_symphony_e2e_rejects_direct_user_codex_home_seed(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    home = tmp_path / "home"
    source = home / ".codex"
    source.mkdir(parents=True)
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    with pytest.raises(RuntimeError, match="default user .codex"):
        tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")


def test_real_symphony_e2e_stages_codex_home_source_before_injection(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    source = tmp_path / "user-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    (source / "history.jsonl").write_text("do not copy\n", encoding="utf-8")
    (source / "sessions").mkdir()
    (source / "sessions" / "session.jsonl").write_text("do not copy\n", encoding="utf-8")

    staged = tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")

    assert staged == tmp_path / "run" / "codex-home-source"
    assert (staged / "config.toml").is_file()
    assert (staged / "auth.json").is_file()
    assert not (staged / "history.jsonl").exists()
    assert not (staged / "sessions").exists()


def test_real_symphony_e2e_sanitizes_codex_config_template(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    source = tmp_path / "user-codex"
    source.mkdir()
    (source / "config.toml").write_text(
        '\n'.join(
            [
                'model_provider = "custom"',
                'model = "gpt-5.5"',
                'notify = ["/Applications/Codex.app"]',
                '',
                '[model_providers.custom]',
                'name = "custom"',
                'base_url = "http://127.0.0.1:8080"',
                '',
                '[sandbox_workspace_write]',
                'network_access = true',
                '',
                '[projects."/Users/murphy/code/github/symphony"]',
                'trust_level = "trusted"',
                '',
                '[mcp_servers.node_repl.env]',
                'CODEX_HOME = "/Users/murphy/.codex"',
                'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
                '',
                '[plugins."browser@openai-bundled"]',
                'enabled = true',
                '',
            ]
        ),
        encoding="utf-8",
    )
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    staged = tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")

    config = (staged / "config.toml").read_text(encoding="utf-8")
    assert 'model_provider = "custom"' in config
    assert "[model_providers.custom]" in config
    assert "[sandbox_workspace_write]" in config
    assert "CODEX_HOME" not in config
    assert "BROWSER_USE" not in config
    assert "mcp_servers" not in config
    assert "plugins." not in config
    assert "projects." not in config
    assert "notify" not in config


def test_real_symphony_e2e_does_not_artifact_codex_home_source() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert 'artifact("codex_home_source"' not in source
    assert "staged_path=" not in source
    assert "runtime-config:codex-home-source-staged" in source


async def test_real_symphony_e2e_create_blocks_relation_uses_blocker_as_issue(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[dict[str, object]] = []

    async def fake_linear_graphql(_token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        return {
            "issueRelationCreate": {
                "success": True,
                "issueRelation": {
                    "id": "rel-1",
                    "type": "blocks",
                    "issue": {"id": "blocker-1", "identifier": "HELL-2"},
                    "relatedIssue": {"id": "blocked-1", "identifier": "HELL-3"},
                },
            }
        }

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    relation = await tool.create_linear_blocks_relation("token", "blocker-1", "blocked-1")

    assert relation["id"] == "rel-1"
    assert "issueRelationCreate" in calls[0]["query"]
    assert calls[0]["variables"] == {
        "input": {
            "issueId": "blocker-1",
            "relatedIssueId": "blocked-1",
            "type": "blocks",
        }
    }

def test_real_concurrent_schedule_probe_assertions_pass_for_expected_timeline() -> None:
    tool = load_tool("real_concurrent_schedule_probe")
    report = {"checks": [], "failures": []}
    timeline = [
        {
            "tick": 1,
            "background": {"blocked_waiting": 1},
            "started_this_tick": [{"issue_id": "A"}, {"issue_id": "B"}],
            "nodes": [
                {"issue_id": "A", "state": "executing", "is_dispatchable": True},
                {"issue_id": "B", "state": "executing", "is_dispatchable": True},
                {"issue_id": "C", "state": "planned", "is_dispatchable": False},
            ],
        },
        {
            "tick": 2,
            "background": {"blocked_waiting": 1},
            "started_this_tick": [],
            "nodes": [
                {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "C", "state": "ready", "is_dispatchable": True},
            ],
        },
        {
            "tick": 3,
            "background": {"blocked_waiting": 0},
            "started_this_tick": [{"issue_id": "C"}],
            "nodes": [
                {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "C", "state": "executing", "is_dispatchable": True},
            ],
        },
    ]

    tool._assert_schedule(
        report=report,
        timeline=timeline,
        runtime_started=[{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
        child_a_id="A",
        child_b_id="B",
        child_c_id="C",
        global_capacity=3,
    )

    assert [check["passed"] for check in report["checks"]] == [True, True, True, True, True]
    assert report["failures"] == []

def test_real_concurrent_schedule_probe_assertions_fail_when_blocked_child_starts_early() -> None:
    tool = load_tool("real_concurrent_schedule_probe")
    report = {"checks": [], "failures": []}

    tool._assert_schedule(
        report=report,
        timeline=[
            {
                "tick": 1,
                "background": {"blocked_waiting": 0},
                "started_this_tick": [{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
                "nodes": [
                    {"issue_id": "A", "state": "executing", "is_dispatchable": True},
                    {"issue_id": "B", "state": "executing", "is_dispatchable": True},
                    {"issue_id": "C", "state": "executing", "is_dispatchable": True},
                ],
            },
            {
                "tick": 2,
                "background": {"blocked_waiting": 0},
                "started_this_tick": [],
                "nodes": [
                    {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                    {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                    {"issue_id": "C", "state": "verify_passed", "is_dispatchable": True},
                ],
            },
        ],
        runtime_started=[{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
        child_a_id="A",
        child_b_id="B",
        child_c_id="C",
        global_capacity=3,
    )

    failed = {check["name"] for check in report["failures"]}
    assert "dependency-gate:C-waits-before-A-terminal" in failed
    assert "capacity-non-cause:C-waits-with-capacity-available" in failed

async def test_real_concurrent_schedule_probe_noop_pipeline_ingress_returns_zero() -> None:
    tool = load_tool("real_concurrent_schedule_probe")

    assert await tool.NoopPipelineIngress().poll() == 0

def test_real_run_observer_diagnoses_missing_pipeline_metadata() -> None:
    observer = load_tool("real_run_observer")

    findings = observer.diagnose(
        {
            "business_issue": {
                "identifier": "HELL-1",
                "state": "In Progress",
                "labels": ["performer:type/task"],
            },
            "failures": [],
        },
        {"failures": []},
    )

    assert findings == ["linear_tree:missing_pipeline_metadata"]

def test_real_run_observer_cli_uses_pipeline_sample_flag() -> None:
    observer = load_tool("real_run_observer")
    parser = observer.parser()

    args = parser.parse_args(["--issue", "HELL-1", "--instance-root", "/tmp/inst", "--single-sample"])

    assert args.single_sample is True
    with pytest.raises(SystemExit):
        parser.parse_args(["--issue", "HELL-1", "--instance-root", "/tmp/inst", "--once"])

def test_real_symphony_e2e_common_has_no_workflow_patch_helpers() -> None:
    tool = load_tool("real_symphony_e2e")

    assert not hasattr(tool, "patch_workflow")
    assert not hasattr(tool, "patch_e2e_gate_mode")

def test_real_symphony_e2e_simulated_webhook_sets_issue_delegate() -> None:
    tool = load_tool("real_symphony_e2e")
    linear = {
        "issue": {
            "id": "issue-1",
            "identifier": "AI-1",
            "assignee": None,
            "delegate": None,
            "agentSessions": {"nodes": []},
        },
        "project": {"slugId": "AI"},
    }

    payload = tool.build_agent_session_webhook_payload(
        linear=linear,
        workspace_id="workspace-1",
        agent_app_user_id="agent-1",
        simulate_agent_webhook=True,
    )

    issue = payload["agentSession"]["issue"]
    assert issue["delegate"] == {"id": "agent-1"}
    assert payload["agentSession"]["appUserId"] == "agent-1"

def test_real_symphony_e2e_simulated_instance_payload_does_not_require_real_delegate() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_instance_payload(
        run_id="run-1",
        fixture=Path("/tmp/fixture"),
        project_slug="AI",
        agent_app_user_id="agent-1",
        pipeline_gates=False,
        simulate_agent_webhook=True,
    )

    assert payload["linear_filters"] == {}
    assert payload["pipeline_profile"] == "default"
    assert "workflow_profile" not in payload
    assert "workflow_inputs" not in payload

def test_real_symphony_e2e_real_instance_payload_requires_delegate() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_instance_payload(
        run_id="run-1",
        fixture=Path("/tmp/fixture"),
        project_slug="AI",
        agent_app_user_id="agent-1",
        pipeline_gates=True,
        simulate_agent_webhook=False,
    )

    assert payload["linear_filters"] == {
        "linear_agent_app_user_id": "agent-1",
    }
    assert payload["pipeline_profile"] == "gated-task"
    assert "workflow_profile" not in payload
    assert "workflow_inputs" not in payload

def test_real_symphony_e2e_run_no_longer_patches_workflow_content() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")
    common_source = (ROOT / "tools" / "real_symphony_e2e_common.py").read_text(encoding="utf-8")

    assert "patch_workflow" not in source
    assert "patch_workflow" not in common_source
    assert "patch_e2e_gate_mode" not in common_source
    assert "workflow_content" not in source
    assert '["workflow_path"]' not in source
    assert "workflow_path" not in source


def test_real_symphony_e2e_run_uses_pipeline_view_not_legacy_runs_or_gate_children() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert '"/api/pipeline"' in source
    assert '"/api/runs"' not in source
    assert '"/api/runs/' not in source
    assert "pipeline_runs" not in source
    assert "phase_terminal" not in source
    assert "performer:type/gate" not in source
    assert "performer:type/evidence" not in source


def test_real_symphony_e2e_enrolls_runtime_with_resolved_project_slug() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    resolve_index = source.index("linear_project = await resolve_project")
    enrollment_index = source.index('"/api/v1/runtime/enrollment-tokens"')
    enrollment_payload_start = source.index('"runtime_group_id": f"group-{run_id}"')
    enrollment_payload_end = source.index('"pipeline_profile": "gated-task"')
    enrollment_payload = source[enrollment_payload_start:enrollment_payload_end]

    assert resolve_index < enrollment_index
    assert '"project_slug": linear_project["slugId"]' in enrollment_payload
    assert '"project_slug": args.project_slug' not in enrollment_payload
    assert "performer:gate/passed" not in source

async def test_real_symphony_e2e_waits_for_delegate_visibility_before_webhook(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    seen = [
        {"id": "issue-1", "delegate": None, "agentSessions": {"nodes": []}},
        {"id": "issue-1", "delegate": {"id": "agent-1"}, "agentSessions": {"nodes": []}},
    ]

    async def fake_fetch(_token: str, _issue_id: str) -> dict[str, object]:
        return seen.pop(0)

    monkeypatch.setattr(tool, "fetch_linear_issue", fake_fetch)

    issue = await tool.wait_for_linear_delegate_visible(
        "token",
        "issue-1",
        "agent-1",
        timeout_seconds=1,
        poll_seconds=0,
    )

    assert issue["delegate"] == {"id": "agent-1"}
    assert seen == []

def test_real_symphony_e2e_evidence_redacts_tokens(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "evidence.json")

    evidence.check(
        "token-check",
        True,
        body={
            "enrollment_token": "secret-enrollment",
            "runtime_token": "secret-runtime",
            "nested": {"proxy_token": "secret-proxy"},
        },
    )

    text = (tmp_path / "evidence.json").read_text(encoding="utf-8")
    assert "secret-enrollment" not in text
    assert "secret-runtime" not in text
    assert "secret-proxy" not in text
    assert '"enrollment_token": "<redacted>"' in text
    assert '"runtime_token": "<redacted>"' in text
    assert '"proxy_token": "<redacted>"' in text

def test_real_run_evidence_bundle_copies_codex_overload_probe(tmp_path: Path) -> None:
    tool = load_tool("real_run_evidence_bundle")
    instance_root = tmp_path / "instances" / "inst-1"
    (instance_root / "state").mkdir(parents=True)
    (instance_root / "logs").mkdir(parents=True)
    (instance_root / "state" / "performer.json").write_text("{}", encoding="utf-8")
    (instance_root / "logs" / "performer.log").write_text("", encoding="utf-8")
    probe = tmp_path / "codex-overload-probe.json"
    probe.write_text('{"pass": true, "overload_retry_count": 1}', encoding="utf-8")

    manifest = tool.bundle(
        type(
            "Args",
            (),
            {
                "instance_root": instance_root,
                "out": tmp_path / "bundle",
                "business_issue": None,
                "linear_tree": None,
                "observer": None,
                "cleanup_before": None,
                "cleanup_after": None,
                "codex_overload_probe": probe,
            },
        )()
    )

    assert manifest["copied"]["codex_overload_probe"] is True
    assert "codex-overload-probe.json" in manifest["files"]


def test_real_symphony_e2e_run_does_not_call_removed_workflow_api_routes() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert "preview-workflow" not in source
    assert "generate-workflow" not in source
    assert "validate-workflow" not in source
    assert "workflow-profiles" not in source


def test_real_codex_thread_resume_probe_summarizes_resume_and_fallback() -> None:
    tool = load_tool("real_codex_thread_resume_probe")

    summary = tool.summarize_probe(
        first_thread_id="thread-1",
        resumed_thread_id="thread-1",
        fallback_requested_thread_id="missing-thread",
        fallback_thread_id="thread-2",
        fallback_events=[{"event": "thread_resume_failed", "thread_id": "missing-thread"}],
    )

    assert summary["resume_same_thread"] is True
    assert summary["fallback_recorded"] is True
    assert summary["fallback_started_new_thread"] is True
    assert summary["pass"] is True

def test_real_codex_thread_resume_probe_uses_structured_prompt() -> None:
    tool = load_tool("real_codex_thread_resume_probe")

    prompt = tool.probe_prompt("resume probe")

    assert "resume probe" in prompt
    assert "summary" in prompt
    assert "test_commands" in prompt
    assert "changed_files" in prompt
    assert "remaining_risks" in prompt
    assert "ready_for_review" in prompt

def test_real_codex_continuation_probe_requires_two_turns_on_one_thread() -> None:
    tool = load_tool("real_codex_continuation_probe")

    summary = tool.summarize_probe(
        SimpleNamespace(
            success=True,
            thread_id="thread-1",
            turn_count=2,
            structured_result={"next_action": "ready_for_review"},
        ),
        [
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-2"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-2"},
        ],
        [1],
    )

    assert summary["pass"] is True
    assert summary["turn_count"] == 2
    assert summary["same_thread"] is True
    assert summary["continuation_calls"] == [1]

def test_real_codex_continuation_probe_rejects_resume_only_single_turn() -> None:
    tool = load_tool("real_codex_continuation_probe")

    summary = tool.summarize_probe(
        SimpleNamespace(
            success=True,
            thread_id="thread-1",
            turn_count=1,
            structured_result={"next_action": "ready_for_review"},
        ),
        [
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-1"},
        ],
        [],
    )

    assert summary["pass"] is False
