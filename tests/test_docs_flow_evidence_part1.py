from test_docs_flow_evidence_support import *  # noqa: F401,F403

async def test_flow_001_dispatch_run_and_human_review_handoff_has_reviewer_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(
        candidates=[
            issue("ENG-1", id="eng-1", title="Build handoff evidence", labels=["performer"], project_slug="MT")
        ]
    )
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "test-workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-1")
    runner = FlowHandoffRunner(workspace.path)
    config = ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="test-token",
            active_states=["Todo", "In Progress"],
            terminal_states=["Done", "Canceled"],
        ),
        polling=PollingConfig(interval_ms=100),
        workspace=WorkspaceConfig(root=tmp_path / "test-workspaces"),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=1, max_retry_backoff_ms=300_000),
        codex=CodexConfig(
            command="fake-codex-app-server",
            approval_policy="never",
            thread_sandbox="workspace-write",
            turn_sandbox_policy="workspace-write",
            turn_timeout_ms=5000,
            read_timeout_ms=500,
            stall_timeout_ms=1000,
        ),
        prompt_template="Work on {{ issue.identifier }}: {{ issue.title }}.",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=False),
    )
    orchestrator = Orchestrator(config, tracker, runner, workspace_manager=workspace_manager)

    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [issue("ENG-1", id="eng-1", state="Human Review", labels=["performer"], project_slug="MT")]
    await orchestrator.reconcile_running()

    comment = tracker.comments[-1][1]
    recent_events = comment + "\n" + json.dumps(runner.events, sort_keys=True)
    bundle = flow_bundle(
        test_id="FLOW-001",
        title="active issue dispatches, emits evidence, and reaches Human Review handoff",
        source_sections=["1", "5", "7", "8", "9", "10", "11", "12", "13", "14"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-1", "tracker_state": "Todo", "labels": ["performer"]},
        trigger="Run one dispatch tick, emit Codex validation evidence, then refresh tracker state to Human Review",
        observed_transitions=[
            "Unclaimed -> Claimed",
            "Claimed -> Running",
            "Codex session th_1-turn_1",
            "state_refresh -> Human Review",
            "Running -> handoff stopped",
        ],
        workspace_evidence={
            "workspace_path": str(workspace.path),
            "validation_artifact": (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").read_text(encoding="utf-8"),
        },
        tracker_evidence={
            "candidate_fetch_calls": tracker.fetch_candidate_calls,
            "state_refresh_calls": tracker.fetch_state_calls,
            "comment": comment,
        },
        codex_evidence={"events": runner.events},
        observability_evidence={
            "recent_events": recent_events,
            "running": "eng-1" in orchestrator.state.running,
            "completed": "eng-1" in orchestrator.state.completed,
        },
        final_state={
            "workspace_exists": workspace.path.exists(),
            "running": "eng-1" in orchestrator.state.running,
            "completed": "eng-1" in orchestrator.state.completed,
        },
        score_reason="Reviewer-facing handoff comment summarizes preserved workspace, validation artifact, session, and why Human Review is not terminal Done.",
    )

    assert tracker.fetch_candidate_calls == 1
    assert runner.events[0]["cwd"] == str(workspace.path)
    assert runner.events[1]["session_id"] == "th_1-turn_1"
    assert "pytest tests/test_runner.py::test_runner_uses_workspace_cwd -q" in recent_events
    assert "Tracker state: Human Review" in comment
    assert workspace.path.exists()
    assert "eng-1" not in orchestrator.state.completed
    assert "eng-1" not in orchestrator.state.running
    assert bundle["score"] == 4

async def test_flow_002_rejects_model_success_without_workspace_or_validation_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-2", id="eng-2", project_slug="MT")])
    workspace = tmp_path / "ENG-2"
    init_repo(workspace)
    runner = FlowCompletingRunner(final_message="Implemented and verified. Ready for review.")
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["workspace_changes", "test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-2"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    comment = tracker.comments[-1][1]
    retry = orchestrator.state.retry_attempts["eng-2"]
    bundle = flow_bundle(
        test_id="FLOW-002",
        title="agent success claim is rejected without evidence",
        source_sections=["1", "10.5", "11.5", "13", "14.2", "14.4", "15.5"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-2", "tracker_state": "Todo"},
        trigger="Codex emits confident final message with clean workspace and no test command evidence",
        observed_transitions=["Unclaimed -> Running", "turn_completed", "completion_verification -> NEEDS_RETRY"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"comment": comment, "lifecycle_labels": tracker.lifecycle_labels},
        codex_evidence={"final_message": runner.final_message},
        observability_evidence={"retry": retry.__dict__, "recent_events": retry.recent_events},
        final_state={"completed": "eng-2" in orchestrator.state.completed, "retrying": "eng-2" in orchestrator.state.retry_attempts},
        score_reason="Reviewer-facing comment names missing workspace_changes and test_command_evidence and retry status is visible.",
    )

    assert "Verification failed after agent claimed success." in comment
    assert "workspace_changes" in comment
    assert "test_command_evidence" in comment
    assert "No files changed" in comment
    assert "No test command evidence recorded" in comment
    assert "ENG-2" in bundle["title"] or bundle["test_id"] == "FLOW-002"

async def test_flow_003_changed_files_without_focused_validation_routes_retry_with_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "ENG-3"
    init_repo(workspace)
    target = workspace / "src" / "performer"
    target.mkdir(parents=True)
    (target / "runner.py").write_text("print('changed')\n", encoding="utf-8")
    snapshot = OpsSnapshot(
        events=[
            TraceEvent(
                event_id="evt-1",
                event_type="notification",
                timestamp="2026-07-01T00:00:00Z",
                issue_id="eng-3",
                payload={"command": "pytest tests/test_models.py -q", "exit_code": 0},
            )
        ]
    )
    verifier = CompletionVerifier(
        CompletionVerificationConfig(
            enabled=True,
            required_checks=["workspace_changes", "test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
            min_workspace_changes_chars=1,
        ),
        FlowTracker(),
    )

    verdict = await verifier.verify_completion(issue("ENG-3", id="eng-3"), workspace, snapshot)
    failed = {check.check_name: check for check in verdict.checks if not check.passed}
    bundle = flow_bundle(
        test_id="FLOW-003",
        title="changed files do not satisfy focused validation requirement",
        source_sections=["1", "12.3", "13", "14.2", "15.5", "17.8"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-3", "changed_file": "src/performer/runner.py"},
        trigger="Verifier sees workspace diff plus unrelated successful pytest command",
        observed_transitions=["turn_completed", "completion_verification -> NEEDS_RETRY"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"next_action": "retry"},
        codex_evidence={"observed_commands": snapshot.events[0].payload},
        observability_evidence={"verdict": verdict.to_dict()},
        final_state={"verdict": verdict.status},
        score_reason="Bundle includes changed file, observed unrelated command, expected focused command, and retry verdict.",
    )

    assert verdict.status == "NEEDS_RETRY"
    assert "test_command_evidence" in failed
    assert "tests/test_runner.py::test_runner_uses_workspace_cwd" in str(failed["test_command_evidence"].evidence)
    assert "pytest tests/test_models.py -q" in str(bundle["codex_evidence"])

async def test_flow_004_optional_linear_state_failure_routes_to_human_review_with_passed_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-4", id="eng-4", project_slug="MT")])
    tracker.refreshed = [
        issue(
            "ENG-4",
            id="eng-4",
            blocked_by=[BlockerRef(id="dep-1", identifier="ENG-0", state="In Progress")],
        )
    ]
    workspace = tmp_path / "ENG-4"
    init_repo(workspace)
    (workspace / "README.md").write_text("changed for review\n", encoding="utf-8")
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["workspace_changes"],
            optional_checks=["linear_state"],
            auto_retry_on_fail=True,
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-4"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    comment = tracker.comments[-1][1]
    bundle = flow_bundle(
        test_id="FLOW-004",
        title="optional evidence failure creates human review handoff",
        source_sections=["1", "10.5", "11.5", "13.4", "14.4"],
        profile="quality_overlay",
        initial_state={"issue": "ENG-4", "workspace_changed": True},
        trigger="Required workspace evidence passes while optional linear_state detects non-terminal blocker",
        observed_transitions=["turn_completed", "completion_verification -> NEEDS_HUMAN", "human_review_comment"],
        workspace_evidence={"git_status": subprocess.run(["git", "status", "--short"], cwd=workspace, check=True, capture_output=True, text=True).stdout},
        tracker_evidence={"comment": comment, "state_refresh_calls": tracker.fetch_state_calls},
        codex_evidence={"session": "thread-1-turn-1"},
        observability_evidence={"retrying": "eng-4" in orchestrator.state.retry_attempts, "completed": "eng-4" in orchestrator.state.completed},
        final_state={"claimed": "eng-4" in orchestrator.state.claimed, "retrying": "eng-4" in orchestrator.state.retry_attempts},
        score_reason="Human-review comment contains passed workspace check, failed linear_state check, blocker context, and required next action.",
    )

    assert "Verdict: NEEDS_HUMAN" in comment
    assert "[PASS] workspace_changes" in comment
    assert "[FAIL] linear_state" in comment
    assert "Active blockers remain" in comment
    assert "human review is required" in comment.lower()
    assert bundle["final_state"] == {"claimed": True, "retrying": False}

async def test_flow_005_retry_prompt_reuses_failed_evidence_from_previous_attempt(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-5", id="eng-5", project_slug="MT")])
    workspace = tmp_path / "ENG-5"
    init_repo(workspace)
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        config_with_verification(
            tmp_path,
            required_checks=["test_command_evidence"],
            expected_test_patterns=["tests/test_runner.py::test_runner_uses_workspace_cwd"],
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["eng-5"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    retry = orchestrator.state.retry_attempts["eng-5"]
    retry.due_at_ms = 0
    second_runner = FlowCompletingRunner()
    orchestrator.runner = second_runner
    await orchestrator.tick()
    await second_runner.started.wait()

    second_entry = orchestrator.state.running["eng-5"]
    bundle = flow_bundle(
        test_id="FLOW-005",
        title="retry carries failed verification evidence into next attempt",
        source_sections=["7.1", "8.4", "12.3", "16.6"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-5", "first_verdict": "NEEDS_RETRY"},
        trigger="Retry timer fires after missing focused validation evidence",
        observed_transitions=["completion_verification -> NEEDS_RETRY", "retry_scheduled", "candidate_refetched", "Running attempt 1"],
        workspace_evidence={"workspace_path": str(workspace)},
        tracker_evidence={"candidate_fetch_calls": tracker.fetch_candidate_calls},
        codex_evidence={"attempts": second_runner.started_attempts},
        observability_evidence={"retry_error": retry.error, "running_description": second_entry.issue.description},
        final_state={"running": "eng-5" in orchestrator.state.running, "attempt": second_entry.retry_attempt},
        score_reason="Retry entry, candidate re-fetch count, attempt number, and retry prompt context all explain why the second attempt differs.",
    )

    assert tracker.fetch_candidate_calls >= 2
    assert second_entry.retry_attempt == 1
    assert "Previous attempt failed verification:" in (second_entry.issue.description or "")
    assert "test_command_evidence" in (second_entry.issue.description or "")
    assert "No test command evidence recorded" in (second_entry.issue.description or "")
    assert bundle["final_state"]["attempt"] == 1

async def test_flow_006_non_terminal_blocker_is_not_dispatched_with_operator_reason(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    blocked = issue(
        "ENG-6",
        id="eng-6",
        blocked_by=[BlockerRef(id="eng-5", identifier="ENG-5", state="In Progress")],
    )
    tracker = FlowTracker(candidates=[blocked])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()

    bundle = flow_bundle(
        test_id="FLOW-006",
        title="non-terminal blocker prevents Todo dispatch",
        source_sections=["4.1.1", "8.2", "11.3"],
        profile="core",
        initial_state={"issue": blocked.identifier, "blocker": {"identifier": "ENG-5", "state": "In Progress"}},
        trigger="Run one dispatch tick with blocked Todo candidate",
        observed_transitions=["candidate_fetched", "candidate_evaluated", "remains_unclaimed", "no_worker_spawned"],
        workspace_evidence={"workspace_created": False},
        tracker_evidence={"candidate": blocked.__dict__, "fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_started": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "skip_reason": orchestrator.dispatch_skip_reason(blocked)},
        final_state={"claimed": list(orchestrator.state.claimed), "running": list(orchestrator.state.running)},
        score_reason="Operator logs and status evidence name the non-terminal blocker skip reason and no worker was spawned.",
    )

    assert runner.started_attempts == []
    assert "blocked_by_non_terminal_dependency" in caplog.text
    assert "eng-6" not in orchestrator.state.claimed
    assert bundle["observability_evidence"]["skip_reason"] == "blocked_by_non_terminal_dependency"

async def test_flow_007_terminal_blocker_allows_dispatch_with_blocker_evidence(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    candidate = issue(
        "ENG-7",
        id="eng-7",
        blocked_by=[BlockerRef(id="eng-5", identifier="ENG-5", state="Done")],
    )
    tracker = FlowTracker(candidates=[candidate])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()

    bundle = flow_bundle(
        test_id="FLOW-007",
        title="terminal blocker does not block Todo dispatch",
        source_sections=["8.2", "11.3"],
        profile="core",
        initial_state={"issue": candidate.identifier, "blocker": {"identifier": "ENG-5", "state": "Done"}},
        trigger="Run one dispatch tick with terminal blocker candidate",
        observed_transitions=["candidate_fetched", "Unclaimed -> Claimed", "Claimed -> Running"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"candidate": candidate.__dict__, "fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "skip_reason": orchestrator.dispatch_skip_reason(candidate)},
        final_state={"claimed": "eng-7" in orchestrator.state.claimed, "running": "eng-7" in orchestrator.state.running},
        score_reason="Dispatch log, blocker state, and running state prove terminal blockers are normalized as eligible.",
    )

    assert runner.started_attempts == [None]
    assert "outcome=dispatch issue_id=eng-7" in caplog.text
    assert bundle["observability_evidence"]["skip_reason"] == "already_running_or_claimed"

async def test_flow_008_concurrency_and_claiming_prevent_duplicate_work(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    first = issue("ENG-8A", id="eng-8a", priority=1)
    second = issue("ENG-8B", id="eng-8b", priority=2)
    tracker = FlowTracker(candidates=[second, first])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(
        ServiceConfig(
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
            codex=CodexConfig(stall_timeout_ms=300_000),
            prompt_template="Do {{ issue.identifier }}",
            workflow_path=tmp_path / "WORKFLOW.md",
            completion_verification=CompletionVerificationConfig(enabled=True, required_checks=[]),
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [first]
    await orchestrator.tick()

    bundle = flow_bundle(
        test_id="FLOW-008",
        title="claiming and slots prevent duplicate or excess workers",
        source_sections=["7.4", "8.2", "8.3", "16.4"],
        profile="core",
        initial_state={"candidates": ["ENG-8B", "ENG-8A"], "max_concurrent_agents": 1},
        trigger="Run two dispatch ticks while first issue is still running",
        observed_transitions=["ENG-8A dispatched first by priority", "ENG-8B skipped no_available_slots", "ENG-8A not duplicated"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"logs": caplog.text, "running": list(orchestrator.state.running), "claimed": list(orchestrator.state.claimed)},
        final_state={"running_count": len(orchestrator.state.running), "started_count": len(runner.started_attempts)},
        score_reason="Bundle shows sorted candidate dispatch, one running worker, claimed set, and slot exhaustion log for the waiting issue.",
    )

    assert list(orchestrator.state.running) == ["eng-8a"]
    assert len(runner.started_attempts) == 1
    assert "reason=no_available_slots" in caplog.text
    assert bundle["final_state"]["running_count"] == 1

async def test_flow_009_normal_exit_schedules_short_continuation(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-9", id="eng-9")])
    runner = FlowCompletingRunner()
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()
    runner.release.set()
    await orchestrator.wait_for_idle()

    continuation = orchestrator.state.continuations.get("eng-9")
    bundle = flow_bundle(
        test_id="FLOW-009",
        title="normal worker exit keeps active work continuing",
        source_sections=["7.1", "7.3", "8.4", "16.6"],
        profile="core",
        initial_state={"issue": "ENG-9", "max_turns": 1},
        trigger="Worker returns normally while issue remains active",
        observed_transitions=["Running removed", "runtime_totals_updated", "continuation_scheduled"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"issue_state": "Todo"},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={
            "continuation": continuation.__dict__ if continuation else None,
            "retrying": "eng-9" in orchestrator.state.retry_attempts,
            "claimed": "eng-9" in orchestrator.state.claimed,
        },
        final_state={
            "continuing": continuation is not None,
            "retrying": "eng-9" in orchestrator.state.retry_attempts,
            "completed": "eng-9" in orchestrator.state.completed,
        },
        score_reason="Status evidence shows clean worker exit schedules a continuation and keeps the issue claimed without using retry state.",
    )

    assert continuation is not None
    assert continuation.attempt == 1
    assert continuation.status_label == "performer:phase/implementation"
    assert "eng-9" not in orchestrator.state.retry_attempts
    assert "eng-9" in orchestrator.state.claimed
    assert bundle["final_state"]["continuing"] is True

async def test_flow_010_abnormal_exit_uses_backoff_and_preserves_claim(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)

    class FailingRunner:
        async def run_issue(self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None) -> None:
            raise RuntimeError("boom")

    tracker = FlowTracker(candidates=[issue("ENG-10", id="eng-10")])
    orchestrator = Orchestrator(config_with_verification(tmp_path, required_checks=[]), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    intervention = orchestrator.state.human_interventions["eng-10"]
    child = tracker.created_issues[-1]
    bundle = flow_bundle(
        test_id="FLOW-010",
        title="abnormal worker exit creates human-action child and preserves claim",
        source_sections=["7.3", "8.4", "14.2"],
        profile="core",
        initial_state={"issue": "ENG-10", "attempt": 0},
        trigger="Worker raises RuntimeError during first attempt",
        observed_transitions=["Running removed", "human action child created", "claim preserved"],
        workspace_evidence={"not_required": True},
        tracker_evidence={"child": child},
        codex_evidence={"worker_error": "boom"},
        observability_evidence={"human_intervention": intervention.__dict__, "logs": caplog.text},
        final_state={
            "claimed": "eng-10" in orchestrator.state.claimed,
            "pending_human": "eng-10" in orchestrator.state.human_interventions,
        },
        score_reason="Human-action child exposes worker failure and claim preservation without parent comment control.",
    )

    assert intervention.attempt == 1
    assert intervention.kind == "runtime_error"
    assert intervention.error == "worker exited: boom"
    assert "eng-10" in orchestrator.state.claimed
    assert child["title"] == "[Human Action] ENG-10: Runtime error needs review"
    assert "worker exited: boom" in child["description"]
    assert bundle["final_state"]["claimed"] is True

async def test_flow_011_due_retry_refetches_and_releases_missing_candidate(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    tracker = FlowTracker(candidates=[])
    runner = FlowCompletingRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-11")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    orchestrator._schedule_retry(issue("ENG-11", id="eng-11"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    bundle = flow_bundle(
        test_id="FLOW-011",
        title="retry timer refetches candidates and releases missing issue",
        source_sections=["8.4"],
        profile="core",
        initial_state={"retry": "ENG-11", "workspace_exists": workspace.path.exists()},
        trigger="Due retry fires but tracker no longer returns the issue",
        observed_transitions=["retry_popped", "candidate_refetched", "issue_missing", "claim_released", "workspace_preserved"],
        workspace_evidence={"workspace_exists_after": workspace.path.exists()},
        tracker_evidence={"fetch_candidate_calls": tracker.fetch_candidate_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"claimed": list(orchestrator.state.claimed), "retrying": list(orchestrator.state.retry_attempts)},
        final_state={"claimed": "eng-11" in orchestrator.state.claimed, "workspace_exists": workspace.path.exists()},
        score_reason="Retry handler evidence shows fresh candidate fetch, claim release, no worker spawn, and no workspace cleanup.",
    )

    assert tracker.fetch_candidate_calls == 1
    assert "eng-11" not in orchestrator.state.claimed
    assert "eng-11" not in orchestrator.state.retry_attempts
    assert workspace.path.exists()
    assert runner.started_attempts == []
    assert bundle["final_state"]["workspace_exists"] is True

async def test_flow_012_terminal_transition_stops_run_and_cleans_workspace_with_hook(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-12", id="eng-12")])
    runner = FlowCompletingRunner()
    hook_log = tmp_path / "before-remove.log"
    workspace_manager = WorkspaceManager(
        WorkspaceConfig(root=tmp_path / "workspaces"),
        HooksConfig(before_remove=f"printf before_remove > {hook_log}"),
    )
    workspace = await workspace_manager.create_for_issue("ENG-12")
    (workspace.path / "artifact.txt").write_text("review me\n", encoding="utf-8")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    await orchestrator.tick()
    await runner.started.wait()
    tracker.refreshed = [issue("ENG-12", id="eng-12", state="Done")]

    await orchestrator.reconcile_running()

    bundle = flow_bundle(
        test_id="FLOW-012",
        title="terminal tracker transition stops run and cleans workspace",
        source_sections=["8.5", "8.6", "9.4", "14.4"],
        profile="core",
        initial_state={"issue": "ENG-12", "workspace_exists": True},
        trigger="Tracker refresh returns terminal Done",
        observed_transitions=["state_refresh -> Done", "worker_cancelled", "before_remove_hook", "workspace_removed"],
        workspace_evidence={"workspace_exists_after": workspace.path.exists(), "hook_log": hook_log.read_text(encoding="utf-8")},
        tracker_evidence={"refresh_calls": tracker.fetch_state_calls},
        codex_evidence={"worker_attempts": runner.started_attempts},
        observability_evidence={"running": list(orchestrator.state.running), "claimed": list(orchestrator.state.claimed)},
        final_state={"workspace_exists": workspace.path.exists(), "running": "eng-12" in orchestrator.state.running},
        score_reason="Bundle shows terminal refresh, hook output, workspace removal, and running/claimed cleanup.",
    )

    assert not workspace.path.exists()
    assert hook_log.read_text(encoding="utf-8") == "before_remove"
    assert "eng-12" not in orchestrator.state.running
    assert "eng-12" not in orchestrator.state.claimed
    assert bundle["final_state"]["workspace_exists"] is False

async def test_flow_013_human_review_stops_run_and_preserves_workspace_with_reviewer_evidence(tmp_path: Path) -> None:
    tracker = FlowTracker(candidates=[issue("ENG-13", id="eng-13", project_slug="MT")])
    runner = FlowCompletingRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path / "workspaces"), HooksConfig())
    workspace = await workspace_manager.create_for_issue("ENG-13")
    (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").write_text("validation passed\n", encoding="utf-8")
    orchestrator = Orchestrator(
        config_with_verification(tmp_path, required_checks=[]),
        tracker,
        runner,
        workspace_manager=workspace_manager,
    )
    await orchestrator.tick()
    await runner.started.wait()
    entry = orchestrator.state.running["eng-13"]
    entry.workspace_path = str(workspace.path)
    entry.session_id = "thread-13-turn-1"
    entry.last_codex_message = "Validation evidence is ready for review."
    tracker.refreshed = [issue("ENG-13", id="eng-13", state="Human Review", project_slug="MT")]

    await orchestrator.reconcile_running()

    comment = tracker.comments[-1][1]
    bundle = flow_bundle(
        test_id="FLOW-013",
        title="human review handoff stops automation and preserves artifacts",
        source_sections=["1", "8.5", "14.4"],
        profile="core|quality_overlay",
        initial_state={"issue": "ENG-13", "workspace_path": str(workspace.path)},
        trigger="Tracker refresh returns Human Review for a running issue",
        observed_transitions=["state_refresh -> Human Review", "worker_cancelled", "workspace_preserved", "handoff_comment_written"],
        workspace_evidence={
            "workspace_exists": workspace.path.exists(),
            "validation_artifact": (workspace.path / "PERFORMER_CONDUCTOR_VALIDATION.md").read_text(encoding="utf-8"),
        },
        tracker_evidence={"refresh_calls": tracker.fetch_state_calls, "comment": comment},
        codex_evidence={"session_id": "thread-13-turn-1", "last_message": "Validation evidence is ready for review."},
        observability_evidence={"running": "eng-13" in orchestrator.state.running, "claimed": "eng-13" in orchestrator.state.claimed},
        final_state={"workspace_exists": workspace.path.exists(), "running": "eng-13" in orchestrator.state.running},
        score_reason="Reviewer-facing handoff comment gives tracker state, preserved workspace path, session, and required next action.",
    )

    assert "Performer stopped automation for human review." in comment
    assert "Tracker state: Human Review" in comment
    assert str(workspace.path) in comment
    assert workspace.path.exists()
    assert "eng-13" not in orchestrator.state.running
    assert "eng-13" not in orchestrator.state.claimed
    assert bundle["score"] == 4
