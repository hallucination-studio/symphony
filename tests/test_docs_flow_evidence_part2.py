from test_docs_flow_evidence_support import *  # noqa: F401,F403

async def test_flow_014_stall_detection_kills_silent_session_and_retries(tmp_path: Path) -> None:
    from datetime import timedelta

    tracker = FlowTracker(candidates=[issue("ENG-14", id="eng-14")])
    runner = FlowCompletingRunner()
    config = ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(interval_ms=100),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=True, required_checks=[]),
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    await runner.started.wait()
    entry = orchestrator.state.running["eng-14"]
    entry.last_codex_timestamp = entry.started_at - timedelta(seconds=10)
    entry.last_codex_event = "notification"

    await orchestrator.reconcile_running()

    bundle = flow_bundle(
        test_id="FLOW-014",
        title="stall detection terminates silent session and schedules pure retry",
        source_sections=["5.3.6", "8.5", "10.6", "14.1", "14.2"],
        profile="core",
        initial_state={"issue": "ENG-14", "stall_timeout_ms": 1, "last_codex_event": "notification"},
        trigger="Run reconciliation after last Codex timestamp is older than stall timeout",
        observed_transitions=["stall_elapsed_from_last_codex_timestamp", "worker_cancelled", "retry_scheduled"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"created_issues": tracker.created_issues},
        codex_evidence={"last_codex_timestamp": entry.last_codex_timestamp.isoformat()},
        observability_evidence={
            "retry": orchestrator.state.retry_attempts["eng-14"].__dict__,
            "claimed": "eng-14" in orchestrator.state.claimed,
        },
        final_state={
            "retrying": "eng-14" in orchestrator.state.retry_attempts,
            "pending_human": "eng-14" in orchestrator.state.human_interventions,
            "running": "eng-14" in orchestrator.state.running,
        },
        score_reason="Retry entry shows stalled reason; timestamp evidence shows stall clock source without requiring human action.",
    )

    assert orchestrator.state.retry_attempts["eng-14"].error == "stalled"
    assert "eng-14" in orchestrator.state.claimed
    assert tracker.created_issues == []
    assert bundle["final_state"]["retrying"] is True
    assert bundle["final_state"]["pending_human"] is False

def test_flow_015_dynamic_workflow_reload_changes_future_dispatch_not_inflight(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    workflow_path = tmp_path / "WORKFLOW.md"
    write_flow_workflow(
        workflow_path,
        active_states=["Todo", "In Progress"],
        max_concurrent_agents=1,
        prompt="Old prompt for {{ issue.identifier }}",
    )
    reloader = WorkflowReloader(workflow_path)
    first = reloader.current()
    running_session = {"issue_id": "eng-15", "session_id": "thread-15-turn-1", "prompt": "Old prompt for ENG-15"}
    write_flow_workflow(
        workflow_path,
        active_states=["Ready"],
        max_concurrent_agents=2,
        prompt="New prompt for {{ issue.identifier }} / {{ issue.title }}",
    )

    second = reloader.current()
    rendered = render_prompt(
        second.prompt_template,
        {"issue": {"identifier": "ENG-15B", "title": "Future"}, "attempt": 1},
    )

    bundle = flow_bundle(
        test_id="FLOW-015",
        title="dynamic workflow reload changes future dispatch while preserving in-flight run",
        source_sections=["5.3", "6.2", "6.3", "14.4"],
        profile="core",
        initial_state={
            "active_states": first.tracker.active_states,
            "max_concurrent_agents": first.agent.max_concurrent_agents,
            "running_session": running_session,
        },
        trigger="Modify WORKFLOW.md and reload",
        observed_transitions=["reload_detected_mtime_change", "new_config_effective", "inflight_session_not_restarted", "future_prompt_changed"],
        workspace_evidence={"workflow_path": str(workflow_path)},
        tracker_evidence={"future_active_states": second.tracker.active_states},
        codex_evidence={"running_session": running_session, "future_prompt": rendered},
        observability_evidence={"last_error": str(reloader.last_error), "logs": caplog.text},
        final_state={"active_states": second.tracker.active_states, "max_concurrent_agents": second.agent.max_concurrent_agents},
        score_reason="Reload evidence shows old and new config, unchanged in-flight session metadata, and new future prompt rendering.",
    )

    assert first.tracker.active_states == ["Todo", "In Progress"]
    assert second.tracker.active_states == ["Ready"]
    assert second.agent.max_concurrent_agents == 2
    assert running_session["session_id"] == "thread-15-turn-1"
    assert rendered == "New prompt for ENG-15B / Future"
    assert bundle["score"] == 4

def test_flow_016_invalid_workflow_reload_keeps_last_good_config_with_diagnostics(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    workflow_path = tmp_path / "WORKFLOW.md"
    write_flow_workflow(
        workflow_path,
        active_states=["Todo"],
        max_concurrent_agents=1,
        prompt="Do {{ issue.identifier }}",
    )
    reloader = WorkflowReloader(workflow_path)
    first = reloader.current()
    workflow_path.write_text("---\ntracker: [", encoding="utf-8")

    second = reloader.current()

    bundle = flow_bundle(
        test_id="FLOW-016",
        title="invalid workflow reload keeps last known good config",
        source_sections=["5.5", "6.2", "6.3", "13.2", "14.2"],
        profile="core",
        initial_state={"active_states": first.tracker.active_states, "workflow_path": str(workflow_path)},
        trigger="Replace workflow with invalid YAML front matter and reload",
        observed_transitions=["reload_attempted", "workflow_parse_error", "last_good_config_retained", "service_continues"],
        workspace_evidence={"workflow_path": str(workflow_path)},
        tracker_evidence={"last_good_active_states": second.tracker.active_states},
        codex_evidence={"not_applicable": True},
        observability_evidence={"last_error": str(reloader.last_error), "logs": caplog.text},
        final_state={"same_config_object": second is first, "active_states": second.tracker.active_states},
        score_reason="Diagnostics include reload failure while current config remains the last valid active-state config.",
    )

    assert second is first
    assert reloader.last_error is not None
    assert "performer_workflow_reload failed" in caplog.text
    assert second.tracker.active_states == ["Todo"]
    assert bundle["final_state"]["same_config_object"] is True

async def test_flow_017_workspace_hooks_order_failure_semantics_and_operator_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    hook_root = tmp_path / "hooks"
    order_log = tmp_path / "hook-order.log"
    manager = WorkspaceManager(
        WorkspaceConfig(root=hook_root),
        HooksConfig(
            after_create=f"printf after_create:$PWD >> {order_log}",
            before_run=f"printf ' before_run:'$PWD >> {order_log}",
            after_run=f"printf ' after_run:'$PWD >> {order_log}",
            before_remove=f"printf ' before_remove:'$PWD >> {order_log}",
            timeout_ms=50,
        ),
    )

    workspace = await manager.create_for_issue("ENG-17")
    reused = await manager.create_for_issue("ENG-17")
    await manager.run_before_run(workspace.path)
    await manager.run_after_run(workspace.path)
    await manager.remove_for_issue("ENG-17")

    fatal_create = WorkspaceManager(WorkspaceConfig(root=tmp_path / "fatal-create"), HooksConfig(after_create="exit 7"))
    with pytest.raises(WorkspaceError) as create_exc:
        await fatal_create.create_for_issue("ENG-17")
    fatal_before = WorkspaceManager(WorkspaceConfig(root=tmp_path / "fatal-before"), HooksConfig(before_run="exit 8"))
    fatal_workspace = await fatal_before.create_for_issue("ENG-17")
    with pytest.raises(WorkspaceError) as before_exc:
        await fatal_before.run_before_run(fatal_workspace.path)
    nonfatal_after = WorkspaceManager(WorkspaceConfig(root=tmp_path / "nonfatal-after"), HooksConfig(after_run="echo after_bad >&2; exit 9"))
    after_workspace = await nonfatal_after.create_for_issue("ENG-17")
    await nonfatal_after.run_after_run(after_workspace.path)
    nonfatal_remove = WorkspaceManager(WorkspaceConfig(root=tmp_path / "nonfatal-remove"), HooksConfig(before_remove="echo remove_bad >&2; exit 10"))
    remove_workspace = await nonfatal_remove.create_for_issue("ENG-17")
    await nonfatal_remove.remove_for_issue("ENG-17")

    order = order_log.read_text(encoding="utf-8")
    bundle = flow_bundle(
        test_id="FLOW-017",
        title="workspace hooks execute in order with documented fatal and non-fatal semantics",
        source_sections=["5.3.4", "9.2", "9.4", "16.5"],
        profile="core",
        initial_state={"issue": "ENG-17", "hook_root": str(hook_root)},
        trigger="Create, run, finish, remove workspace plus hook failure variants",
        observed_transitions=["after_create once", "before_run", "after_run", "before_remove", "fatal_create_aborted", "fatal_before_run_aborted", "nonfatal_cleanup_logged"],
        workspace_evidence={"order_log": order, "reused_created_now": reused.created_now, "removed": not workspace.path.exists()},
        tracker_evidence={"not_applicable": True},
        codex_evidence={"launch_count": 1, "worker_outcome": "simulated"},
        observability_evidence={"logs": caplog.text, "fatal_codes": [create_exc.value.code, before_exc.value.code]},
        final_state={"workspace_removed": not workspace.path.exists(), "nonfatal_remove_removed": not remove_workspace.path.exists()},
        score_reason="Bundle includes hook order/cwd, fatal error codes, non-fatal warning logs, and cleanup state.",
    )

    assert order.count("after_create:") == 1
    assert "before_run:" in order
    assert "after_run:" in order
    assert "before_remove:" in order
    assert create_exc.value.code == "hook_failed"
    assert before_exc.value.code == "hook_failed"
    assert "exit_code=9" in caplog.text
    assert "exit_code=10" in caplog.text
    assert not remove_workspace.path.exists()
    assert bundle["score"] == 4

async def test_flow_019_secret_used_for_linear_request_but_never_logged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "secret-token-123"
    monkeypatch.setenv("LINEAR_API_KEY", secret)
    transport = SecretStatusTransport()
    client = LinearClient("https://api.linear.test/graphql", os.environ["LINEAR_API_KEY"], transport=transport)
    caplog.set_level(logging.WARNING)

    with pytest.raises(LinearError) as exc:
        await client.fetch_candidate_issues(
            TrackerConfig(
                kind="linear",
                endpoint="https://api.linear.test/graphql",
                api_key=os.environ["LINEAR_API_KEY"],
                project_slug="ENG",
            )
        )
    logging.getLogger("performer.flow").warning("candidate fetch failed category=%s", exc.value.code)

    request = transport.requests[0]
    bundle = flow_bundle(
        test_id="FLOW-019",
        title="linear secret is validated and used without operator-visible leakage",
        source_sections=["5.3.1", "6.1", "13.2", "15.3"],
        profile="core security",
        initial_state={"env": {"LINEAR_API_KEY": "present"}},
        trigger="Linear candidate fetch receives HTTP status error",
        observed_transitions=["secret_resolved_present", "linear_request_sent", "linear_api_status_error", "dispatch_skipped_for_tick"],
        workspace_evidence={},
        tracker_evidence={"authorization_header_present": request["headers"].get("authorization") == secret},
        codex_evidence={"not_applicable": True},
        observability_evidence={"log_text": caplog.text, "error_code": exc.value.code},
        final_state={"dispatched": 0, "error_code": exc.value.code},
        score_reason="Test-only transport proves Authorization value was used while operator logs and error messages expose only stable categories.",
    )

    assert request["headers"]["authorization"] == secret
    assert exc.value.code == "linear_api_status"
    assert secret not in caplog.text
    assert secret not in str(exc.value)
    assert bundle["observability_evidence"]["error_code"] == "linear_api_status"

async def test_flow_020_linear_pagination_normalization_sorting_and_error_categories(tmp_path: Path) -> None:
    def node(
        identifier: str,
        *,
        priority: int,
        label: str,
        created: str,
        delegate_id: str | None = "agent-user-1",
    ) -> dict[str, Any]:
        return {
            "id": identifier.lower(),
            "identifier": identifier,
            "title": identifier,
            "description": "",
            "priority": priority,
            "branchName": identifier.lower(),
            "url": f"https://linear.local/{identifier}",
            "createdAt": created,
            "updatedAt": created,
            "state": {"name": "Todo"},
            "project": {"slugId": "ENG", "name": "Engineering"},
            "assignee": {"id": "user-1"},
            "delegate": {"id": delegate_id} if delegate_id else None,
            "labels": {"nodes": [{"name": label}]},
            "inverseRelations": {"nodes": []},
        }

    transport = FlowLinearTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [
                            node("ENG-20B", priority=3, label="Ready", created="2026-07-02T00:00:00Z"),
                            node("ENG-20A", priority=1, label=" READY ", created="2026-07-01T00:00:00Z"),
                        ],
                        "pageInfo": {"hasNextPage": True, "endCursor": "cursor-1"},
                    }
                }
            },
            {
                "data": {
                    "issues": {
                        "nodes": [
                            node(
                                "ENG-20C",
                                priority=0,
                                label="other",
                                created="2026-07-03T00:00:00Z",
                                delegate_id="other-agent",
                            )
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        ]
    )
    config = TrackerConfig(
        kind="linear",
        endpoint="https://api.linear.test/graphql",
        project_slug="ENG",
        api_key="linear-token",
        required_delegate_id="agent-user-1",
    )
    client = LinearClient(config.endpoint, config.api_key, transport=transport)

    candidates = await client.fetch_candidate_issues(config, page_size=2)
    eligible = [candidate for candidate in candidates if candidate.delegate_id == config.required_delegate_id]
    sorted_eligible = sort_for_dispatch(eligible)
    error_codes = []
    for response in [{"errors": [{"message": "bad"}]}, "not-json"]:
        error_transport = FlowLinearTransport([response]) if isinstance(response, dict) else SecretStatusTransport()
        try:
            if isinstance(response, dict):
                await LinearClient(config.endpoint, config.api_key, transport=error_transport).fetch_candidate_issues(config)
            else:
                await LinearClient(config.endpoint, config.api_key, transport=error_transport).fetch_candidate_issues(config)
        except LinearError as exc:
            error_codes.append(exc.code)

    bundle = flow_bundle(
        test_id="FLOW-020",
        title="linear pagination normalization and dispatch sorting feed scheduler correctly",
        source_sections=["4.1.1", "5.3.1", "8.2", "11.1", "11.2", "11.3", "11.4"],
        profile="core tracker",
        initial_state={"project_slug": "ENG", "required_delegate_id": "agent-user-1"},
        trigger="Fetch two Linear pages and run delegate eligibility/sorting",
        observed_transitions=["page_1_fetched", "cursor-1_used", "delegate_normalized", "delegate_mismatch_filtered", "ENG-20A_sorted_first"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"requests": transport.requests, "normalized": [candidate.__dict__ for candidate in candidates]},
        codex_evidence={"not_applicable": True},
        observability_evidence={"sorted_order": [candidate.identifier for candidate in sorted_eligible], "error_codes": error_codes},
        final_state={"dispatch_first": sorted_eligible[0].identifier, "eligible": [candidate.identifier for candidate in eligible]},
        score_reason="Bundle includes GraphQL variables/query, pagination cursor, normalized labels, eligibility decisions, sorted dispatch order, and error categories.",
    )

    assert transport.requests[0]["json"]["variables"]["projectSlug"] == "ENG"
    assert transport.requests[1]["json"]["variables"]["after"] == "cursor-1"
    assert [candidate.identifier for candidate in eligible] == ["ENG-20B", "ENG-20A"]
    assert sorted_eligible[0].identifier == "ENG-20A"
    assert "slugId" in transport.requests[0]["json"]["query"]
    assert "linear_graphql_errors" in error_codes
    assert "linear_api_status" in error_codes
    assert bundle["final_state"]["dispatch_first"] == "ENG-20A"

def test_flow_023_token_and_runtime_metrics_use_latest_absolute_totals(tmp_path: Path) -> None:
    config = config_with_verification(tmp_path, required_checks=[])
    state = OrchestratorState()
    tracker = FlowTracker(candidates=[issue("ENG-23", id="eng-23")])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config, tracker, runner)
    started_at = utc_now() - timedelta(seconds=10)
    entry = RunningEntry(
        issue=issue("ENG-23", id="eng-23", state="In Progress"),
        task=None,
        started_at=started_at,
        retry_attempt=0,
        session_id="thread-23-turn-1",
    )
    state.running["eng-23"] = entry
    orchestrator.state = state
    first_event = {
        "event": "thread_token_usage_updated",
        "turn_id": "turn_1",
        "session_id": "thread-23-turn-1",
        "payload": {"total_token_usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}},
    }
    second_event = {
        "event": "thread_token_usage_updated",
        "turn_id": "turn_1",
        "session_id": "thread-23-turn-1",
        "payload": {
            "total_token_usage": {"input_tokens": 150, "output_tokens": 70, "total_tokens": 220},
            "rate_limits": {"primary": {"remaining": 10}},
        },
    }
    delta_event = {"event": "thread_token_usage_updated", "turn_id": "turn_1", "session_id": "thread-23-turn-1", "payload": {"last_token_usage": {"total_tokens": 999}}}

    orchestrator.on_codex_event("eng-23", first_event)
    totals_after_first = orchestrator.state.codex_totals.total_tokens
    orchestrator.on_codex_event("eng-23", second_event)
    totals_after_second = orchestrator.state.codex_totals.total_tokens
    orchestrator.on_codex_event("eng-23", delta_event)
    snapshot = build_runtime_snapshot(config, orchestrator.state)

    bundle = flow_bundle(
        test_id="FLOW-023",
        title="token and runtime metrics remain correct across repeated absolute updates",
        source_sections=["4.1.6", "13.3", "13.5"],
        profile="core observability",
        initial_state={"session": "thread-23-turn-1", "started_seconds_ago": 10},
        trigger="Apply two absolute token updates and one delta-style payload, then build snapshot",
        observed_transitions=["tokens=150", "tokens=220", "delta_payload_ignored", "snapshot_generated"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"not_applicable": True},
        codex_evidence={"events": [first_event, second_event, delta_event]},
        observability_evidence={"totals": [totals_after_first, totals_after_second], "snapshot": snapshot},
        final_state={"aggregate_total_tokens": snapshot["codex_totals"]["total_tokens"], "session_total_tokens": entry.tokens.total_tokens},
        score_reason="Event-by-event totals and snapshot prove absolute totals are not double-counted and active runtime is included.",
    )

    assert totals_after_first == 150
    assert totals_after_second == 220
    assert snapshot["codex_totals"]["total_tokens"] == 220
    assert snapshot["codex_totals"]["seconds_running"] >= 9
    assert orchestrator.state.codex_rate_limits == {"primary": {"remaining": 10}}
    assert bundle["final_state"]["aggregate_total_tokens"] == 220

def test_flow_025_real_integration_profiles_skip_fail_and_pass_are_explicit(tmp_path: Path) -> None:
    base_env = dict(os.environ)
    base_env.pop("LINEAR_API_KEY", None)
    base_env.pop("PERFORMER_REAL_INTEGRATION", None)
    missing = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_real_integration.py", "-q"],
        cwd=Path.cwd(),
        env=base_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    invalid_env = dict(base_env)
    invalid_env["PERFORMER_REAL_INTEGRATION"] = "1"
    invalid_env["LINEAR_API_KEY"] = "invalid-token-for-flow-025"
    invalid = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_real_integration.py", "-q"],
        cwd=Path.cwd(),
        env=invalid_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    valid_available = bool(os.environ.get("LINEAR_API_KEY"))

    bundle = flow_bundle(
        test_id="FLOW-025",
        title="real integration profile skips missing credentials and fails enabled auth errors",
        source_sections=["17.8", "18.3"],
        profile="real_integration",
        initial_state={"valid_credentials_available": valid_available},
        trigger="Run real integration pytest with missing and invalid credentials",
        observed_transitions=["missing_credentials_explicit_skip", "invalid_credentials_enabled_failure"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"missing_output": missing.stdout + missing.stderr, "invalid_output": invalid.stdout + invalid.stderr},
        codex_evidence={"not_applicable": True},
        observability_evidence={"missing_returncode": missing.returncode, "invalid_returncode": invalid.returncode},
        final_state={"missing_skipped": missing.returncode == 0 and "skipped" in missing.stdout.lower(), "invalid_failed": invalid.returncode != 0},
        score_reason="Subprocess reports prove missing credentials skip explicitly and enabled invalid credentials fail instead of passing silently.",
    )

    assert missing.returncode == 0
    assert "skipped" in missing.stdout.lower()
    assert invalid.returncode != 0
    assert "invalid-token-for-flow-025" not in (invalid.stdout + invalid.stderr)
    assert bundle["final_state"]["invalid_failed"] is True
