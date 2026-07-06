from test_orchestrator_support import *  # noqa: F401,F403

async def test_due_retry_candidate_fetch_failure_keeps_retry(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)
    tracker.fail_candidates = True

    await orchestrator.process_due_retries()

    retry = orchestrator.state.retry_attempts["mt-1"]
    assert retry.attempt == 3
    assert retry.error == "retry poll failed"
    assert "mt-1" in orchestrator.state.claimed
    assert runner.started == []
    assert "performer_retry failed" in caplog.text
    assert "reason=candidate unavailable" in caplog.text

async def test_startup_cleanup_removes_terminal_workspaces(tmp_path: Path) -> None:
    from performer.workspace import WorkspaceManager

    tracker = FakeTracker()
    tracker.by_states = [issue("MT-1", state="Done")]
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    workspace_manager = WorkspaceManager(orchestrator.config.workspace, orchestrator.config.hooks)
    workspace = await workspace_manager.create_for_issue("MT-1")

    await orchestrator.startup_terminal_workspace_cleanup(workspace_manager)

    assert not workspace.path.exists()
