from test_orchestrator_support import *  # noqa: F401,F403

async def test_request_timeout_updates_last_message_with_readable_error(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "request_timeout",
            "method": "initialize",
            "timeout_ms": 500,
        },
    )

    assert orchestrator.state.running["mt-1"].last_codex_message == "initialize timed out"
    assert orchestrator.state.running["mt-1"].phase == "error"
    assert orchestrator.state.running["mt-1"].status_label == "performer:phase/failed"
    await asyncio_sleep()
    assert ("mt-1", "performer:phase/failed") not in tracker.lifecycle_labels
    assert ("mt-1", "performer:failed") not in tracker.lifecycle_labels
    assert tracker.comments[-1][0] == "mt-1"
    assert "Performer runtime error" in tracker.comments[-1][1]
    assert "initialize timed out" in tracker.comments[-1][1]

async def test_permission_runtime_error_blocks_for_human_approval(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", assignee_id="human-1")])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "stderr",
            "message": "patch rejected: writing outside of the project; approval required",
        },
    )
    await orchestrator.wait_for_idle()
    await asyncio_sleep()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert orchestrator.state.human_interventions["mt-1"].kind == "runtime_permission"
    assert orchestrator.state.human_interventions["mt-1"].status_label == "performer:phase/blocked"
    assert "runtime_permission_blocked" in (orchestrator.state.human_interventions["mt-1"].error or "")
    child = tracker.created_issues[-1]
    assert child["parent_id"] == "mt-1"
    assert child["assignee_id"] == "human-1"
    assert child["title"] == "[Human Action] MT-1: Runtime approval required"
    assert "performer:type/human-action" in child["label_ids"]
    assert "performer:human/pending" not in child["label_ids"]
    assert "performer:human/runtime-approval" not in child["label_ids"]
    assert "Human response:" in child["description"]
    persisted = store.load()
    assert persisted.human_interventions[0].issue_id == "mt-1"
    assert persisted.retry_attempts == []
    assert ("mt-1", "performer:phase/blocked") not in tracker.lifecycle_labels
    assert ("mt-1", "performer:error/human-blocked") not in tracker.lifecycle_labels
    assert ("mt-1", "performer:retrying") not in tracker.lifecycle_labels
    assert "paused" in tracker.comments[-1][1]
    assert "/symphony approve-runtime-error" not in tracker.comments[-1][1]

async def test_permission_output_event_blocks_for_human_approval(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "raw_method": "item/commandExecution/outputDelta",
            "message": "zsh:1: operation not permitted: /source/SYMPHONY_PERMISSION_DENIED_PROBE.md",
        },
    )
    await orchestrator.wait_for_idle()
    await asyncio_sleep()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert orchestrator.state.human_interventions["mt-1"].kind == "runtime_permission"
    assert "runtime_permission_blocked" in (orchestrator.state.human_interventions["mt-1"].error or "")
    assert ("mt-1", "performer:phase/blocked") not in tracker.lifecycle_labels
    assert ("mt-1", "performer:error/human-blocked") not in tracker.lifecycle_labels
    assert "/symphony approve-runtime-error" not in tracker.comments[-1][1]

async def test_permission_text_in_prompt_does_not_reblock_runtime(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "raw_method": "item/started",
            "message": "Previous attempt failed: operation not permitted",
        },
    )
    await asyncio_sleep()

    assert "mt-1" in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.blocked
    assert tracker.comments == []

async def test_permission_summary_event_blocks_for_human_approval(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "raw_method": "item/completed",
            "message": "The outside-workspace write failed with: zsh:1: operation not permitted",
        },
    )
    await orchestrator.wait_for_idle()
    await asyncio_sleep()

    assert "mt-1" not in orchestrator.state.running
    assert orchestrator.state.human_interventions["mt-1"].kind == "runtime_permission"
    assert "/symphony approve-runtime-error" not in tracker.comments[-1][1]

async def test_old_linear_approval_comment_does_not_resume_blocked_runtime_error(tmp_path: Path) -> None:
    blocked_issue = issue("MT-1")
    tracker = FakeTracker(candidates=[blocked_issue])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "stderr",
            "message": "patch rejected: writing outside of the project; approval required",
        },
    )
    await orchestrator.wait_for_idle()
    created_at = orchestrator.state.human_interventions["mt-1"].created_at
    tracker.issue_comments["mt-1"] = [
        {
            "id": "comment-approval",
            "body": "/symphony approve-runtime-error MT-1",
            "created_at": (created_at + timedelta(seconds=1)).isoformat(),
            "user": {"id": "human-1", "name": "Human"},
        }
    ]

    await orchestrator.tick()

    assert "mt-1" in orchestrator.state.human_interventions
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.running
    persisted = store.load()
    assert persisted.human_interventions[0].issue_id == "mt-1"
    assert persisted.retry_attempts == []

async def test_done_human_action_child_resumes_runtime_error(tmp_path: Path) -> None:
    blocked_issue = issue("MT-1")
    tracker = FakeTracker(candidates=[blocked_issue])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "stderr",
            "message": "patch rejected: writing outside of the project; approval required",
        },
    )
    await orchestrator.wait_for_idle()
    child = tracker.created_issues[-1]
    child["state"] = "Done"

    await orchestrator.tick()

    assert "mt-1" not in orchestrator.state.human_interventions
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.running
    assert runner.started[-1][0].id == "mt-1"
    assert runner.started[-1][1] == 1
    assert ("mt-1", "performer:phase/implementation") not in tracker.lifecycle_labels
    persisted = store.load()
    assert persisted.human_interventions == []
    assert persisted.retry_attempts == []

async def test_orchestrator_persists_retry_and_session_metadata(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)

    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)
    loaded = store.load()

    assert loaded.retry_attempts[0].issue_id == "mt-1"
    assert loaded.retry_attempts[0].attempt == 2

    tracker.candidates = [issue("MT-2")]
    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-2",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    loaded = store.load()

    assert loaded.sessions[0].issue_id == "mt-2"
    assert loaded.sessions[0].session_id == "thread-1-turn-1"

def test_orchestrator_loads_persisted_retries(tmp_path: Path) -> None:
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    first = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    first._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)

    second = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    second.load_persisted_state()

    assert "mt-1" in second.state.retry_attempts
    assert "mt-1" in second.state.claimed
    assert second.state.retry_attempts["mt-1"].attempt == 2

def test_orchestrator_persists_and_loads_codex_threads(tmp_path: Path) -> None:
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    first = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    first.state.codex_threads["mt-1"] = CodexThreadEntry(
        issue_id="mt-1",
        thread_id="thread-1",
        backend="sdk",
        workspace_path=str(tmp_path / "workspace"),
        last_turn_id="turn-1",
        status="resume_pending",
    )
    first._persist_state()

    second = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    second.load_persisted_state()

    assert store.load().codex_threads[0].thread_id == "thread-1"
    assert second.state.codex_threads["mt-1"].thread_id == "thread-1"
    assert "mt-1" in second.state.claimed

def test_orchestrator_load_does_not_claim_completed_codex_thread(tmp_path: Path) -> None:
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    first = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    first.state.codex_threads["mt-1"] = CodexThreadEntry(
        issue_id="mt-1",
        thread_id="thread-1",
        backend="sdk",
        workspace_path=str(tmp_path / "workspace"),
        last_turn_id="turn-1",
        status="completed",
    )
    first.state.mark_completed("mt-1")
    first._persist_state()

    second = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner(), persistence_store=store)
    second.load_persisted_state()

    assert second.state.codex_threads["mt-1"].status == "completed"
    assert "mt-1" in second.state.completed
    assert "mt-1" not in second.state.claimed

async def test_codex_events_persist_thread_metadata(tmp_path: Path) -> None:
    store = PersistenceStore(tmp_path / "state" / "performer.json")
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, persistence_store=store)

    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "cwd": str(tmp_path / "workspace"),
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "turn_completed",
            "thread_id": "thread-1",
            "turn_id": "turn-2",
            "session_id": "thread-1-turn-2",
            "message": "finished",
        },
    )

    thread = store.load().codex_threads[0]
    assert thread.issue_id == "mt-1"
    assert thread.thread_id == "thread-1"
    assert thread.last_turn_id == "turn-2"
    assert thread.workspace_path == str(tmp_path / "workspace")
    assert thread.last_final_response == "finished"
    assert thread.status == "resume_pending"

def test_completed_codex_thread_is_not_overwritten_by_late_event(tmp_path: Path) -> None:
    orchestrator = Orchestrator(make_config(tmp_path), FakeTracker(), FakeRunner())
    issue_obj = issue("MT-1")
    entry = RunningEntry(issue=issue_obj, task=None, started_at=utc_now(), retry_attempt=0, thread_id="thread-1")
    orchestrator.state.mark_running(entry)
    orchestrator.state.codex_threads["mt-1"] = CodexThreadEntry(
        issue_id="mt-1",
        thread_id="thread-1",
        backend="sdk",
        workspace_path=str(tmp_path / "workspace"),
        status="completed",
    )

    orchestrator._apply_codex_thread_event(
        entry,
        {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-late", "message": "late"},
    )

    thread = orchestrator.state.codex_threads["mt-1"]
    assert thread.status == "completed"
    assert thread.last_turn_id is None

async def test_worker_failure_marks_codex_thread_failed(tmp_path: Path) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            on_event(
                {
                    "event": "session_started",
                    "thread_id": "thread-1",
                    "turn_id": "turn-1",
                    "session_id": "thread-1-turn-1",
                    "cwd": str(tmp_path / "workspace"),
                }
            )
            raise RuntimeError("boom")

    store = PersistenceStore(tmp_path / "state" / "performer.json")
    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner(), persistence_store=store)

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    thread = store.load().codex_threads[0]
    assert thread.issue_id == "mt-1"
    assert thread.thread_id == "thread-1"
    assert thread.status == "failed"

async def test_reconcile_terminal_running_issue_cancels_and_releases(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="Done")]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts

async def test_reconcile_terminal_running_issue_finalizes_open_ops_records(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    base = make_config(tmp_path)
    persistence_path = tmp_path / "state" / "performer.json"
    config = ServiceConfig(
        tracker=base.tracker,
        polling=base.polling,
        workspace=base.workspace,
        hooks=base.hooks,
        agent=base.agent,
        codex=base.codex,
        prompt_template=base.prompt_template,
        workflow_path=base.workflow_path,
        persistence=PersistenceConfig(path=persistence_path),
        completion_verification=base.completion_verification,
    )
    orchestrator = Orchestrator(config, tracker, runner, persistence_store=PersistenceStore(persistence_path))
    await orchestrator.tick()
    ops_store = OpsStore(ops_snapshot_path_from_persistence_path(persistence_path))
    recorder = ExecutionTelemetryRecorder(ops_store)
    run_id = recorder.open_run("mt-1", "MT-1", "inst-1", str(tmp_path), "abc123")
    attempt_id = recorder.open_attempt(run_id, attempt_number=1)
    recorder.open_turn(attempt_id, turn_number=1)
    tracker.refreshed = [issue("MT-1", state="Done")]

    await orchestrator.reconcile_running()
    await orchestrator.wait_for_idle()

    snapshot = ops_store.load()
    assert snapshot.runs[run_id].status == "completed"
    assert snapshot.attempts[attempt_id].status == "completed"
    assert snapshot.events[-1].event_type == "run_completed"

async def test_active_state_refresh_updates_running_entry_state(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="In Progress")]

    await orchestrator.reconcile_running()

    assert orchestrator.state.running["mt-1"].issue.state == "In Progress"

async def test_reconcile_with_no_running_issues_is_noop(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.reconcile_running()

    assert orchestrator.state.running == {}

async def test_reconcile_terminal_running_issue_cleans_workspace(tmp_path: Path) -> None:
    from performer.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, workspace_manager=workspace_manager)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="Done")]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert not workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts

async def test_reconcile_active_issue_that_loses_required_delegate_stops_without_cleanup(tmp_path: Path) -> None:
    from performer.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config_with_required_delegate(tmp_path, "agent-user-1"), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", delegate_id="other-agent")]

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts

async def test_reconcile_missing_refreshed_issue_stops_without_cleanup(tmp_path: Path) -> None:
    from performer.workspace import WorkspaceManager

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    workspace_manager = WorkspaceManager(WorkspaceConfig(root=tmp_path), HooksConfig())
    workspace = await workspace_manager.create_for_issue("MT-1")
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner, workspace_manager=workspace_manager)
    await orchestrator.tick()
    tracker.refreshed = []

    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert workspace.path.exists()
    await orchestrator.wait_for_idle()
    assert "mt-1" not in orchestrator.state.retry_attempts

async def test_reconcile_refresh_failure_keeps_workers_running(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.fail_refresh = True

    await orchestrator.reconcile_running()

    assert "mt-1" in orchestrator.state.running
    assert "performer_reconcile failed" in caplog.text
    assert "reason=refresh unavailable" in caplog.text

async def test_startup_cleanup_failure_logs_warning_and_continues(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    from performer.workspace import WorkspaceManager

    tracker = FakeTracker()
    tracker.fail_by_states = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    workspace_manager = WorkspaceManager(orchestrator.config.workspace, orchestrator.config.hooks)

    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)

    assert "performer_startup_cleanup failed" in caplog.text
    assert "reason=linear unavailable" in caplog.text

async def test_stall_detection_cancels_and_retries(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    entry = orchestrator.state.running["mt-1"]
    entry.started_at = utc_now() - timedelta(seconds=10)

    await orchestrator.reconcile_running()

    assert orchestrator.state.human_interventions == {}
    assert orchestrator.state.retry_attempts["mt-1"].error == "stalled"
    outcome = orchestrator.phase_runtime.pop_recorded_outcome("mt-1")
    assert outcome is not None
    assert outcome.next_phase is RunPhase.QUEUED
    assert outcome.status == "retry"
    assert outcome.reason == "stalled"

async def test_stall_detection_does_not_create_human_action(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(stall_timeout_ms=1),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    entry = orchestrator.state.running["mt-1"]
    entry.started_at = utc_now() - timedelta(seconds=10)

    await orchestrator.reconcile_running()

    assert tracker.comments == []
    assert tracker.created_issues == []
    assert orchestrator.state.retry_attempts["mt-1"].runtime_phase == "failed"

async def test_hard_turn_timeout_cancels_even_when_events_keep_arriving(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    config = make_config(tmp_path)
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(stall_timeout_ms=60_000, hard_turn_timeout_ms=1),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )
    orchestrator = Orchestrator(config, tracker, runner)
    await orchestrator.tick()
    entry = orchestrator.state.running["mt-1"]
    entry.turn_started_at = utc_now() - timedelta(seconds=10)
    entry.last_codex_timestamp = utc_now()

    await orchestrator.reconcile_running()

    assert orchestrator.state.human_interventions["mt-1"].kind == "runtime_error"
    assert orchestrator.state.human_interventions["mt-1"].error == "turn_timeout"
    outcome = orchestrator.phase_runtime.pop_recorded_outcome("mt-1")
    assert outcome is not None
    assert outcome.next_phase is RunPhase.QUEUED
    assert outcome.status == "retry"
    assert outcome.reason == "turn_timeout"

async def test_due_retry_dispatches_when_issue_is_still_candidate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == [(tracker.candidates[0], 2)]
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed

async def test_due_retry_releases_claim_when_issue_loses_required_delegate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="other-agent")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_required_delegate(tmp_path, "agent-user-1"), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1", delegate_id="agent-user-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.claimed

async def test_due_retry_requeues_when_slots_are_unavailable(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path, max_concurrent=0), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert runner.started == []
    assert retry.attempt == 3
    assert retry.error == "no available orchestrator slots"
    assert retry.due_at_ms > 0
    assert "mt-1" in orchestrator.state.claimed
