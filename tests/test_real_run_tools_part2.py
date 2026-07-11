from test_real_run_tools_support import *  # noqa: F401,F403
import sqlite3


def _managed_turn_fixture(run_id: str, attempt_id: str = "plan-1") -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    context = {
        "run_id": run_id,
        "work_item_id": "",
        "policy_revision": 1,
        "plan_version": 0,
        "lease_id": f"lease-{attempt_id}",
        "fencing_token": f"fence-{attempt_id}",
        "turn_id": attempt_id,
    }
    return (
        {
            "attempt_id": attempt_id,
            "kind": "plan",
            "mode": "plan",
            "state": "succeeded",
            "turn_context": context,
        },
        {"turn_kind": "plan", "workspace_path": "/tmp/workspace", "context": context},
        {"turn_kind": "plan", "context": context, "plan": {}},
    )


def _write_managed_turn_artifacts(instance_root: Path, attempt: dict[str, Any], request: dict[str, Any], result: dict[str, Any]) -> None:
    attempt_id = str(attempt["attempt_id"])
    context = attempt["turn_context"]
    generation_log = instance_root / "logs" / "performer-000001.log"
    generation_log.parent.mkdir(parents=True, exist_ok=True)
    generation_log.write_text(
        f"event=managed_run_turn_started run_id={context['run_id']} attempt_id={attempt_id} "
        f"lease_id={context['lease_id']} fencing_token={context['fencing_token']}\n",
        encoding="utf-8",
    )
    attempt_root = instance_root / "state" / "managed_run" / attempt_id
    attempt_root.mkdir(parents=True, exist_ok=True)
    (attempt_root / "turn-request.json").write_text(json.dumps(request), encoding="utf-8")
    (attempt_root / "turn-result.json").write_text(json.dumps(result), encoding="utf-8")
    (attempt_root / "attempt.log").write_text(
        f"event=performer_stream attempt_id={attempt_id} lease_id={context['lease_id']}\n",
        encoding="utf-8",
    )


def test_real_codex_connectivity_probe_classifies_upstream_and_auth_failures() -> None:
    tool = load_tool("real_codex_connectivity_probe")

    upstream = tool.summarize_events(
        [
            {"event": "codex_init_succeeded", "thread_id": "thread-1"},
            {"event": "codex_overload_retrying", "http_status": 502, "message": "upstream unavailable"},
            {"event": "codex_overload_exhausted", "http_status": 502, "message": "upstream unavailable"},
        ]
    )
    upstream.update({"outcome": "codex_error", "error_code": "upstream_overloaded_exhausted", "http_status": 502})
    upstream["connectivity_status"] = tool.classify_connectivity(upstream)
    auth = tool.summarize_events(
        [
            {"event": "codex_init_succeeded", "thread_id": "thread-1"},
            {"event": "codex_request_failed_terminal", "code": "codex_bad_request", "http_status": 401},
        ]
    )
    auth.update({"outcome": "codex_error", "error_code": "codex_bad_request", "http_status": 401})
    auth["connectivity_status"] = tool.classify_connectivity(auth)

    assert upstream["connectivity_status"] == "upstream_unavailable"
    assert auth["connectivity_status"] == "auth_failed"
    assert tool.scenario_passed(upstream, "connected") is False
    assert tool.scenario_passed(upstream, "upstream_unavailable") is True
    assert tool.scenario_passed(auth, "auth_failed") is True


def test_real_codex_connectivity_probe_requires_turn_completion_and_blocks_secret_leaks() -> None:
    tool = load_tool("real_codex_connectivity_probe")

    connected = tool.summarize_events(
        [
            {"event": "codex_init_succeeded", "thread_id": "thread-1"},
            {"event": "turn_started", "turn_id": "turn-1"},
            {"event": "turn_completed", "turn_id": "turn-1"},
        ]
    )
    connected.update({"outcome": "success"})
    connected["connectivity_status"] = tool.classify_connectivity(connected)
    leaked = tool.summarize_events(
        [
            {"event": "codex_init_succeeded", "thread_id": "thread-1"},
            {"event": "turn_completed", "message": "Bearer sk-secret-value"},
        ]
    )
    leaked.update({"outcome": "success"})
    leaked["connectivity_status"] = tool.classify_connectivity(leaked)

    assert connected["connectivity_status"] == "connected"
    assert tool.scenario_passed(connected, "connected") is True
    assert leaked["secret_leak_found"] is True
    assert leaked["connectivity_status"] == "secret_leak"
    assert tool.scenario_passed(leaked, "connected") is False


def test_real_codex_connectivity_probe_planner_shape_requires_structured_plan() -> None:
    tool = load_tool("real_codex_connectivity_probe")

    summary = tool.summarize_events(
        [
            {"event": "codex_init_succeeded", "thread_id": "thread-1"},
            {"event": "turn_started", "turn_id": "turn-1"},
            {"event": "turn_completed", "turn_id": "turn-1"},
        ]
    )
    summary.update({"outcome": "success", "probe_kind": "planner-shaped", "structured_present": False})

    assert tool.classify_connectivity(summary) == "planner_shape_invalid"
    assert tool.scenario_passed(summary, "connected") is False


def test_real_codex_connectivity_probe_exposes_planner_shaped_schema_and_prompt() -> None:
    tool = load_tool("real_codex_connectivity_probe")

    args = tool.parser().parse_args(["--workspace", "/tmp/probe", "--probe-kind", "planner-shaped"])
    spec = tool.probe_spec("planner-shaped")

    assert args.probe_kind == "planner-shaped"
    assert "proposal" in spec.schema["required"]
    assert "nodes" in spec.prompt
    assert "gates" in spec.prompt


def test_real_codex_connectivity_probe_extracts_custom_schema_from_final_response() -> None:
    tool = load_tool("real_codex_connectivity_probe")
    payload = {
        "probe_kind": "planner-shaped",
        "summary": "Planner-shaped structured output is available.",
        "proposal": {
            "nodes": [
                {"id": "plan", "mode": "plan", "objective": "Plan the work.", "depends_on": []},
                {"id": "execute", "mode": "execute", "objective": "Execute the work.", "depends_on": ["plan"]},
                {"id": "verify", "mode": "verify", "objective": "Verify the work.", "depends_on": ["execute"]},
            ],
            "gates": [
                {"id": "gate-plan", "node_id": "plan", "kind": "command", "command": "test -f README.md"},
                {"id": "gate-verify", "node_id": "verify", "kind": "command", "command": "pytest -q"},
            ],
            "entry_node_ids": ["plan"],
            "exit_node_ids": ["verify"],
            "risk_notes": [],
        },
    }
    result = SimpleNamespace(structured_result=None, final_response=json.dumps(payload))

    structured = tool.extract_probe_structured_result(result)

    assert structured == payload
    assert tool._planner_shape_valid(structured) is True


def test_real_symphony_e2e_requires_replan_linear_issue_tree_final_states() -> None:
    tool = load_tool("real_symphony_e2e_run")
    stale_tree = {
        "identifier": "HELL-857",
        "state": {"name": "Backlog", "type": "backlog"},
        "children": {
            "nodes": [
                {
                    "identifier": "HELL-860",
                    "title": "Run smoke",
                    "state": {"name": "In Progress", "type": "started"},
                    "labels": {"nodes": [{"name": "symphony:type/work-item"}]},
                },
                {
                    "identifier": "HELL-858",
                    "title": "Superseded",
                    "state": {"name": "Canceled", "type": "canceled"},
                    "labels": {"nodes": [{"name": "symphony:type/work-item"}]},
                },
            ]
        },
    }
    finalized_tree = {
        **stale_tree,
        "state": {"name": "Done", "type": "completed"},
        "children": {
            "nodes": [
                {**stale_tree["children"]["nodes"][0], "state": {"name": "Done", "type": "completed"}},
                stale_tree["children"]["nodes"][1],
            ]
        },
    }

    stale = tool._pipeline_linear_issue_tree_finalized(stale_tree)
    finalized = tool._pipeline_linear_issue_tree_finalized(finalized_tree)

    assert stale["passed"] is False
    assert stale["root_state_type"] == "backlog"
    assert stale["managed_run_children"][0]["state_type"] == "started"
    assert finalized["passed"] is True


def test_real_symphony_e2e_finalization_recognizes_managed_run_child_without_label() -> None:
    tool = load_tool("real_symphony_e2e_run")
    tree = {
        "identifier": "HELL-857",
        "state": {"name": "Done", "type": "completed"},
        "children": {
            "nodes": [
                {
                    "identifier": "HELL-860",
                    "title": "Run smoke",
                    "description": "\n".join(
                        [
                            "Objective: Run smoke",
                            "",
                            "Acceptance Criteria:",
                            "- result exists",
                            "",
                            "Verification:",
                            "- GREEN: test -f SYMPHONY_REAL_E2E_RESULT.md",
                            "",
                            "Managed Run State:",
                            "- state: done",
                            "- gate: verification passed",
                        ]
                    ),
                    "state": {"name": "Done", "type": "completed"},
                    "labels": {"nodes": []},
                },
            ]
        },
    }

    finalized = tool._pipeline_linear_issue_tree_finalized(tree)

    assert finalized["passed"] is True
    assert finalized["managed_run_children"] == [
        {"identifier": "HELL-860", "title": "Run smoke", "state": "Done", "state_type": "completed"}
    ]


def test_real_symphony_e2e_linear_tree_audit_matches_durable_work_item_contract() -> None:
    tool = load_tool("real_symphony_e2e_linear_audit")
    description = "\n".join(
        [
            "Managed Run Type: work-item",
            "Managed Run Label: symphony:type/work-item",
            "Managed Run Work Item: wi-1",
            "",
            "Objective: Create result",
            "",
            "Acceptance Criteria:",
            "- result exists",
            "",
            "Likely Files:",
            "- `result.txt`",
            "",
            "Verification:",
            "- RED: test -f result.txt",
            "- GREEN: test -f result.txt",
            "",
            "Managed Run State:",
            "- state: done",
            "- gate: verification passed",
        ]
    )
    view = {
        "runs": [
            {
                "run_id": "run-1",
                "work_items": [
                    {"work_item_id": "wi-1", "payload": {"dependencies": []}},
                ],
            }
        ]
    }
    tree = {
        "id": "root-1",
        "identifier": "HELL-1",
        "description": "<!-- symphony:run-summary:start -->",
        "state": {"name": "Done", "type": "completed"},
        "labels": {"nodes": []},
        "children": {
            "nodes": [
                {
                    "id": "child-1",
                    "identifier": "HELL-2",
                    "title": "Create result",
                    "description": description,
                    "parent": {"id": "root-1", "identifier": "HELL-1"},
                    "state": {"name": "Done", "type": "completed"},
                    "labels": {"nodes": []},
                    "children": {"nodes": []},
                    "inverseRelations": {"nodes": []},
                }
            ]
        },
        "inverseRelations": {"nodes": []},
    }

    result = tool.audit_managed_run_linear_tree(view, tree)

    assert result["pass"] is True
    assert result["expected_work_item_ids"] == ["wi-1"]
    assert result["work_item_count"] == 1


def test_real_symphony_e2e_linear_tree_audit_requires_state_and_attempt_comment_parity() -> None:
    tool = load_tool("real_symphony_e2e_linear_audit")
    description = "\n".join(
        [
            "Managed Run Type: work-item",
            "Managed Run Work Item: wi-1",
            "",
            "Objective: Create result",
            "",
            "Acceptance Criteria:",
            "- result exists",
            "",
            "Likely Files:",
            "- `result.txt`",
            "",
            "Verification:",
            "- RED: test -f result.txt",
            "- GREEN: test -f result.txt",
            "",
            "Managed Run State:",
            "- state: done",
            "- gate: verification passed",
        ]
    )
    view = {
        "runs": [
            {
                "run_id": "run-1",
                "parent_issue_id": "root-1",
                "state": "done",
                "attempt_integrity": {"passed": True, "errors": []},
                "payload": {
                    "attempt_comment_projections": {
                        "plan-1": {"linear_issue_id": "root-1", "linear_comment_id": "comment-plan"},
                        "execute-1": {"linear_issue_id": "child-1", "linear_comment_id": "comment-execute"},
                        "verify-1": {"linear_issue_id": "child-1", "linear_comment_id": "comment-verify"},
                    }
                },
                "attempts": [
                    {"attempt_id": "plan-1", "state": "succeeded", "work_item_id": ""},
                    {"attempt_id": "execute-1", "state": "succeeded", "work_item_id": "wi-1"},
                    {"attempt_id": "verify-1", "state": "succeeded", "work_item_id": "wi-1"},
                ],
                "work_items": [{"work_item_id": "wi-1", "state": "done", "payload": {"dependencies": []}}],
            }
        ]
    }
    tree = {
        "id": "root-1",
        "identifier": "HELL-1",
        "description": "<!-- symphony:run-summary:start -->",
        "state": {"name": "In Progress", "type": "started"},
        "labels": {"nodes": []},
        "comments": {"nodes": [{"id": "comment-plan", "body": "attempt_id: plan-1"}]},
        "children": {
            "nodes": [
                {
                    "id": "child-1",
                    "identifier": "HELL-2",
                    "title": "Create result",
                    "description": description,
                    "parent": {"id": "root-1", "identifier": "HELL-1"},
                    "state": {"name": "In Progress", "type": "started"},
                    "labels": {"nodes": []},
                    "comments": {"nodes": [{"id": "comment-execute", "body": "attempt_id: execute-1"}]},
                    "children": {"nodes": []},
                    "inverseRelations": {"nodes": []},
                }
            ]
        },
        "inverseRelations": {"nodes": []},
    }

    result = tool.audit_managed_run_linear_tree(view, tree)

    assert result["pass"] is False
    assert "parent_state_mismatch:expected_completed:actual_started" in result["failures"]
    assert "work_item_state_mismatch:wi-1:expected_completed:actual_started" in result["failures"]
    assert "attempt_comment_missing:verify-1:comment-verify" in result["failures"]


def test_real_symphony_e2e_has_optional_codex_connectivity_probe() -> None:
    tool = load_tool("real_symphony_e2e")
    run_tool = load_tool("real_symphony_e2e_run")

    args = tool.parser().parse_args(["--codex-connectivity-probe", "--codex-connectivity-timeout-ms", "1234"])

    assert args.codex_connectivity_probe is True
    assert args.codex_connectivity_timeout_ms == 1234
    assert "codex-connectivity:connected" in (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")
    assert hasattr(run_tool, "run_codex_connectivity_probe")


def test_real_symphony_e2e_has_optional_planner_shaped_codex_probe() -> None:
    tool = load_tool("real_symphony_e2e")
    run_tool = load_tool("real_symphony_e2e_run")

    args = tool.parser().parse_args(["--codex-planner-shaped-probe", "--codex-planner-shaped-timeout-ms", "1234"])

    assert args.codex_planner_shaped_probe is True
    assert args.codex_planner_shaped_timeout_ms == 1234
    assert "codex-connectivity:planner-shaped" in (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")
    assert hasattr(run_tool, "run_codex_planner_shaped_probe")


def test_real_codex_init_probe_summarizes_transient_recovery() -> None:
    tool = load_tool("real_codex_init_probe")

    summary = tool.summarize_events(
        [
            {"event": "codex_init_starting", "attempt": 1},
            {"event": "codex_init_retrying", "attempt": 2, "delay_ms": 500, "message": "connection_error"},
            {"event": "codex_init_starting", "attempt": 2},
            {"event": "codex_init_succeeded", "attempts": 2, "thread_id": "thread-1"},
        ]
    )
    summary.update({"outcome": "success"})

    assert summary["init_start_count"] == 2
    assert summary["init_retry_count"] == 1
    assert summary["init_succeeded"] is True
    assert tool._scenario_passed(summary, "transient_recovered") is True

def test_real_codex_init_probe_recognizes_terminal_fast_failure() -> None:
    tool = load_tool("real_codex_init_probe")

    summary = tool.summarize_events(
        [
            {"event": "codex_init_starting", "attempt": 1},
            {"event": "codex_init_failed", "attempts": 1, "message": "codex_sdk_not_installed"},
        ]
    )
    summary.update({"outcome": "codex_error", "error_code": "codex_sdk_not_installed"})

    assert summary["init_start_count"] == 1
    assert summary["init_failed"] is True
    assert tool._scenario_passed(summary, "terminal_failed") is True

def test_real_codex_overload_probe_summarizes_recovery() -> None:
    tool = load_tool("real_codex_overload_probe")

    summary = tool.summarize_events(
        [
            {"event": "codex_overload_retrying", "attempt": 2, "delay_ms": 250, "http_status": 502, "message": "upstream 502"},
            {"event": "turn_started", "turn_id": "turn-1"},
            {"event": "turn_completed", "turn_id": "turn-1"},
        ]
    )
    summary.update({"outcome": "success"})

    assert summary["overload_retry_count"] == 1
    assert summary["http_statuses"] == [502]
    assert tool.scenario_passed(summary, "overload_recovered") is True

def test_real_codex_overload_probe_recognizes_exhaustion_and_terminal_fast_failure() -> None:
    tool = load_tool("real_codex_overload_probe")

    exhausted = tool.summarize_events(
        [
            {"event": "codex_overload_retrying", "attempt": 2, "delay_ms": 250, "http_status": 502, "message": "upstream 502"},
            {"event": "codex_overload_exhausted", "attempts": 3, "http_status": 502, "message": "upstream 502"},
        ]
    )
    exhausted.update({"outcome": "codex_error", "error_code": "upstream_overloaded_exhausted"})
    terminal = tool.summarize_events(
        [
            {"event": "codex_request_failed_terminal", "code": "codex_bad_request", "http_status": 400, "message": "bad request"},
        ]
    )
    terminal.update({"outcome": "codex_error", "error_code": "codex_bad_request"})

    assert tool.scenario_passed(exhausted, "overload_exhausted") is True
    assert tool.scenario_passed(terminal, "terminal_failed") is True

def test_real_codex_overload_probe_fails_on_secret_leak() -> None:
    tool = load_tool("real_codex_overload_probe")

    summary = tool.summarize_events(
        [
            {"event": "codex_overload_retrying", "message": "Bearer sk-secret-value"},
            {"event": "turn_completed"},
        ]
    )
    summary.update({"outcome": "success"})

    assert summary["secret_leak_found"] is True
    assert tool.scenario_passed(summary, "overload_recovered") is False

def test_codex_jsonrpc_fault_wrapper_injects_overload_then_proxies(tmp_path: Path) -> None:
    tool = load_tool("codex_jsonrpc_fault_wrapper")
    real_codex = tmp_path / "real-codex"
    log_path = tmp_path / "wrapper.jsonl"
    real_codex.write_text("#!/bin/sh\ncat\n", encoding="utf-8")
    real_codex.chmod(0o755)

    command = tool.build_real_command(
        codex_bin=str(real_codex),
        passthrough_args=["--config", "model_provider=openai", "app-server", "--listen", "stdio://"],
    )
    first = {"id": "1", "method": "turn/start", "params": {}}
    second = {"id": "2", "method": "turn/start", "params": {}}
    other = {"id": "3", "method": "thread/start", "params": {}}
    state = tool.FaultState(
        mode="overload",
        target_method="turn/start",
        fail_count=1,
        http_status=502,
        message="upstream 502: server overloaded",
        log_path=log_path,
    )

    assert command == [str(real_codex), "--config", "model_provider=openai", "app-server", "--listen", "stdio://"]
    assert tool.sanitized_config_overrides(command) == ["model_provider=openai"]
    injected = tool.maybe_fault_response(first, state)
    assert injected == {
        "id": "1",
        "error": {
            "code": -32000,
            "message": "upstream 502: server overloaded",
            "data": {"codex_error_info": "server_overloaded", "httpStatusCode": 502},
        },
    }
    assert tool.maybe_fault_response(second, state) is None
    assert tool.maybe_fault_response(other, state) is None
    log_text = log_path.read_text(encoding="utf-8")
    assert "turn/start" in log_text
    assert "server_overloaded" in log_text
    assert "sk-" not in log_text

def test_codex_jsonrpc_fault_wrapper_sanitizes_secret_config_values() -> None:
    tool = load_tool("codex_jsonrpc_fault_wrapper")

    assert tool.sanitized_config_overrides(
        [
            "/opt/homebrew/bin/codex",
            "--config",
            "model_provider=openai",
            "--config",
            "api_key=sk-secret",
            "--config",
            "token=$OPENAI_API_KEY",
        ]
    ) == ["model_provider=openai", "api_key=<redacted>", "token=$OPENAI_API_KEY"]

def test_codex_jsonrpc_fault_wrapper_injects_terminal_bad_request(tmp_path: Path) -> None:
    tool = load_tool("codex_jsonrpc_fault_wrapper")
    log_path = tmp_path / "wrapper.jsonl"
    state = tool.FaultState(
        mode="invalid_params",
        target_method="turn/start",
        fail_count=5,
        http_status=400,
        message="terminal 400: invalid request shape",
        log_path=log_path,
    )

    response = tool.maybe_fault_response({"id": "turn-1", "method": "turn/start"}, state)

    assert response == {
        "id": "turn-1",
        "error": {
            "code": -32602,
            "message": "terminal 400: invalid request shape",
            "data": {"httpStatusCode": 400},
        },
    }
    assert tool.maybe_fault_response({"id": "turn-2", "method": "turn/start"}, state) == {
        "id": "turn-2",
        "error": {
            "code": -32602,
            "message": "terminal 400: invalid request shape",
            "data": {"httpStatusCode": 400},
        },
    }
    assert "invalid_params" in log_path.read_text(encoding="utf-8")

def test_codex_jsonrpc_fault_wrapper_parses_sdk_passthrough_args() -> None:
    tool = load_tool("codex_jsonrpc_fault_wrapper")

    args = tool.parse_args(
        [
            "--real-codex-bin",
            "/opt/homebrew/bin/codex",
            "--mode",
            "overload",
            "--config",
            "model_provider=openai",
            "app-server",
            "--listen",
            "stdio://",
        ]
    )

    assert args.real_codex_bin == "/opt/homebrew/bin/codex"
    assert args.mode == "overload"
    assert args.codex_args == ["--config", "model_provider=openai", "app-server", "--listen", "stdio://"]

def test_real_symphony_e2e_detects_conductor_pipeline_human_action() -> None:
    tool = load_tool("real_symphony_e2e")

    actions = tool.conductor_human_actions(
        {
            "human_waits": [
                {
                    "wait_id": "wait-1",
                    "node_id": "node-1",
                    "reason": "LINEAR_SYNC_CONFLICT",
                    "status": "open",
                    "child_issue_id": "child-1",
                    "child_identifier": "HELL-2",
                    "child_url": "https://linear.test/HELL-2",
                    "details": {"integration_id": "integration-node-1-verify-1"},
                }
            ],
            "nodes": [
                {
                    "node_id": "node-1",
                    "issue_id": "issue-1",
                    "issue_identifier": "HELL-1",
                    "state": "need_human",
                }
            ],
        }
    )

    assert actions == [
        {
            "wait_id": "wait-1",
            "node_id": "node-1",
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "state": "need_human",
            "status": "open",
            "reason": "LINEAR_SYNC_CONFLICT",
            "child_issue_id": "child-1",
            "child_identifier": "HELL-2",
            "child_url": "https://linear.test/HELL-2",
            "details": {"integration_id": "integration-node-1-verify-1"},
        }
    ]


def test_real_symphony_e2e_detects_runtime_wait_human_action() -> None:
    tool = load_tool("real_symphony_e2e")

    actions = tool.conductor_human_actions(
        {
            "runtime_waits": [
                {
                    "wait_id": "runtime-wait-exec-1-approval_requested",
                    "node_id": "node-1",
                    "wait_kind": "approval_requested",
                    "status": "waiting",
                    "attempt_id": "exec-1",
                    "lease_id": "lease-1",
                    "child_issue_id": "child-1",
                }
            ],
            "nodes": [
                {
                    "node_id": "node-1",
                    "issue_id": "issue-1",
                    "issue_identifier": "HELL-1",
                    "state": "ready",
                }
            ],
        }
    )

    assert actions == [
        {
            "wait_id": "runtime-wait-exec-1-approval_requested",
            "node_id": "node-1",
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "state": "ready",
            "status": "waiting",
            "reason": "approval_requested",
            "child_issue_id": "child-1",
            "child_identifier": None,
            "child_url": None,
            "details": {"attempt_id": "exec-1", "lease_id": "lease-1", "wait_kind": "approval_requested"},
        }
    ]


def test_real_symphony_e2e_extracts_runtime_waits_from_managed_run_view() -> None:
    tool = load_tool("real_symphony_e2e")

    actions = tool.conductor_human_actions(
        {
            "runs": [
                {
                    "run_id": "run-1",
                    "issue_identifier": "HELL-1",
                    "work_items": [],
                    "linear_projections": [],
                }
            ],
            "runtime_waits": [
                {
                    "run_id": "run-1",
                    "wait_id": "runtime-wait-1",
                    "work_item_id": "wi-1",
                    "attempt_id": "attempt-1",
                    "lease_id": "lease-1",
                    "wait_kind": "approval_requested",
                    "status": "waiting",
                    "child_issue_id": "child-runtime-1",
                    "child_issue_identifier": "HELL-2",
                }
            ],
        }
    )

    assert actions == [
        {
            "wait_id": "runtime-wait-1",
            "node_id": "wi-1",
            "work_item_id": "wi-1",
            "issue_id": None,
            "issue_identifier": "HELL-1",
            "state": "blocked",
            "status": "waiting",
            "reason": "approval_requested",
            "child_issue_id": "child-runtime-1",
            "child_identifier": "HELL-2",
            "child_url": None,
            "details": {"attempt_id": "attempt-1", "lease_id": "lease-1", "wait_kind": "approval_requested"},
        }
    ]


def test_real_symphony_e2e_wait_uses_integrated_manifest_repository_result_path(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_wait")
    repository = tmp_path / "repo"
    repository.mkdir()

    result_path = tool._pipeline_integrated_result_path(
        {
            "integration_queue": [
                {"verify_attempt_id": "verify-1", "status": "integrated"},
            ],
            "manifests": [
                {
                    "verify_attempt_id": "verify-1",
                    "code": {"repository_path": str(repository)},
                }
            ],
        }
    )

    assert result_path == repository / "SYMPHONY_REAL_E2E_RESULT.md"


def test_real_symphony_e2e_pipeline_integrated_accepts_human_resolved_conflict() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._pipeline_integrated(
        {
            "integration_queue": [
                {"status": "integrated", "node_id": "a"},
                {"status": "resolved", "node_id": "b", "error": "patch conflict"},
            ]
        }
    )


def test_real_symphony_e2e_final_view_uses_flat_node_states() -> None:
    tool = load_tool("real_symphony_e2e_run")

    pipeline_view = {
        "graph_revision": 2,
        "nodes": [
            {
                "node_id": "parent",
                "state": "verify_passed",
                "gate_snapshot_hash": "gate-parent",
            },
            {"node_id": "child-a", "state": "verify_passed"},
            {"node_id": "child-b", "state": "verify_passed"},
        ],
        "linear_projections": [
            {
                "node_id": "parent",
                "metadata": {
                    "node_id": "parent",
                    "conductor_revision": 2,
                    "graph_id": "graph-1",
                    "operator_status": "verify_passed",
                    "gate_snapshot_hash": "gate-parent",
                },
            },
            {
                "node_id": "child-a",
                "metadata": {
                    "node_id": "child-a",
                    "conductor_revision": 2,
                    "graph_id": "graph-1",
                    "operator_status": "verify_passed",
                },
            },
            {
                "node_id": "child-b",
                "metadata": {
                    "node_id": "child-b",
                    "conductor_revision": 2,
                    "graph_id": "graph-1",
                    "operator_status": "verify_passed",
                },
            },
        ],
    }

    assert tool._pipeline_final_view_converged(pipeline_view)


def test_real_symphony_e2e_permission_probe_allows_active_lease_after_wait_clears() -> None:
    tool = load_tool("real_symphony_e2e_run")

    assert tool._permission_probe_block_cleared(
        {
            "managed_run_human_actions": [],
            "managed_run_turns": [{"lease_id": "execute-lease-1", "mode": "execute"}],
        }
    )
    assert not tool._permission_probe_block_cleared(
        {
            "managed_run_human_actions": [
                {
                    "wait_id": "runtime-wait-exec-1-approval_requested",
                    "status": "waiting",
                    "details": {"wait_kind": "approval_requested"},
                }
            ],
            "managed_run_turns": [{"lease_id": "execute-lease-1", "mode": "execute"}],
        }
    )


def test_appendix_exit_bar_audit_requires_all_overall_items() -> None:
    tool = load_tool("real_symphony_e2e")
    reports = [
        {
            "failures": [],
            "checks": [
                {"name": "stage:managed-run-gates-frozen", "passed": True},
                {"name": "stage:managed-run-linear-projected", "passed": True},
                {"name": "scenario:parallel-execute-overlap", "passed": True},
                {"name": "runtime-config:podium-pushed", "passed": True},
                {"name": "stage:managed-run-manifest-published", "passed": True},
                {"name": "stage:final-managed-run-verified", "passed": True},
                {"name": "appendix:s3-verifier-mutation-detection", "passed": True},
                {"name": "appendix:s3-expired-fencing-refused", "passed": True},
                {"name": "scenario:replan-replacement-subgraph", "passed": True},
                {"name": "scenario:integration-conflict-human-action", "passed": True},
                {"name": "conductor-api:GET /api/managed-runs", "passed": True},
                {"name": "appendix:managed-run-prediction-conditional", "passed": True},
                {"name": "runtime-config:codex-home-source-staged", "passed": True},
                {"name": "appendix:no-global-codex-home", "passed": True},
                {"name": "appendix:reconcile-findings-clean", "passed": True},
                {"name": "appendix:evidence-scores-within-hard-caps", "passed": True},
            ],
        }
    ]

    passed = tool.appendix_exit_bar_audit(reports)
    missing = tool.appendix_exit_bar_audit([{**reports[0], "checks": reports[0]["checks"][:-1]}])

    assert passed["pass"] is True
    assert {item["item"] for item in passed["items"]} == set(range(1, 9))
    assert missing["pass"] is False
    assert missing["items"][-1]["item"] == 8
    assert missing["items"][-1]["pass"] is False


def test_appendix_overall_acceptance_scores_after_required_checks(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    analysis = load_tool("real_symphony_e2e_analysis")
    evidence = tool.Evidence(tmp_path / "report.json")
    required_names = {
        name
        for requirement in analysis.APPENDIX_FEATURE_SCORE_REQUIREMENTS
        for key in ("r_checks", "h_checks")
        for name in requirement[key]
    }
    required_names.update(
        {
            "stage:managed-run-gates-frozen",
            "stage:managed-run-linear-projected",
            "scenario:parallel-execute-overlap",
            "runtime-config:podium-pushed",
            "stage:managed-run-manifest-published",
            "stage:final-managed-run-verified",
            "appendix:s3-verifier-mutation-detection",
            "appendix:s3-expired-fencing-refused",
            "scenario:replan-replacement-subgraph",
            "appendix:overall-downstream-depends-on-both-parallel-subtasks",
            "scenario:integration-conflict-human-action",
            "conductor-api:GET /api/managed-runs",
            "runtime-config:codex-home-source-staged",
        }
    )
    for name in sorted(required_names):
        evidence.check(name, True)
    pipeline_view = {
        "prediction_basis": {
            "graph_revision": 2,
            "policy_revision": 1,
            "assumption": "unknown verifies pass",
            "generated_at": "2026-07-08T00:00:00Z",
        },
        "graph_revision": 2,
        "predicted_call_order": [{"node_id": "a", "confidence": "conditional"}],
        "runtime_config": {
            "profiles": {
                "work_item": {"settings": {"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"}},
                "verify": {"backend": "local-verifier", "settings": {}},
            }
        },
        "nodes": [
            {"node_id": "parent", "title": "Parent", "state": "verify_passed"},
            {"node_id": "parallel-alpha", "title": "Parallel alpha", "parent_node_id": "parent", "state": "verify_passed"},
            {"node_id": "parallel-beta", "title": "Parallel beta", "parent_node_id": "parent", "state": "superseded", "superseded_by": ["replacement"]},
            {"node_id": "replacement", "title": "Parallel beta replacement", "parent_node_id": "parent", "state": "verify_passed"},
            {"node_id": "integration-check", "title": "Integration check", "parent_node_id": "parent", "state": "verify_passed"},
        ],
        "blocks": [["parallel-alpha", "integration-check"], ["replacement", "integration-check"]],
        "gates": [
            {
                "gate_id": "gate-integration",
                "task_id": "integration-check",
                "content": {
                    "verification_procedure": [
                        {"step": "pytest tests/test_smoke.py -q", "source": "issue_requirement"}
                    ]
                },
            }
        ],
        "attempts": [
            {
                "attempt_id": "verify-child-a",
                "node_id": "parallel-alpha",
                "mode": "verify",
                "score": 3,
                "completed_at": "2026-07-08T00:00:10Z",
                "state": "succeeded",
            },
            {
                "attempt_id": "verify-child-b",
                "node_id": "replacement",
                "mode": "verify",
                "score": 3,
                "completed_at": "2026-07-08T00:00:10Z",
                "state": "succeeded",
            },
            {
                "attempt_id": "execute-child-b",
                "node_id": "integration-check",
                "mode": "execute",
                "started_at": "2026-07-08T00:00:11Z",
                "state": "succeeded",
            },
        ],
            "integration_queue": [
                {"status": "resolved", "error": "patch conflict", "human_resolution": "completed"}
            ],
            "human_waits": [{"reason": "LINEAR_SYNC_CONFLICT", "status": "resolved"}],
        }
    homes_root = tmp_path / "data" / "instances" / "inst-1" / "runtime-homes"
    for relative in [
        "plan/plan-1/codex",
        "execute/exec-1/codex",
        "execute/exec-2/codex",
        "verify/verify-1/local-verifier",
    ]:
        (homes_root / relative).mkdir(parents=True)

    tool._check_appendix_overall_acceptance(
        evidence,
        pipeline_view,
        data_root=tmp_path / "data",
        instance_id="inst-1",
    )

    checks = {check["name"]: check for check in evidence.data["checks"]}
    assert checks["appendix:overall-downstream-depends-on-both-parallel-subtasks"]["passed"] is True
    assert checks["appendix:gate-step-provenance-checkpoint"]["passed"] is True
    assert checks["appendix:evidence-scores-within-hard-caps"]["passed"] is True
    assert checks["appendix:feature-scores-r-plus-h"]["passed"] is True


def test_appendix_overall_acceptance_fails_without_downstream_depending_on_both_parallel_subtasks(
    tmp_path: Path,
) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_appendix_overall_acceptance(
        evidence,
        {
            "prediction_basis": {"graph_revision": 2, "policy_revision": 1, "assumption": "unknown verifies pass"},
            "graph_revision": 2,
            "predicted_call_order": [{"node_id": "a", "confidence": "conditional"}],
            "runtime_config": {
                "profiles": {
                    "work_item": {"settings": {"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"}},
                    "verify": {"backend": "local-verifier", "settings": {}},
                }
            },
            "nodes": [
                {"node_id": "parent", "title": "Parent", "state": "verify_passed"},
                {"node_id": "parallel-alpha", "title": "Parallel alpha", "parent_node_id": "parent", "state": "verify_passed"},
                {"node_id": "parallel-beta", "title": "Parallel beta", "parent_node_id": "parent", "state": "verify_passed"},
                {"node_id": "integration-check", "title": "Integration check", "parent_node_id": "parent", "state": "verify_passed"},
            ],
            "blocks": [["parallel-alpha", "integration-check"]],
            "attempts": [
                {
                    "attempt_id": "verify-alpha",
                    "node_id": "parallel-alpha",
                    "mode": "verify",
                    "score": 3,
                    "completed_at": "2026-07-08T00:00:10Z",
                    "state": "succeeded",
                },
                {
                    "attempt_id": "execute-integration",
                    "node_id": "integration-check",
                    "mode": "execute",
                    "started_at": "2026-07-08T00:00:11Z",
                    "state": "succeeded",
                },
            ],
            "integration_queue": [{"status": "resolved", "error": "patch conflict", "human_resolution": "completed"}],
        },
        data_root=tmp_path / "missing-data",
        instance_id="inst-1",
    )

    checks = {check["name"]: check for check in evidence.data["checks"]}
    assert checks["appendix:overall-downstream-depends-on-both-parallel-subtasks"]["passed"] is False


def test_real_symphony_e2e_runtime_home_evidence_requires_distinct_parallel_execute_homes(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    homes_root = tmp_path / "data" / "instances" / "inst-1" / "runtime-homes"
    for relative in [
        "plan/plan-1/codex",
        "execute/exec-1/codex",
        "execute/exec-2/codex",
        "verify/verify-1/local-verifier",
    ]:
        (homes_root / relative).mkdir(parents=True)

    evidence = tool._runtime_home_evidence(
        data_root=tmp_path / "data",
        instance_id="inst-1",
        pipeline_view={
            "attempts": [
                {"attempt_id": "exec-1", "mode": "execute"},
                {"attempt_id": "exec-2", "mode": "execute"},
            ]
        },
    )

    assert evidence["distinct_mode_homes"] is True
    assert evidence["concurrent_execute_homes_distinct"] is True


def test_real_symphony_e2e_pipeline_prediction_requires_conditional_basis() -> None:
    tool = load_tool("real_symphony_e2e_run")

    assert tool._pipeline_prediction_is_conditional(
        {
            "prediction_basis": {
                "graph_revision": 2,
                "policy_revision": 1,
                "assumption": "unknown verifies pass",
                "generated_at": "2026-07-08T00:00:00Z",
            },
            "predicted_call_order": [{"node_id": "a", "confidence": "conditional"}],
        }
    )
    assert not tool._pipeline_prediction_is_conditional(
        {
            "prediction_basis": {
                "graph_revision": 2,
                "policy_revision": 1,
                "generated_at": "2026-07-08T00:00:00Z",
            },
            "predicted_call_order": [{"node_id": "a", "confidence": "certain"}],
        }
    )


def test_real_symphony_e2e_no_global_codex_home_rejects_home_path() -> None:
    tool = load_tool("real_symphony_e2e_run")
    home_codex = Path.home() / ".codex"

    assert tool._managed_run_avoids_global_codex_home(
        {
            "runtime_config": {
                "profiles": {
                    "plan": {"settings": {"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"}},
                }
            },
            "runtime_waits": [{"log_path": "/tmp/symphony/performer-000001.log"}],
        }
    )
    assert not tool._managed_run_avoids_global_codex_home(
        {
            "runtime_config": {
                "profiles": {
                    "plan": {"settings": {"codex_home_source": str(home_codex)}},
                }
            },
            "runtime_waits": [],
        }
    )


def test_real_symphony_e2e_integration_conflict_acceptance_uses_resolved_queue_item(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "integration-conflict",
        {
            "human_waits": [{"reason": "LINEAR_SYNC_CONFLICT", "status": "resolved"}],
            "integration_queue": [
                {
                    "status": "resolved",
                    "error": "patch conflict",
                    "human_resolution": "Linear human action child-1 completed.",
                }
            ],
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:integration-conflict-human-action"
    assert check["passed"] is True
    assert evidence.data["failures"] == []


def test_real_symphony_e2e_integration_conflict_rejects_untraced_resolved_queue_item() -> None:
    analysis = load_tool("real_symphony_e2e_analysis")

    assert not analysis.pipeline_has_conflict_escalation_evidence(
        {
            "human_waits": [],
            "integration_queue": [
                {
                    "status": "resolved",
                    "error": "patch conflict",
                    "human_resolution": "completed",
                }
            ],
        }
    )


def test_real_symphony_e2e_parallel_acceptance_requires_podium_pushed_policy_source(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "parallel",
        {
            "policy_id": "local-default",
            "policy_source": "local_default",
            "capacity": {"by_role": {"work_item": 2}},
            "attempts": [
                {"attempt_id": "exec-a", "mode": "execute", "started_at": "2026-07-08T00:00:00Z", "completed_at": "2026-07-08T00:01:00Z"},
                {"attempt_id": "exec-b", "mode": "execute", "started_at": "2026-07-08T00:00:30Z", "completed_at": "2026-07-08T00:01:30Z"},
            ],
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:parallel-execute-overlap"
    assert check["passed"] is False
    assert check["policy_id"] == "local-default"
    assert check["policy_source"] == "local_default"


def test_real_symphony_e2e_parallel_acceptance_requires_managed_run_tick_policy_match(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "parallel",
        {
            "policy_id": "policy-group-1",
            "policy_source": "podium_pushed",
            "last_managed_run_policy_id": "local-default",
            "last_managed_run_policy_version": 1,
            "last_managed_run_policy_source": "local_default",
            "runtime_config": {"managed_run_policy": {"policy_id": "policy-group-1", "version": 4}},
            "capacity": {"by_role": {"work_item": 2}},
            "attempts": [
                {"attempt_id": "exec-a", "mode": "execute", "started_at": "2026-07-08T00:00:00Z", "completed_at": "2026-07-08T00:01:00Z"},
                {"attempt_id": "exec-b", "mode": "execute", "started_at": "2026-07-08T00:00:30Z", "completed_at": "2026-07-08T00:01:30Z"},
            ],
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:parallel-execute-overlap"
    assert check["passed"] is False
    assert check["expected_managed_run_policy_id"] == "policy-group-1"
    assert check["last_managed_run_policy_id"] == "local-default"
    assert check["last_managed_run_policy_source"] == "local_default"


def test_real_symphony_e2e_parallel_acceptance_passes_with_matching_managed_run_tick_policy(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "parallel",
        {
            "policy_id": "policy-group-1",
            "policy_source": "podium_pushed",
            "last_managed_run_policy_id": "policy-group-1",
            "last_managed_run_policy_version": 4,
            "last_managed_run_policy_source": "podium_pushed",
            "last_managed_run_tick_at": "2026-07-08T00:00:00Z",
            "runtime_config": {"managed_run_policy": {"policy_id": "policy-group-1", "version": 4}},
            "capacity": {"by_role": {"work_item": 2}},
            "attempts": [
                {"attempt_id": "exec-a", "mode": "execute", "started_at": "2026-07-08T00:00:00Z", "completed_at": "2026-07-08T00:01:00Z"},
                {"attempt_id": "exec-b", "mode": "execute", "started_at": "2026-07-08T00:00:30Z", "completed_at": "2026-07-08T00:01:30Z"},
            ],
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:parallel-execute-overlap"
    assert check["passed"] is True
    assert evidence.data["failures"] == []


def test_real_symphony_e2e_parallel_acceptance_allows_final_lowered_capacity_after_overlap(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "parallel",
        {
            "policy_id": "policy-group-1",
            "policy_source": "podium_pushed",
            "last_managed_run_policy_id": "policy-group-1",
            "last_managed_run_policy_version": 5,
            "last_managed_run_policy_source": "podium_pushed",
            "last_managed_run_tick_at": "2026-07-08T00:02:00Z",
            "runtime_config": {"managed_run_policy": {"policy_id": "policy-group-1", "version": 5}},
            "capacity": {"by_role": {"work_item": 1}},
            "attempts": [
                {"attempt_id": "exec-a", "mode": "execute", "started_at": "2026-07-08T00:00:00Z", "completed_at": "2026-07-08T00:01:00Z"},
                {"attempt_id": "exec-b", "mode": "execute", "started_at": "2026-07-08T00:00:00Z", "completed_at": "2026-07-08T00:01:30Z"},
            ],
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:parallel-execute-overlap"
    assert check["passed"] is True
    assert check["work_item_limit"] == 1


def test_real_symphony_e2e_downstream_gate_uses_blocker_verify_times_not_latest_verify() -> None:
    tool = load_tool("real_symphony_e2e_run")

    evidence = tool._downstream_verify_gate_evidence(
        {
            "blocks": [["parallel-a", "downstream"], ["parallel-b-replan", "downstream"]],
            "attempts": [
                {
                    "attempt_id": "verify-a",
                    "node_id": "parallel-a",
                    "mode": "verify",
                    "score": 3,
                    "completed_at": "2026-07-08T00:01:00Z",
                },
                {
                    "attempt_id": "verify-b",
                    "node_id": "parallel-b-replan",
                    "mode": "verify",
                    "score": 3,
                    "completed_at": "2026-07-08T00:02:00Z",
                },
                {
                    "attempt_id": "execute-downstream",
                    "node_id": "downstream",
                    "mode": "execute",
                    "started_at": "2026-07-08T00:03:00Z",
                },
                {
                    "attempt_id": "verify-downstream",
                    "node_id": "downstream",
                    "mode": "verify",
                    "score": 3,
                    "completed_at": "2026-07-08T00:04:00Z",
                },
            ],
        }
    )

    assert evidence["gate_observed"] is True
    assert evidence["downstream_execute_attempts"] == ["execute-downstream"]
    assert set(evidence["verify_passed_attempts"]) == {"verify-a", "verify-b"}


def test_real_symphony_e2e_downstream_gate_requires_real_block_edges() -> None:
    tool = load_tool("real_symphony_e2e_run")

    evidence = tool._downstream_verify_gate_evidence(
        {
            "blocks": [],
            "attempts": [
                {
                    "attempt_id": "verify-a",
                    "node_id": "parallel-a",
                    "mode": "verify",
                    "score": 3,
                    "completed_at": "2026-07-08T00:01:00Z",
                },
                {
                    "attempt_id": "execute-downstream",
                    "node_id": "downstream",
                    "mode": "execute",
                    "started_at": "2026-07-08T00:02:00Z",
                },
            ],
        }
    )

    assert evidence["gate_observed"] is False
    assert evidence["reason"] == "no_block_edges"


def test_real_symphony_e2e_gate_normalization_acceptance_requires_gate_step_sources(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    evidence = tool.Evidence(tmp_path / "report.json")

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "gate-normalization",
        {
            "gates": [
                {
                    "gate_id": "gate-a",
                    "content": {
                        "verification_procedure": [
                            {"step": "test -f SYMPHONY_CONFLICT_SHARED.md", "source": "system_repair"},
                            {"step": "grep -q invented SYMPHONY_CONFLICT_SHARED.md", "source": "planner_inferred"},
                        ]
                    },
                }
            ]
        },
    )

    check = evidence.data["checks"][-1]
    assert check["name"] == "scenario:gate-normalization-provenance"
    assert check["passed"] is True

    tool._check_pipeline_scenario_acceptance(
        evidence,
        "gate-normalization",
        {
            "gates": [
                {
                    "gate_id": "gate-b",
                    "content": {"verification_procedure": [{"step": "grep -q invented file", "source": "planner_inferred"}]},
                }
            ]
        },
    )

    failed = evidence.data["checks"][-1]
    assert failed["passed"] is False
    assert evidence.data["failures"][-1]["name"] == "scenario:gate-normalization-provenance"


def test_real_symphony_e2e_failed_plan_artifact_lookup_uses_managed_run_turn_paths(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_artifacts")
    attempt_dir = tmp_path / "data" / "instances" / "inst-1" / "state" / "managed_run" / "plan-run-1-plan-1"
    request_path = attempt_dir / "turn-request.json"
    result_path = attempt_dir / "turn-result.json"
    request_path.parent.mkdir(parents=True)
    request_path.write_text(json.dumps({"turn_kind": "plan", "issue_description": "Create a result"}), encoding="utf-8")
    result_path.write_text(json.dumps({"error": "managed_codex_home_required"}), encoding="utf-8")

    paths = tool._failed_plan_attempt_paths(
        data_root=tmp_path / "data",
        instance_id="inst-1",
        failure={"failure": {"attempts": [{"attempt_id": "plan-run-1-plan-1", "mode": "plan"}]}},
    )

    assert paths == {"request": request_path, "result": result_path}


def test_real_symphony_e2e_archives_managed_run_view_and_linear_audit(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_runtime_artifacts")
    root = tmp_path / "e2e"
    data_root = tmp_path / "data"
    root.mkdir()
    (root / "final-managed-runs-view.json").write_text("{}", encoding="utf-8")
    (root / "final-linear-tree-audit.json").write_text("{}", encoding="utf-8")
    evidence = tool.Evidence(root / "report.json")

    tool.archive_managed_run_artifacts(evidence=evidence, root=root, data_root=data_root, instance_id="inst-1")

    assert evidence.data["artifacts"]["final_managed_runs_view"] == str(root / "final-managed-runs-view.json")
    assert evidence.data["artifacts"]["final_linear_tree_audit"] == str(root / "final-linear-tree-audit.json")


def test_real_symphony_e2e_archives_current_managed_db_and_runtime_logs(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_runtime_artifacts")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    root = tmp_path / "e2e"
    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, request, result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [attempt]})
    root.mkdir()
    (root / "podium.log").write_text("event=podium_started\n", encoding="utf-8")
    (root / "conductor.log").write_text("event=conductor_started\n", encoding="utf-8")
    instance_root = data_root / "instances" / "inst-1"
    _write_managed_turn_artifacts(instance_root, attempt, request, result)
    generation_log = instance_root / "logs" / "performer-000001.log"
    attempt_log = instance_root / "state" / "managed_run" / "plan-1" / "attempt.log"
    generation_log.write_text(generation_log.read_text(encoding="utf-8") + "message=token=secret-value\n", encoding="utf-8")
    attempt_log.write_text(attempt_log.read_text(encoding="utf-8") + "authorization: Bearer secret-value\n", encoding="utf-8")
    evidence = tool.Evidence(root / "report.json")

    tool.archive_managed_run_artifacts(evidence=evidence, root=root, data_root=data_root, instance_id="inst-1")

    archived_db = Path(evidence.data["artifacts"]["managed_run_db"])
    archived_generation = Path(evidence.data["artifacts"]["instance_log_generation_000001"])
    archived_attempt = Path(evidence.data["artifacts"]["attempt_plan-1_log"])
    assert archived_db == root / "runtime-artifacts" / "managed_run" / "managed_run.db"
    assert archived_db.is_file()
    assert "secret-value" not in archived_generation.read_text(encoding="utf-8")
    assert "secret-value" not in archived_attempt.read_text(encoding="utf-8")
    passed_checks = {check["name"] for check in evidence.data["checks"] if check["passed"]}
    assert {
        "runtime-artifacts:managed-run-db",
        "runtime-artifacts:generation-logs",
        "runtime-artifacts:attempt-logs",
        "runtime-artifacts:audit",
    } <= passed_checks
    assert Path(evidence.data["artifacts"]["runtime_claims_audit"]).is_file()


def test_real_symphony_e2e_archive_refuses_managed_db_with_secret(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_runtime_artifacts")
    from conductor.conductor_managed_run_state import ManagedRunState
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    root = tmp_path / "e2e"
    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, request, result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [attempt]})
    store.update_run_state(accepted.run_id, ManagedRunState.FAILED, reason="token=db-secret")
    _write_managed_turn_artifacts(data_root / "instances" / "inst-1", attempt, request, result)
    root.mkdir()
    (root / "podium.log").write_text("event=podium_started\n", encoding="utf-8")
    (root / "conductor.log").write_text("event=conductor_started\n", encoding="utf-8")
    evidence = tool.Evidence(root / "report.json")

    tool.archive_managed_run_artifacts(
        evidence=evidence,
        root=root,
        data_root=data_root,
        instance_id="inst-1",
    )

    assert "managed_run_db" not in evidence.data["artifacts"]
    assert not (root / "runtime-artifacts" / "managed_run" / "managed_run.db").exists()
    failure = next(check for check in evidence.data["failures"] if check["name"] == "runtime-artifacts:managed-run-db:archive")
    assert failure["error_code"] == "runtime_artifact_contains_secret"


def test_real_symphony_e2e_archive_rejects_wrong_managed_run_database(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_runtime_artifacts")
    root = tmp_path / "e2e"
    data_root = tmp_path / "data"
    root.mkdir()
    (root / "podium.log").write_text("event=podium_started\n", encoding="utf-8")
    (root / "conductor.log").write_text("event=conductor_started\n", encoding="utf-8")
    db_path = data_root / "managed_run" / "managed_run.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE evidence_probe (id TEXT PRIMARY KEY)")
    generation_log = data_root / "instances" / "inst-1" / "logs" / "performer-000001.log"
    generation_log.parent.mkdir(parents=True)
    generation_log.write_text("event=managed_run_turn_started\n", encoding="utf-8")
    attempt_root = data_root / "instances" / "inst-1" / "state" / "managed_run" / "plan-1"
    attempt_root.mkdir(parents=True)
    (attempt_root / "attempt.log").write_text("event=performer_stream\n", encoding="utf-8")
    (attempt_root / "turn-request.json").write_text("{}", encoding="utf-8")
    (attempt_root / "turn-result.json").write_text("{}", encoding="utf-8")
    evidence = tool.Evidence(root / "report.json")

    tool.archive_managed_run_artifacts(
        evidence=evidence,
        root=root,
        data_root=data_root,
        instance_id="inst-1",
    )

    failure = next(
        check
        for check in evidence.data["checks"]
        if check["name"] == "runtime-artifacts:audit"
    )
    assert failure["passed"] is False
    assert failure["error_code"] == "runtime_evidence_audit_failed"
    audit = json.loads(Path(evidence.data["artifacts"]["runtime_claims_audit"]).read_text(encoding="utf-8"))
    assert any(item.startswith("managed_run_table_missing:") for item in audit["failures"])


def test_real_symphony_e2e_records_missing_required_runtime_artifacts(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_runtime_artifacts")
    root = tmp_path / "e2e"
    evidence = tool.Evidence(root / "report.json")

    tool.archive_managed_run_artifacts(
        evidence=evidence,
        root=root,
        data_root=tmp_path / "data",
        instance_id="inst-1",
    )

    failures = {
        check["name"]: check
        for check in evidence.data["checks"]
        if not check["passed"]
    }
    assert {
        "runtime-artifacts:managed-run-db",
        "runtime-artifacts:generation-logs",
        "runtime-artifacts:attempt-logs",
        "runtime-artifacts:turn-requests",
        "runtime-artifacts:turn-results",
    } <= failures.keys()
    missing_checks = {
        name: failures[name]
        for name in (
            "runtime-artifacts:managed-run-db",
            "runtime-artifacts:generation-logs",
            "runtime-artifacts:attempt-logs",
            "runtime-artifacts:turn-requests",
            "runtime-artifacts:turn-results",
        )
    }
    assert all(check["error_code"] == "required_runtime_artifact_missing" for check in missing_checks.values())
    assert failures["runtime-artifacts:audit"]["error_code"] == "runtime_evidence_audit_failed"


def test_real_symphony_e2e_human_answered_push_accepts_completed_child_required_guard() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._human_answered_push_satisfies_resume_probe(200, {"status": "accepted"})
    assert tool._human_answered_push_satisfies_resume_probe(
        200,
        {"status": "ignored", "reason": "completed_child_required"},
    )
    assert not tool._human_answered_push_satisfies_resume_probe(200, {"status": "ignored", "reason": "human_wait_not_found"})


def test_real_symphony_e2e_wait_skips_stale_wait_resolved_by_attempt_success() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._wait_resolved_before_managed_run_resume({"status": "resolved", "resolution": "attempt succeeded"})
    assert not tool._wait_resolved_before_managed_run_resume({"status": "waiting", "resolution": None})
    assert not tool._wait_resolved_before_managed_run_resume({"status": "resolved", "resolution": "parent comment"})


def test_real_symphony_e2e_resume_observed_reads_resolved_runtime_waits() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    wait_ids = tool._resolved_pipeline_wait_ids(
        {
            "human_waits": [],
            "runtime_waits": [
                {"wait_id": "runtime-wait-exec-1-approval_requested", "status": "resolved"},
            ],
        }
    )

    assert wait_ids == {"runtime-wait-exec-1-approval_requested"}

def test_real_symphony_e2e_finds_runtime_wait_for_parent_comment_probe() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    wait = tool._pipeline_wait_by_id(
        {
            "human_waits": [],
            "runtime_waits": [
                {"wait_id": "runtime-wait-exec-1-approval_requested", "status": "waiting"},
            ],
        },
        "runtime-wait-exec-1-approval_requested",
    )

    assert wait == {"wait_id": "runtime-wait-exec-1-approval_requested", "status": "waiting"}


def test_real_symphony_e2e_tools_do_not_read_legacy_phase_runs() -> None:
    forbidden = [
        'run.get("phase")',
        "run.get('phase')",
        'run["phase"]',
        "run['phase']",
        '"/api/runs"',
        '"/api/runs/',
    ]
    for name in ["real_symphony_e2e_wait.py", "real_symphony_e2e_analysis.py", "real_concurrent_schedule_probe.py"]:
        text = (ROOT / "tools" / name).read_text(encoding="utf-8")
        for marker in forbidden:
            assert marker not in text, f"{name} still depends on legacy phase runs via {marker}"

def test_real_symphony_e2e_overload_failure_acceptance_detects_raw_status() -> None:
    tool = load_tool("real_symphony_e2e")
    run_result = {
        "state": {"sessions": [], "retry_attempts": [], "continuations": [], "blocked": []},
        "samples": [
            {
                "managed_run_work_items": [
                    {
                        "node_id": "node-1",
                        "state": "replanning",
                        "retry_count": 0,
                        "crash_count": 0,
                        "overload_count": 1,
                        "last_reason": "upstream_overloaded_exhausted",
                    },
                    {
                        "node_id": "node-1",
                        "state": "failed",
                        "retry_count": 0,
                        "crash_count": 0,
                        "overload_count": 2,
                        "last_reason": "upstream overload exhausted repeatedly",
                    },
                ],
            }
        ],
    }
    tree = {
        "children": {
            "nodes": [
                {
                    "identifier": "HELL-2",
                    "title": "[Human Action] HELL-1: Runtime error",
                    "description": "Upstream HTTP status: 502\n\nLast error:\nJSON-RPC error -32000: upstream 502: server overloaded",
                    "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                    "state": {"type": "unstarted"},
                }
            ]
        }
    }

    summary = tool.audit_expected_failure_run(run_result, tree, expected="overload")

    assert summary["pass"] is True
    assert summary["max_overload_count"] == 2
    assert summary["max_retry_count"] == 0
    assert summary["max_crash_count"] == 0
    assert summary["raw_error_in_linear"] is True
    assert summary["http_status_in_linear"] is True

def test_real_symphony_e2e_overload_failure_audit_reads_counters_from_child_description() -> None:
    tool = load_tool("real_symphony_e2e")

    summary = tool.audit_expected_failure_run(
        {
            "samples": [
                {
                    "managed_run_work_items": [
                        {
                            "state": "failed",
                            "last_reason": "upstream_overloaded_exhausted",
                        }
                    ]
                }
            ]
        },
        {
            "children": {
                "nodes": [
                    {
                        "title": "[Human Action] HELL-1",
                        "description": (
                            "Upstream HTTP status: 502\n\n"
                            "Last error:\nJSON-RPC error -32000: upstream 502: server overloaded\n"
                            "retry_count: 0\ncrash_count: 0\noverload_count: 6\n"
                        ),
                        "labels": {"nodes": [{"name": "performer:type/human-action"}]},
                    }
                ]
            }
        },
        expected="overload",
    )

    assert summary["pass"] is True
    assert summary["max_overload_count"] == 6

def test_real_symphony_e2e_tracks_one_automatic_human_action_per_wait() -> None:
    tool = load_tool("real_symphony_e2e")
    completed: set[str] = set()
    first = {"wait_id": "wait-1", "child_issue_id": "child-1"}
    second = {"wait_id": "wait-1", "child_issue_id": "child-2"}

    assert tool.should_complete_conductor_human_action(first, completed) is True
    completed.add("wait-1")
    assert tool.should_complete_conductor_human_action(second, completed) is False

def test_real_symphony_e2e_completes_runtime_wait_child_actions() -> None:
    tool = load_tool("real_symphony_e2e")

    action = {
        "wait_id": "runtime-wait-execute-1-approval_requested",
        "child_issue_id": "child-runtime-1",
        "details": {"wait_kind": "approval_requested"},
    }

    assert tool.should_complete_conductor_human_action(action, set()) is True

def test_real_symphony_e2e_writes_human_response_into_child_description() -> None:
    tool = load_tool("real_symphony_e2e")

    updated = tool.human_action_description_with_response(
        "Runtime error.\n\nHuman response:\n\n(Add the answer or decision here when information is required.)\n\nWhen finished, move this child issue to Done.",
        "Symphony E2E resume approval for human wait wait-1 on child HELL-2.\n"
        "This is the explicit human-action resume signal; retry the managed run.",
    )

    assert "Human response:\nSymphony E2E resume approval for human wait wait-1 on child HELL-2." in updated
    assert "This is the explicit human-action resume signal; retry the managed run.\n\nWhen finished" in updated
    assert "(Add the answer or decision here when information is required.)" not in updated

async def test_real_symphony_e2e_completes_conductor_human_action_child(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[tuple[str, dict[str, object]]] = []

    async def fake_linear_graphql(token, query, variables):
        del token
        calls.append((query, variables))
        if "query HumanActionIssue" in query:
            return {
                "issue": {
                    "id": "child-1",
                    "identifier": "HELL-2",
                    "description": "Human response:\n\nWhen finished, move this child issue to Done.",
                    "state": {"name": "Todo", "type": "unstarted"},
                    "team": {
                        "states": {
                            "nodes": [
                                {"id": "state-todo", "name": "Todo", "type": "unstarted"},
                                {"id": "state-done", "name": "Done", "type": "completed"},
                            ]
                        }
                    },
                }
            }
        if "mutation UpdateHumanActionDescription" in query:
            return {"issueUpdate": {"success": True, "issue": {"id": "child-1", "identifier": "HELL-2"}}}
        if "mutation MoveHumanActionIssue" in query:
            return {
                "issueUpdate": {
                    "success": True,
                    "issue": {"id": "child-1", "identifier": "HELL-2", "state": {"name": "Done", "type": "completed"}},
                }
            }
        raise AssertionError(query)

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    result = await tool.complete_conductor_human_action(
        "linear-token",
        {
            "run_id": "run-1",
            "issue_identifier": "HELL-1",
            "child_issue_id": "child-1",
            "child_identifier": "HELL-2",
            "wait_id": "wait-1",
            "kind": "runtime_error",
        },
        response=tool.e2e_human_action_resume_response(
            {
                "wait_id": "wait-1",
                "child_issue_id": "child-1",
                "child_identifier": "HELL-2",
                "reason": "LINEAR_SYNC_CONFLICT",
            }
        ),
    )

    assert result["status"] == "completed"
    assert calls[1][1]["description"].startswith(
        "Human response:\nSymphony E2E resume approval for human wait wait-1 on child HELL-2."
    )
    assert "reason=LINEAR_SYNC_CONFLICT" in calls[1][1]["description"]
    assert calls[2][1] == {"issueId": "child-1", "stateId": "state-done"}

def test_real_symphony_e2e_parent_comment_probe_is_explicit_negative_control() -> None:
    tool = load_tool("real_symphony_e2e")

    body = tool.parent_comment_negative_control_body("wait-1")

    assert "negative control" in body
    assert "wait_id=wait-1" in body
    assert "No action is required" in body
    assert "not a Symphony human-action resume command" in body

def test_real_symphony_e2e_surfaces_immediate_managed_run_failures() -> None:
    tool = load_tool("real_symphony_e2e")

    failure = tool.immediate_pipeline_failure(
        {
            "managed_run_attempts": [
                {
                    "attempt_id": "plan-1",
                    "mode": "plan",
                    "state": "failed",
                    "error": "managed_codex_home_required",
                }
            ],
            "managed_run_work_items": [{"node_id": "issue-1", "state": "need_human"}],
        }
    )

    assert failure == {
        "kind": "attempt_failed",
        "attempts": [
            {
                "attempt_id": "plan-1",
                "mode": "plan",
                "state": "failed",
                "error": "managed_codex_home_required",
            }
        ],
    }


def test_real_symphony_e2e_allows_retryable_plan_validation_attempt() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    failure = tool.immediate_pipeline_failure(
        {
            "managed_run_attempts": [{"attempt_id": "plan-1", "state": "failed", "retryable": True}],
            "managed_run_runs": [{"run_id": "run-1", "state": "planning"}],
        }
    )

    assert failure is None


def test_real_symphony_e2e_expected_failure_mode_keeps_waiting_for_failure_audit() -> None:
    tool = load_tool("real_symphony_e2e")

    assert (
        tool.immediate_pipeline_failure(
            {"managed_run_attempts": [{"attempt_id": "plan-1", "state": "failed"}]},
            expected_failure="overload",
        )
        is None
    )


def test_real_symphony_e2e_permission_probe_keeps_waiting_on_runtime_wait() -> None:
    tool = load_tool("real_symphony_e2e")

    assert (
        tool.immediate_pipeline_failure(
            {
                "managed_run_human_actions": [
                    {
                        "wait_id": "runtime-wait-exec-1-approval_requested",
                        "reason": "approval_requested",
                        "details": {"wait_kind": "approval_requested"},
                    }
                ]
            },
            permission_approval_probe=True,
        )
        is None
    )


def test_real_symphony_e2e_crash_probe_filter_exempts_probe_and_keeps_real_failures() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._immediate_failure_without_attempt(
        {
            "kind": "attempt_failed",
            "attempts": [
                {"attempt_id": "execute-crash-probe", "mode": "execute", "state": "failed"},
                {"attempt_id": "plan-real-failure", "mode": "plan", "state": "failed"},
            ],
        },
        "execute-crash-probe",
    ) == {
        "kind": "attempt_failed",
        "attempts": [{"attempt_id": "plan-real-failure", "mode": "plan", "state": "failed"}],
    }

    assert (
        tool._immediate_failure_without_attempt(
            {
                "kind": "attempt_failed",
                "attempts": [{"attempt_id": "execute-crash-probe", "mode": "execute", "state": "failed"}],
            },
            "execute-crash-probe",
        )
        is None
    )


def test_real_symphony_e2e_immediate_failure_detects_failed_managed_run_without_work_items() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    failure = tool.immediate_pipeline_failure(
        {
            "managed_run_runs": [
                {
                    "run_id": "run-1",
                    "state": "failed",
                    "latest_reason": "plan_result_missing_after_process_exit",
                    "work_items": [],
                }
            ],
            "managed_run_work_items": [],
            "managed_run_attempts": [],
        }
    )

    assert failure == {
        "kind": "managed_run_failed",
        "runs": [
            {
                "run_id": "run-1",
                "state": "failed",
                "latest_reason": "plan_result_missing_after_process_exit",
                "work_items": [],
            }
        ],
    }


def test_real_symphony_e2e_immediate_failure_sanitizes_nested_error_details(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_wait_loop")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")
    state = SimpleNamespace(
        expected_failure="none",
        permission_approval_probe=False,
        pipeline_scenario="basic",
        crash_recovery_probe=False,
        crash_killed=False,
        crash_attempt_id=None,
        evidence=evidence,
    )
    monkeypatch.setattr(tool, "write_wait_state_artifacts", lambda _state: {})

    tool._handle_immediate_failure(
        state,
        {
            "process_status": "exited",
            "managed_run_attempts": [
                {
                    "attempt_id": "plan-1",
                    "state": "failed",
                    "retryable": False,
                    "error": "token=secret-value backend setup failed",
                }
            ],
            "managed_run_runs": [],
            "managed_run_work_items": [],
            "managed_run_human_actions": [],
        },
    )

    rendered = json.dumps(evidence.data, sort_keys=True)
    assert "secret-value" not in rendered
    assert "token=[REDACTED] backend setup failed" in rendered


def test_real_symphony_e2e_progress_output_sanitizes_latest_reason(capsys) -> None:
    tool = load_tool("real_symphony_e2e_wait_loop")

    tool._print_progress(
        {"at": "2026-07-11T00:00:00Z", "issue_state": "In Progress", "result_exists": False},
        "running",
        [{"run_id": "run-1", "state": "failed", "latest_reason": "clientSecret=stdout-secret"}],
        [],
        [],
        [],
        [],
    )

    output = capsys.readouterr().out
    assert "stdout-secret" not in output
    assert "clientSecret=[REDACTED]" in output


def test_real_symphony_e2e_immediate_failure_detects_unexpected_blocked_basic_run() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    failure = tool.immediate_pipeline_failure(
        {
            "managed_run_runs": [{"run_id": "run-1", "state": "blocked", "latest_reason": "gate_failed"}],
            "managed_run_work_items": [{"node_id": "wi-1", "state": "need_human", "gate_status": "gate_failed"}],
            "managed_run_attempts": [],
            "managed_run_human_actions": [],
        },
        pipeline_scenario="basic",
    )

    assert failure == {
        "kind": "managed_run_blocked",
        "runs": [{"run_id": "run-1", "state": "blocked", "latest_reason": "gate_failed"}],
    }


def test_real_symphony_e2e_allows_expected_runtime_wait_before_resuming() -> None:
    tool = load_tool("real_symphony_e2e_wait")
    wait = {
        "wait_id": "wait-1",
        "reason": "approval_requested",
        "details": {"wait_kind": "approval_requested"},
    }

    assert (
        tool.immediate_pipeline_failure(
            {
                "managed_run_runs": [{"run_id": "run-1", "state": "blocked"}],
                "managed_run_work_items": [{"node_id": "wi-1", "state": "need_human"}],
                "managed_run_human_actions": [wait],
            },
            pipeline_scenario="runtime-wait",
        )
        is None
    )


def test_real_symphony_e2e_summary_includes_failure_details() -> None:
    tool = load_tool("real_symphony_e2e")

    summary = tool.e2e_report_summary(
        {
            "failures": [
                {
                    "name": "managed-run-runtime-error:visible",
                    "failure": {
                        "kind": "attempt_failed",
                        "attempts": [{"attempt_id": "plan-1", "error": "managed_codex_home_required"}],
                    },
                }
            ]
        },
        report_path=ROOT / ".test-real-flow" / "report.json",
    )

    assert summary["failures"] == 1
    assert summary["failure_summaries"] == [
        {
            "name": "managed-run-runtime-error:visible",
            "failure": {
                "kind": "attempt_failed",
                "attempts": [{"attempt_id": "plan-1", "error": "managed_codex_home_required"}],
            },
        }
    ]


def test_real_symphony_e2e_evidence_records_blocked_stages_and_checkpoints(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "report.json")

    evidence.blocked(
        "06-graph-shape",
        blocked_by="04-dispatch-and-plan",
        reason="plan_commit_failed",
        upstream_check="managed-run-runtime-error:visible",
    )
    checkpoint_path = evidence.checkpoint(
        "04-dispatch-and-plan",
        {"status": "failed", "failure": {"kind": "attempt_failed"}},
    )

    assert checkpoint_path == tmp_path / "checkpoints" / "04-dispatch-and-plan.json"
    assert checkpoint_path.exists()
    assert evidence.data["blocked"] == [
        {
            "name": "06-graph-shape",
            "blocked_by": "04-dispatch-and-plan",
            "reason": "plan_commit_failed",
            "details": {"upstream_check": "managed-run-runtime-error:visible"},
            "upstream_check": "managed-run-runtime-error:visible",
        }
    ]
    assert evidence.data["stages"][-1]["stage"] == "04-dispatch-and-plan"
    assert evidence.data["stages"][-1]["status"] == "failed"
    assert evidence.data["artifacts"]["checkpoint:04-dispatch-and-plan"] == str(checkpoint_path)


def test_real_symphony_e2e_summary_includes_blocked_and_first_blocker() -> None:
    tool = load_tool("real_symphony_e2e")

    summary = tool.e2e_report_summary(
        {
            "failures": [
                {
                    "name": "managed-run-runtime-error:visible",
                    "reason": "plan_commit_failed",
                }
            ],
            "blocked": [
                {
                    "name": "06-graph-shape",
                    "blocked_by": "04-dispatch-and-plan",
                    "reason": "plan_commit_failed",
                }
            ],
            "actionable_root_causes": [
                {
                    "code": "intent_shadowed_by_empty_intent",
                    "summary": "empty intent shadowed managed_run_intent",
                }
            ],
        },
        report_path=ROOT / ".test-real-flow" / "report.json",
    )

    assert summary["failures"] == 1
    assert summary["blocked"] == 1
    assert summary["first_blocker"] == {
        "name": "managed-run-runtime-error:visible",
        "reason": "plan_commit_failed",
    }
    assert summary["blocked_summaries"] == [
        {
            "name": "06-graph-shape",
            "blocked_by": "04-dispatch-and-plan",
            "reason": "plan_commit_failed",
        }
    ]
    assert summary["actionable_root_causes"] == [
        {
            "code": "intent_shadowed_by_empty_intent",
                "summary": "empty intent shadowed managed_run_intent",
        }
    ]


def test_real_symphony_e2e_wait_artifacts_are_written_on_early_exit(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "report.json")
    result_path = tmp_path / "missing-result.md"
    result = tool.write_wait_artifacts(
        evidence=evidence,
        samples=[{"at": "2026-07-04T00:00:00Z", "phase": "need_human"}],
        result_path=result_path,
        final_issue={"id": "issue-1", "identifier": "HELL-1", "state": {"name": "In Progress"}},
        log_path=tmp_path / "performer-000001.log",
        stages={"poller_queued": "2026-07-04T00:00:00Z"},
        stage_timeout_seconds=60,
    )

    assert Path(evidence.data["artifacts"]["runtime_samples"]).exists()
    assert Path(evidence.data["artifacts"]["stage_snapshot"]).exists()
    assert Path(evidence.data["artifacts"]["final_issue"]).exists()
    assert "state" not in result
    assert "ops" not in result


def test_real_symphony_e2e_wait_artifacts_are_sanitized(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "report.json")
    result_path = tmp_path / "workspace-result.md"
    result_path.write_text("token=workspace-secret\n", encoding="utf-8")

    result = tool.write_wait_artifacts(
        evidence=evidence,
        samples=[{"error": "api_key=sample-secret"}],
        result_path=result_path,
        final_issue={"id": "issue-1", "description": "password=issue-secret"},
        log_path=tmp_path / "performer-000001.log",
        stages={"poller_queued": "2026-07-04T00:00:00Z"},
        stage_timeout_seconds=60,
    )

    artifacts = [Path(path) for path in evidence.data["artifacts"].values()]
    rendered = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in artifacts)
    assert "workspace-secret" not in rendered
    assert "sample-secret" not in rendered
    assert "issue-secret" not in rendered
    assert "sample-secret" not in json.dumps(result, sort_keys=True)


async def test_real_symphony_e2e_early_exit_archives_available_runtime_evidence(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_early_exit")
    root = tmp_path / "e2e"
    data_root = root / "conductor-data"
    instance_root = data_root / "instances" / "inst-1"
    (instance_root / "state").mkdir(parents=True)
    (instance_root / "logs").mkdir()
    (root / "podium.log").write_text("podium event\n", encoding="utf-8")
    (root / "conductor.log").write_text("conductor event\n", encoding="utf-8")
    db_path = data_root / "managed_run" / "managed_run.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE evidence_probe (id TEXT PRIMARY KEY)")
    (instance_root / "logs" / "performer-000001.log").write_text("performer event\n", encoding="utf-8")
    attempt_log = instance_root / "state" / "managed_run" / "plan-1" / "attempt.log"
    attempt_log.parent.mkdir(parents=True)
    attempt_log.write_text("attempt event\n", encoding="utf-8")
    evidence = load_tool("real_symphony_e2e").Evidence(root / "report.json")
    state = SimpleNamespace(
        evidence=evidence,
        root=root,
        data_root=data_root,
        instance_id="inst-1",
        conductor_port=8081,
        token="token",
        linear={},
    )
    monkeypatch.setattr(tool, "http_json", lambda *_args, **_kwargs: (503, {"error": "unavailable"}))

    await tool.archive_early_exit_artifacts(state)

    assert Path(evidence.data["artifacts"]["podium_log"]).exists()
    assert Path(evidence.data["artifacts"]["conductor_log"]).exists()
    assert Path(evidence.data["artifacts"]["instance_log_generation_000001"]).exists()
    assert Path(evidence.data["artifacts"]["managed_run_db"]).exists()
    assert Path(evidence.data["artifacts"]["attempt_plan-1_log"]).exists()
    snapshot = Path(evidence.data["artifacts"]["early_managed_runs_view"])
    assert json.loads(snapshot.read_text(encoding="utf-8"))["status"] == 503
    assert evidence.data["artifacts"]["managed_run_e2e_report"] == str(root / "report.json")


async def test_real_symphony_e2e_archives_before_process_cleanup_after_unhandled_exception(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_orchestrator")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")
    staging_root = tmp_path / "symphony-e2e-codex-test"
    staged_codex_home = staging_root / "home"
    staged_codex_home.mkdir(parents=True)
    data_root = tmp_path / "conductor-data"
    runtime_auth = data_root / "instances" / "inst-1" / "runtime-homes" / "plan" / "plan-1" / "codex" / "auth.json"
    runtime_auth.parent.mkdir(parents=True)
    runtime_auth.write_text('{"token":"runtime-secret"}\n', encoding="utf-8")

    class Process:
        stopped = False

        def stop(self) -> None:
            self.stopped = True

    process = Process()
    state = SimpleNamespace(
        evidence=evidence,
        processes=[process],
        postgres_container=None,
        staged_codex_home=staged_codex_home,
        data_root=data_root,
    )
    archived_before_cleanup: list[bool] = []

    async def build_initial_state(_args):
        return state

    async def start_podium_and_enroll(_state) -> None:
        raise RuntimeError("Authorization: Bearer secret-value failed")

    async def archive_early_exit_artifacts(_state) -> None:
        archived_before_cleanup.append(process.stopped)

    monkeypatch.setattr(tool, "build_initial_state", build_initial_state)
    monkeypatch.setattr(tool, "run_connectivity_preflight", lambda _state: _async_true())
    monkeypatch.setattr(tool, "prepare_fixture_and_cli", lambda _state: None)
    monkeypatch.setattr(tool, "start_podium_and_enroll", start_podium_and_enroll)
    monkeypatch.setattr(tool, "archive_early_exit_artifacts", archive_early_exit_artifacts, raising=False)
    monkeypatch.setattr(tool, "stop_e2e_postgres", lambda _container: None)

    report = await tool.run(SimpleNamespace())

    assert archived_before_cleanup == [False]
    assert process.stopped is True
    assert not staging_root.exists()
    assert not runtime_auth.exists()
    assert any(
        check.get("name") == "runtime-config:e2e-runtime-credentials-cleaned" and check.get("removed_auth_files") == 1
        for check in report["checks"]
    )
    assert report["failures"][0]["name"] == "real-e2e:unhandled-exception"
    assert "secret-value" not in report["failures"][0]["sanitized_reason"]


async def test_real_symphony_e2e_scrubs_runtime_credentials_when_process_cleanup_fails(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_orchestrator")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")
    data_root = tmp_path / "conductor-data"
    runtime_auth = data_root / "instances" / "inst-1" / "runtime-homes" / "plan" / "plan-1" / "codex" / "auth.json"
    runtime_auth.parent.mkdir(parents=True)
    runtime_auth.write_text('{"token":"runtime-secret"}\n', encoding="utf-8")

    class Process:
        def stop(self) -> None:
            raise RuntimeError("process cleanup failed")

    state = SimpleNamespace(evidence=evidence, processes=[Process()], postgres_container=None, data_root=data_root)

    async def build_initial_state(_args):
        return state

    async def archive_early_exit_artifacts(_state) -> None:
        return None

    monkeypatch.setattr(tool, "build_initial_state", build_initial_state)
    monkeypatch.setattr(tool, "run_connectivity_preflight", lambda _state: _async_false())
    monkeypatch.setattr(tool, "archive_early_exit_artifacts", archive_early_exit_artifacts, raising=False)
    monkeypatch.setattr(tool, "stop_e2e_postgres", lambda _container: None)

    report = await tool.run(SimpleNamespace())

    assert not runtime_auth.exists()
    assert any(failure.get("name") == "real-e2e:process-cleanup-failed" for failure in report["failures"])


async def test_real_symphony_e2e_records_bootstrap_failure(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_orchestrator")
    linear = load_tool("real_symphony_e2e_linear_core")

    async def build_initial_state(_args):
        raise linear.LinearE2EError(
            failure_class="credential_or_config_failure",
            error_code="linear_authentication_failed",
            sanitized_reason="Linear authentication failed.",
            retryable=False,
            next_action="refresh_linear_app_access_token",
        )

    monkeypatch.setattr(tool, "build_initial_state", build_initial_state)

    report = await tool.run(SimpleNamespace(out=tmp_path))

    failure = report["failures"][0]
    assert failure["failure_class"] == "credential_or_config_failure"
    assert failure["error_code"] == "linear_authentication_failed"
    assert failure["next_action"] == "refresh_linear_app_access_token"
    assert (tmp_path / "real-symphony-e2e-report.json").is_file()


def test_real_symphony_e2e_early_exit_sanitizes_client_secret(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_early_exit")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")

    tool.record_unhandled_e2e_exception(
        evidence,
        RuntimeError("client_secret=secret-value callback failed"),
    )

    rendered = json.dumps(evidence.data, sort_keys=True)
    assert "secret-value" not in rendered
    assert "client_secret=[REDACTED] callback failed" in rendered


async def test_real_symphony_e2e_records_archive_failure_and_still_stops_processes(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_orchestrator")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")

    class Process:
        stopped = False

        def stop(self) -> None:
            self.stopped = True

    process = Process()
    state = SimpleNamespace(evidence=evidence, processes=[process], postgres_container=None)

    async def build_initial_state(_args):
        return state

    async def archive_early_exit_artifacts(_state) -> None:
        raise RuntimeError("token=secret-value archive failed")

    monkeypatch.setattr(tool, "build_initial_state", build_initial_state)
    monkeypatch.setattr(tool, "run_connectivity_preflight", lambda _state: _async_false())
    monkeypatch.setattr(tool, "archive_early_exit_artifacts", archive_early_exit_artifacts, raising=False)
    monkeypatch.setattr(tool, "stop_e2e_postgres", lambda _container: None)

    report = await tool.run(SimpleNamespace())

    assert process.stopped is True
    assert report["failures"][0]["name"] == "real-e2e:evidence-archive-failed"
    assert "secret-value" not in report["failures"][0]["sanitized_reason"]


async def test_real_symphony_e2e_linear_auth_failure_is_immediate_and_classified(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_linear_core")
    calls = 0

    class Response:
        status_code = 401

        @staticmethod
        def json() -> dict:
            return {"errors": [{"message": "Authentication required", "extensions": {"code": "AUTHENTICATION_ERROR"}}]}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, *_args, **_kwargs) -> Response:
            nonlocal calls
            calls += 1
            return Response()

    monkeypatch.setattr(tool.httpx, "AsyncClient", lambda **_kwargs: Client())

    with pytest.raises(tool.LinearE2EError) as error:
        await tool.linear_graphql("token", "query Viewer { viewer { id } }", {})

    assert calls == 1
    assert error.value.failure_class == "credential_or_config_failure"
    assert error.value.error_code == "linear_authentication_failed"
    assert error.value.retryable is False


async def test_real_symphony_e2e_linear_app_user_scope_failure_is_immediate_and_classified(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_linear_core")
    calls = 0

    class Response:
        status_code = 200

        @staticmethod
        def json() -> dict:
            return {
                "errors": [
                    {
                        "message": "App user not valid",
                        "extensions": {
                            "code": "INPUT_ERROR",
                            "statusCode": 400,
                            "userPresentableMessage": "One or more app users lack the required scope.",
                        },
                    }
                ]
            }

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, *_args, **_kwargs) -> Response:
            nonlocal calls
            calls += 1
            return Response()

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(tool.httpx, "AsyncClient", lambda **_kwargs: Client())
    monkeypatch.setattr(tool.asyncio, "sleep", no_sleep)

    with pytest.raises(tool.LinearE2EError) as error:
        await tool.linear_graphql("token", "mutation DelegateIssue { issueUpdate { success } }", {})

    assert calls == 1
    assert error.value.failure_class == "credential_or_config_failure"
    assert error.value.error_code == "linear_app_user_scope_invalid"
    assert error.value.retryable is False
    assert error.value.next_action == "refresh_linear_app_access_token_with_app_assignable_scope"


def test_real_symphony_e2e_records_external_failure_classification(tmp_path: Path) -> None:
    early_exit = load_tool("real_symphony_e2e_early_exit")
    linear = load_tool("real_symphony_e2e_linear_core")
    evidence = load_tool("real_symphony_e2e").Evidence(tmp_path / "report.json")

    early_exit.record_unhandled_e2e_exception(
        evidence,
        linear.LinearE2EError(
            failure_class="credential_or_config_failure",
            error_code="linear_authentication_failed",
            sanitized_reason="Linear authentication failed.",
            retryable=False,
            next_action="refresh_linear_app_access_token",
        ),
    )

    failure = evidence.data["failures"][0]
    assert failure["failure_class"] == "credential_or_config_failure"
    assert failure["error_code"] == "linear_authentication_failed"
    assert failure["next_action"] == "refresh_linear_app_access_token"


async def _async_true() -> bool:
    return True


async def _async_false() -> bool:
    return False
