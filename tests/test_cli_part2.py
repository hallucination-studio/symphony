from test_cli_support import *  # noqa: F401,F403

async def test_run_phase_advance_writes_retry_result_when_advance_hangs(tmp_path: Path, monkeypatch) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    request_path.write_text(
        json.dumps(
            PhaseAdvanceRequest(
                run_id="run-1",
                instance_id="inst-1",
                issue_id="issue-123",
                issue_identifier="ENG-1",
                current_phase=RunPhase.QUEUED,
                attempt=1,
                workspace_context={},
            ).to_dict()
        ),
        encoding="utf-8",
    )

    class HangingOrchestrator:
        def __init__(self, *args, **kwargs):
            self.workspace_manager = object()

        def load_persisted_state(self):
            pass

        async def startup_terminal_workspace_cleanup(self, workspace_manager):
            pass

        async def advance(self, request):
            await cli.asyncio.Event().wait()

        async def wait_for_idle(self):
            pass

    config = replace(
        make_service_config(tmp_path, project_slug="MT", api_key="token", workspace="ws", command="codex"),
        codex=CodexConfig(read_timeout_ms=1, hard_turn_timeout_ms=1),
    )
    monkeypatch.setattr(cli, "build_config_from_path", lambda path: config)
    monkeypatch.setattr(cli, "validate_tracker_config", lambda tracker_config: None)
    monkeypatch.setattr(cli, "create_tracker", lambda tracker_config: object())
    monkeypatch.setattr(cli, "WorkspaceManager", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "AgentRunner", lambda *args, **kwargs: object())
    monkeypatch.setattr(cli, "persistence_store_from_config", lambda config: object())
    monkeypatch.setattr(cli, "build_acceptance_runner", lambda config: None)
    monkeypatch.setattr(cli, "Orchestrator", HangingOrchestrator)

    result = await cli.run_phase_advance(workflow, request_path, result_path)
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "retry"
    assert result.reason == "turn_timeout"
    assert payload["status"] == "retry"
    assert payload["reason"] == "turn_timeout"

def test_main_returns_nonzero_on_startup_failure(monkeypatch) -> None:
    async def failing_daemon(path, *, once=False):
        raise RuntimeError("boom")

    monkeypatch.setattr(cli, "run_reloading_daemon", failing_daemon)

    assert cli.main(["WORKFLOW.md", "--once"]) == 1

def test_phase_main_exits_without_waiting_for_stuck_executor_after_result(monkeypatch, tmp_path: Path) -> None:
    workflow = tmp_path / "WORKFLOW.md"
    request_path = tmp_path / "request.json"
    result_path = tmp_path / "result.json"
    workflow.write_text("placeholder", encoding="utf-8")
    request_path.write_text("{}", encoding="utf-8")
    exits: list[int] = []

    async def fake_phase_advance(workflow_path, advance_request_path, phase_result_path):
        phase_result_path.write_text('{"status":"retry"}', encoding="utf-8")
        return None

    def fake_exit(code: int) -> None:
        exits.append(code)
        raise SystemExit(code)

    monkeypatch.setattr(cli, "run_phase_advance", fake_phase_advance)
    monkeypatch.setattr(cli.os, "_exit", fake_exit)

    with pytest.raises(SystemExit) as exc:
        cli.main(
            [
                str(workflow),
                "--advance-request-path",
                str(request_path),
                "--phase-result-path",
                str(result_path),
            ]
        )

    assert exc.value.code == 0
    assert exits == [0]

def test_main_returns_zero_on_normal_shutdown(monkeypatch) -> None:
    captured = {}

    async def successful_daemon(path, *, once=False):
        captured["once"] = once
        return None

    monkeypatch.setattr(cli, "run_reloading_daemon", successful_daemon)

    assert cli.main(["WORKFLOW.md", "--once"]) == 0
    assert captured["once"] is True
