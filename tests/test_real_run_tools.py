from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def load_tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


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
                    "phase": "done",
                    "status_label": "performer:phase/done",
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
                    "phase": "error",
                    "status_label": "performer:phase/blocked",
                }
            ],
        },
        "performer_dispatch_summary dispatched=0 skipped=1 running=0 claimed=1",
    )

    assert result["pass"] is True
    assert result["counts"]["blocked"] == 1
    assert result["blocked"][0]["identifier"] == "HELL-1"


def test_linear_tree_audit_requires_gate_and_evidence_parent_links() -> None:
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
                        "id": "gate-1",
                        "identifier": "HELL-2",
                        "title": "[Gate] HELL-1: Behavior",
                        "parent": {"id": "other", "identifier": "HELL-X"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": [{"name": "performer:type/gate"}]},
                        "children": {
                            "nodes": [
                                {
                                    "id": "evidence-1",
                                    "identifier": "HELL-3",
                                    "title": "[Evidence] HELL-1",
                                    "parent": {"id": "business-1", "identifier": "HELL-1"},
                                    "state": {"name": "Todo", "type": "unstarted"},
                                    "labels": {"nodes": [{"name": "performer:type/evidence"}]},
                                }
                            ]
                        },
                    },
                    {
                        "id": "acceptance-1",
                        "identifier": "HELL-4",
                        "title": "[Acceptance] HELL-1",
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": [{"id": "rel-1", "type": "blocks"}]},
        }
    )

    assert result["pass"] is False
    assert "gate_parent_mismatch:HELL-2" in result["failures"]
    assert "evidence_parent_mismatch:HELL-3" in result["failures"]
    assert "acceptance_sibling_present" in result["failures"]
    assert "blocks_relation_present" in result["failures"]


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


@pytest.mark.asyncio
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
            "runs": [
                {"issue_id": "A", "phase": "implementing", "is_dispatchable": True},
                {"issue_id": "B", "phase": "implementing", "is_dispatchable": True},
                {"issue_id": "C", "phase": "queued", "is_dispatchable": False},
            ],
        },
        {
            "tick": 2,
            "background": {"blocked_waiting": 1},
            "started_this_tick": [],
            "runs": [
                {"issue_id": "A", "phase": "done", "is_dispatchable": True},
                {"issue_id": "B", "phase": "done", "is_dispatchable": True},
                {"issue_id": "C", "phase": "queued", "is_dispatchable": True},
            ],
        },
        {
            "tick": 3,
            "background": {"blocked_waiting": 0},
            "started_this_tick": [{"issue_id": "C"}],
            "runs": [
                {"issue_id": "A", "phase": "done", "is_dispatchable": True},
                {"issue_id": "B", "phase": "done", "is_dispatchable": True},
                {"issue_id": "C", "phase": "implementing", "is_dispatchable": True},
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
                "runs": [
                    {"issue_id": "A", "phase": "implementing", "is_dispatchable": True},
                    {"issue_id": "B", "phase": "implementing", "is_dispatchable": True},
                    {"issue_id": "C", "phase": "implementing", "is_dispatchable": True},
                ],
            },
            {
                "tick": 2,
                "background": {"blocked_waiting": 0},
                "started_this_tick": [],
                "runs": [
                    {"issue_id": "A", "phase": "done", "is_dispatchable": True},
                    {"issue_id": "B", "phase": "done", "is_dispatchable": True},
                    {"issue_id": "C", "phase": "done", "is_dispatchable": True},
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


@pytest.mark.asyncio
async def test_real_concurrent_schedule_probe_noop_direct_ingress_returns_zero() -> None:
    tool = load_tool("real_concurrent_schedule_probe")

    assert await tool.NoopDirectIngress().poll() == 0


def test_real_run_observer_diagnoses_review_phase_state_mismatch() -> None:
    observer = load_tool("real_run_observer")

    findings = observer.diagnose(
        {
            "business_issue": {
                "identifier": "HELL-1",
                "state": "In Progress",
                "labels": ["performer:phase/review"],
            },
            "failures": [],
        },
        {"failures": []},
    )

    assert findings == ["linear_state_phase_mismatch:review_phase_without_in_review_state"]


def test_real_symphony_e2e_patches_smoke_gate_mode() -> None:
    tool = load_tool("real_symphony_e2e")
    workflow = "acceptance:\n  enabled: true\n  mode: block_done\n\ncodex:\n  command: codex app-server\n"

    patched = tool.patch_e2e_gate_mode(workflow, gate_mode="smoke")

    assert "acceptance:\n  enabled: true\n  mode: block_done\n  gate_planner_mode: smoke\n\ncodex:" in patched


def test_real_symphony_e2e_replaces_existing_gate_mode() -> None:
    tool = load_tool("real_symphony_e2e")
    workflow = "acceptance:\n  enabled: true\n  gate_planner_mode: strict\ncodex:\n  command: codex app-server\n"

    patched = tool.patch_e2e_gate_mode(workflow, gate_mode="smoke")

    assert "gate_planner_mode: smoke" in patched
    assert "gate_planner_mode: strict" not in patched


def test_real_symphony_e2e_patch_workflow_injects_codex_init_options(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    workflow_path = tmp_path / "WORKFLOW.md"
    workflow_path.write_text(
        "agent:\n  max_concurrent_agents: 10\n  max_turns: 20\n\n"
        "persistence:\n  path: state/performer.json\n\n"
        "codex:\n  backend: sdk\n  sdk_codex_bin: /old/codex\n",
        encoding="utf-8",
    )

    patched = tool.patch_workflow(
        workflow_path,
        acceptance_gates=False,
        sdk_codex_bin="/tmp/codex-wrapper",
        init_max_attempts=3,
        init_backoff_ms=100,
        init_backoff_max_ms=150,
        read_timeout_ms=2500,
        hard_turn_timeout_ms=30000,
        overload_max_attempts=4,
        overload_initial_delay_ms=125,
        overload_max_delay_ms=1000,
        config_overrides=["model_provider=openai"],
    )

    assert "  sdk_codex_bin: /tmp/codex-wrapper\n" in patched
    assert "  init_max_attempts: 3\n" in patched
    assert "  init_backoff_ms: 100\n" in patched
    assert "  init_backoff_max_ms: 150\n" in patched
    assert "  read_timeout_ms: 2500\n" in patched
    assert "  hard_turn_timeout_ms: 30000\n" in patched
    assert "  overload_max_attempts: 4\n" in patched
    assert "  overload_initial_delay_ms: 125\n" in patched
    assert "  overload_max_delay_ms: 1000\n" in patched
    assert "  config_overrides:\n    - model_provider=openai\n" in patched
    assert "/old/codex" not in patched


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
        acceptance_gates=False,
        simulate_agent_webhook=True,
    )

    assert payload["linear_filters"] == {"active_states": ["Todo", "In Progress"]}


def test_real_symphony_e2e_real_instance_payload_requires_delegate() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_instance_payload(
        run_id="run-1",
        fixture=Path("/tmp/fixture"),
        project_slug="AI",
        agent_app_user_id="agent-1",
        acceptance_gates=True,
        simulate_agent_webhook=False,
    )

    assert payload["linear_filters"] == {
        "linear_agent_app_user_id": "agent-1",
        "active_states": ["Todo", "In Progress"],
    }


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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
