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
                    "state": "awaiting_human",
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
            "state": "awaiting_human",
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


def test_real_symphony_e2e_final_view_uses_parent_aggregate_state() -> None:
    tool = load_tool("real_symphony_e2e_run")

    pipeline_view = {
        "graph_revision": 2,
        "nodes": [
            {
                "node_id": "parent",
                "state": "planned",
                "aggregate_state": "verify_passed",
                "gate_snapshot_hash": "gate-parent",
            },
            {"node_id": "child-a", "state": "verify_passed", "aggregate_state": "verify_passed"},
            {"node_id": "child-b", "state": "verify_passed", "aggregate_state": "verify_passed"},
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
            "pipeline_human_actions": [],
            "pipeline_leases": [{"lease_id": "execute-lease-1", "mode": "execute"}],
        }
    )
    assert not tool._permission_probe_block_cleared(
        {
            "pipeline_human_actions": [
                {
                    "wait_id": "runtime-wait-exec-1-approval_requested",
                    "status": "waiting",
                    "details": {"wait_kind": "approval_requested"},
                }
            ],
            "pipeline_leases": [{"lease_id": "execute-lease-1", "mode": "execute"}],
        }
    )


def test_appendix_exit_bar_audit_requires_all_overall_items() -> None:
    tool = load_tool("real_symphony_e2e")
    reports = [
        {
            "failures": [],
            "checks": [
                {"name": "stage:pipeline-gates-frozen", "passed": True},
                {"name": "stage:pipeline-linear-projected", "passed": True},
                {"name": "scenario:parallel-execute-overlap", "passed": True},
                {"name": "runtime-config:podium-pushed", "passed": True},
                {"name": "stage:pipeline-manifest-published", "passed": True},
                {"name": "stage:final-pipeline-verified", "passed": True},
                {"name": "appendix:s3-verifier-mutation-detection", "passed": True},
                {"name": "appendix:s3-expired-fencing-refused", "passed": True},
                {"name": "scenario:replan-replacement-subgraph", "passed": True},
                {"name": "scenario:integration-conflict-human-action", "passed": True},
                {"name": "conductor-api:GET /api/pipeline", "passed": True},
                {"name": "appendix:pipeline-prediction-conditional", "passed": True},
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
            "stage:pipeline-gates-frozen",
            "stage:pipeline-linear-projected",
            "scenario:parallel-execute-overlap",
            "runtime-config:podium-pushed",
            "stage:pipeline-manifest-published",
            "stage:final-pipeline-verified",
            "appendix:s3-verifier-mutation-detection",
            "appendix:s3-expired-fencing-refused",
            "scenario:replan-replacement-subgraph",
            "scenario:integration-conflict-human-action",
            "conductor-api:GET /api/pipeline",
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
                "execute": {"settings": {"codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SOURCE"}},
                "verify": {"backend": "local-verifier", "settings": {}},
            }
        },
        "nodes": [
            {"node_id": "parent", "state": "verify_passed"},
            {"node_id": "child-a", "parent_node_id": "parent", "state": "verify_passed"},
            {"node_id": "child-b", "parent_node_id": "parent", "state": "verify_passed"},
            {"node_id": "old", "state": "superseded", "superseded_by": ["replacement"]},
            {"node_id": "replacement", "state": "verify_passed"},
        ],
        "attempts": [
            {
                "attempt_id": "verify-child-a",
                "node_id": "child-a",
                "mode": "verify",
                "score": 3,
                "completed_at": "2026-07-08T00:00:10Z",
                "state": "succeeded",
            },
            {
                "attempt_id": "execute-child-b",
                "node_id": "child-b",
                "mode": "execute",
                "started_at": "2026-07-08T00:00:11Z",
                "state": "succeeded",
            },
        ],
        "integration_queue": [
            {"status": "resolved", "error": "patch conflict", "human_resolution": "completed"}
        ],
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
    assert checks["appendix:evidence-scores-within-hard-caps"]["passed"] is True
    assert checks["appendix:feature-scores-r-plus-h"]["passed"] is True


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
            "runtime_waits": [{"log_path": "/tmp/symphony/performer.log"}],
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
            "human_waits": [],
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


def test_real_symphony_e2e_human_answered_push_accepts_completed_child_required_guard() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._human_answered_push_satisfies_resume_probe(200, {"status": "accepted"})
    assert tool._human_answered_push_satisfies_resume_probe(
        200,
        {"status": "ignored", "reason": "completed_child_required"},
    )
    assert not tool._human_answered_push_satisfies_resume_probe(200, {"status": "ignored", "reason": "human_wait_not_found"})


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
                "pipeline_nodes": [
                    {
                        "node_id": "node-1",
                        "state": "reworking",
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
                    "pipeline_nodes": [
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

def test_real_symphony_e2e_surfaces_immediate_pipeline_failures() -> None:
    tool = load_tool("real_symphony_e2e")

    failure = tool.immediate_pipeline_failure(
        {
            "pipeline_attempts": [
                {
                    "attempt_id": "plan-1",
                    "mode": "plan",
                    "state": "failed",
                    "error": "managed_codex_home_required",
                }
            ],
            "pipeline_nodes": [{"node_id": "issue-1", "state": "awaiting_human"}],
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


def test_real_symphony_e2e_expected_failure_mode_keeps_waiting_for_failure_audit() -> None:
    tool = load_tool("real_symphony_e2e")

    assert (
        tool.immediate_pipeline_failure(
            {"pipeline_attempts": [{"attempt_id": "plan-1", "state": "failed"}]},
            expected_failure="overload",
        )
        is None
    )


def test_real_symphony_e2e_permission_probe_keeps_waiting_on_runtime_wait() -> None:
    tool = load_tool("real_symphony_e2e")

    assert (
        tool.immediate_pipeline_failure(
            {
                "pipeline_human_actions": [
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


def test_real_symphony_e2e_summary_includes_failure_details() -> None:
    tool = load_tool("real_symphony_e2e")

    summary = tool.e2e_report_summary(
        {
            "failures": [
                {
                    "name": "pipeline-runtime-error:visible",
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
            "name": "pipeline-runtime-error:visible",
            "failure": {
                "kind": "attempt_failed",
                "attempts": [{"attempt_id": "plan-1", "error": "managed_codex_home_required"}],
            },
        }
    ]

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
    assert "state" not in result
    assert "ops" not in result
