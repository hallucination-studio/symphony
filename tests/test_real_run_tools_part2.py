from test_real_run_tools_support import *  # noqa: F401,F403

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

def test_real_symphony_e2e_detects_conductor_phase_human_action() -> None:
    tool = load_tool("real_symphony_e2e")

    actions = tool.conductor_human_actions(
        {
            "runs": [
                {
                    "run_id": "run-1",
                    "issue_id": "issue-1",
                    "issue_identifier": "HELL-1",
                    "phase": "awaiting_human",
                    "status": "waiting",
                    "last_reason": "codex needs local state repair",
                    "human_action": {
                        "child_issue_id": "child-1",
                        "child_identifier": "HELL-2",
                        "child_url": "https://linear.test/HELL-2",
                        "kind": "runtime_error",
                    },
                },
                {"run_id": "run-2", "phase": "done"},
            ]
        }
    )

    assert actions == [
        {
            "run_id": "run-1",
            "issue_id": "issue-1",
            "issue_identifier": "HELL-1",
            "phase": "awaiting_human",
            "status": "waiting",
            "last_reason": "codex needs local state repair",
            "child_issue_id": "child-1",
            "child_identifier": "HELL-2",
            "child_url": "https://linear.test/HELL-2",
            "kind": "runtime_error",
        }
    ]

def test_real_symphony_e2e_overload_failure_acceptance_detects_raw_status() -> None:
    tool = load_tool("real_symphony_e2e")
    run_result = {
        "state": {"sessions": [], "retry_attempts": [], "continuations": [], "blocked": []},
        "samples": [
            {
                "phase_runs": [
                    {
                        "run_id": "run-1",
                        "phase": "queued",
                        "status": "queued",
                        "retry_count": 0,
                        "crash_count": 0,
                        "overload_count": 1,
                        "last_reason": "upstream_overloaded_exhausted",
                    },
                    {
                        "run_id": "run-1",
                        "phase": "failed",
                        "status": "failed",
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
                    "phase_runs": [
                        {
                            "phase": "failed",
                            "status": "failed",
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

def test_real_symphony_e2e_tracks_one_automatic_human_action_per_run() -> None:
    tool = load_tool("real_symphony_e2e")
    completed: set[str] = set()
    first = {"run_id": "run-1", "child_issue_id": "child-1"}
    second = {"run_id": "run-1", "child_issue_id": "child-2"}

    assert tool.should_complete_conductor_human_action(first, completed) is True
    completed.add("run-1")
    assert tool.should_complete_conductor_human_action(second, completed) is False

def test_real_symphony_e2e_writes_human_response_into_child_description() -> None:
    tool = load_tool("real_symphony_e2e")

    updated = tool.human_action_description_with_response(
        "Runtime error.\n\nHuman response:\n\n(Add the answer or decision here when information is required.)\n\nWhen finished, move this child issue to Done.",
        "Reviewed by the E2E harness; retry the managed run.",
    )

    assert "Human response:\nReviewed by the E2E harness; retry the managed run.\n\nWhen finished" in updated
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
            "kind": "runtime_error",
        },
        response="Reviewed by the E2E harness; retry the managed run.",
    )

    assert result["status"] == "completed"
    assert calls[1][1]["description"].startswith("Human response:\nReviewed by the E2E harness")
    assert calls[2][1] == {"issueId": "child-1", "stateId": "state-done"}

def test_real_symphony_e2e_wait_artifacts_are_written_on_early_exit(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "report.json")
    result_path = tmp_path / "missing-result.md"
    state_path = tmp_path / "performer.json"
    ops_path = tmp_path / "ops.json"
    state_path.write_text('{"sessions": []}', encoding="utf-8")
    ops_path.write_text('{"runs": {}}', encoding="utf-8")

    result = tool.write_wait_artifacts(
        evidence=evidence,
        samples=[{"at": "2026-07-04T00:00:00Z", "phase": "awaiting_human"}],
        result_path=result_path,
        final_issue={"id": "issue-1", "identifier": "HELL-1", "state": {"name": "In Progress"}},
        state_path=state_path,
        last_state={},
        ops_path=ops_path,
        last_ops={},
        log_path=tmp_path / "performer.log",
        stages={"webhook_queued": "2026-07-04T00:00:00Z"},
        stage_timeout_seconds=60,
    )

    assert Path(evidence.data["artifacts"]["runtime_samples"]).exists()
    assert Path(evidence.data["artifacts"]["stage_snapshot"]).exists()
    assert Path(evidence.data["artifacts"]["final_issue"]).exists()
    assert result["state"] == {"sessions": []}
    assert result["ops"] == {"runs": {}}
