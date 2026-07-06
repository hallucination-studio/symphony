from test_orchestrator_support import *  # noqa: F401,F403

async def test_acceptance_rejected_releases_claim_for_rework_dispatch(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[])
    original = issue("MT-1", state="In Review")
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "description": "Purpose: verify behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "url": "https://linear.app/x/issue/MT-G1",
        }
    ]
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 2,
  "result": "fail",
  "score_reason": "The implementation evidence is incomplete.",
  "evidence_citations": ["linear.issue.MT-1"],
  "residual_findings": ["Implementation needs rework."],
  "recommended_next_action": "Return to implementation."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        CompletingRunner(),
        acceptance_runner=acceptance_runner,
    )
    orchestrator.state.claimed.add("mt-1")

    await orchestrator._run_acceptance_gate_for_issue(original, completion_verdict=None)

    assert tracker.transitions == []
    assert "mt-1" not in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.continuations

async def test_acceptance_in_review_is_not_dispatched_to_agent(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Review")])
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "description": "Purpose: verify behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "url": "https://linear.app/x/issue/MT-G1",
        }
    ]
    runner = FakeRunner()
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "The submitted evidence includes implementation details, test command output, and residual risk notes.",
  "evidence_citations": ["linear.comment.evidence", "workspace.diff"],
  "residual_findings": [],
  "recommended_next_action": "Accept and close both issues."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        runner,
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    assert runner.started == []
    assert acceptance_runner.calls
    evidence = tracker.children["gate-1"][0]
    assert tracker.transitions == [(evidence["id"], "Done"), ("gate-1", "Done")]

async def test_acceptance_direct_done_bypass_with_evidence_runs_gate_from_review(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(
        candidates=[
            issue(
                "MT-1",
                state="Done",
                description="Implementation summary: changed code\nTest command: pytest\nTest output: passed\nRemaining risks: none",
            )
        ]
    )
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "description": "Purpose: verify behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "url": "https://linear.app/x/issue/MT-G1",
        }
    ]
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "The direct Done bypass still has concrete implementation, test output, and risk evidence to review.",
  "evidence_citations": ["linear.issue.description"],
  "residual_findings": [],
  "recommended_next_action": "Run the gate from In Review and then close."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        FakeRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    evidence = tracker.children["gate-1"][0]
    assert tracker.transitions == [(evidence["id"], "Done"), ("gate-1", "Done")]
    assert acceptance_runner.calls

async def test_acceptance_direct_done_bypass_without_evidence_returns_to_in_progress(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="Done", description="done")])
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
        }
    ]
    acceptance_runner = FakeAcceptanceRunner("{}")
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        FakeRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    assert tracker.transitions == []
    assert acceptance_runner.calls == []
    assert tracker.comments[-1][0] == "mt-1"
    assert "direct Done bypass" in tracker.comments[-1][1]

async def test_acceptance_direct_done_bypass_ignores_gate_plan_marker_evidence_requirements(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(
        candidates=[
            issue(
                "MT-1",
                state="Done",
                description=(
                    "Business issue without implementation evidence.\n\n"
                    "<!-- BEGIN PERFORMER ACCEPTANCE -->\n"
                    "Evidence required:\n"
                    "* Implementation summary.\n"
                    "* Test commands and exact output.\n"
                    "* Remaining risks or explicit none.\n"
                    "<!-- END PERFORMER ACCEPTANCE -->"
                ),
            )
        ]
    )
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
        }
    ]
    acceptance_runner = FakeAcceptanceRunner("{}")
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        FakeRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    assert tracker.transitions == []
    assert acceptance_runner.calls == []

async def test_acceptance_done_with_passed_gate_is_not_treated_as_bypass(tmp_path: Path) -> None:
    tracker = FakeTracker(
        candidates=[
            issue(
                "MT-1",
                state="Done",
                labels=["codex", "performer:gate/passed", "performer:score/4/4"],
                description="Implementation summary: done\nTest command: pytest\nRemaining risks: none",
            )
        ]
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        FakeRunner(),
        acceptance_runner=FakeAcceptanceRunner("{}"),
    )

    await orchestrator.tick()

    assert tracker.transitions == []
    assert tracker.comments == []

async def test_completion_verification_failure_retries_instead_of_marking_done(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(
        make_config_with_completion_verification(tmp_path, required_checks=["workspace_changes"]),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed
    assert ("mt-1", "performer:phase/implementation") not in tracker.lifecycle_labels
    assert ("mt-1", "performer:retry/pending") not in tracker.lifecycle_labels
    assert tracker.comments[-1][0] == "mt-1"
    assert "Verification failed after agent claimed success." in tracker.comments[-1][1]
    assert "workspace_changes" in tracker.comments[-1][1]

async def test_completion_verification_needs_human_does_not_mark_done(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.refreshed = [
        issue(
            "MT-1",
            blocked_by=[BlockerRef(id="dep-1", identifier="MT-0", state="In Progress")],
        )
    ]
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / "README.md").write_text("changed\n", encoding="utf-8")
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(
        make_config_with_completion_verification(
            tmp_path,
            required_checks=[],
            optional_checks=["linear_state"],
            auto_retry_on_fail=True,
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed
    assert "mt-1" in orchestrator.state.human_interventions
    assert orchestrator.state.human_interventions["mt-1"].kind == "verification_needs_human"
    assert orchestrator.state.continuations == {}
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels
    assert tracker.comments[-1][0] == "mt-1"
    assert "human review is required" in tracker.comments[-1][1].lower()

async def test_completion_verification_needs_human_does_not_create_legacy_acceptance_issue_when_enabled(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress")])
    tracker.refreshed = [
        issue(
            "MT-1",
            state="Done",
            blocked_by=[BlockerRef(id="dep-1", identifier="MT-0", state="In Progress")],
        )
    ]
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / "README.md").write_text("changed\n", encoding="utf-8")
    runner = ControlledCompletingRunner()
    config = make_config_with_completion_verification(
        tmp_path,
        required_checks=[],
        optional_checks=["linear_state"],
        auto_retry_on_fail=True,
    )
    config = ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        completion_verification=config.completion_verification,
        acceptance=AcceptanceConfig(enabled=True),
    )
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 2,
  "result": "fail",
  "score_reason": "The completion verifier found active blockers, so the claimed Done state is not acceptable evidence.",
  "evidence_citations": ["completion_verdict.linear_state", "linear.issue.MT-1"],
  "residual_findings": ["Resolve or document the active blocker before accepting the task."],
  "recommended_next_action": "Keep the original issue blocked and require human review."
}
"""
    )
    orchestrator = Orchestrator(
        config,
        tracker,
        runner,
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed
    assert "implementation_evidence_missing" in str(orchestrator.state.retry_attempts["mt-1"].error)
    assert tracker.created_issues == []
    assert tracker.created_relations == []
    assert acceptance_runner.calls == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

async def test_completion_verification_needs_human_with_acceptance_records_review_before_gate(
    tmp_path: Path,
) -> None:
    description = (
        "Implementation summary: created requested artifact.\n"
        "Test commands and exact output: test -f PERFORMER_REAL_SMALL_TASK.md -> exit code 0.\n"
        "Remaining risks: none."
    )
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress", description=description)])
    tracker.refreshed = [
        issue(
            "MT-1",
            state="In Progress",
            description=description,
            blocked_by=[BlockerRef(id="dep-1", identifier="MT-0", state="In Progress")],
        )
    ]
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Evidence",
            "description": "Purpose: verify evidence",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "url": "https://linear.app/x/issue/MT-G1",
        }
    ]
    workspace = tmp_path / "MT-1"
    workspace.mkdir()
    (workspace / "README.md").write_text("changed\n", encoding="utf-8")
    runner = ControlledCompletingRunner()
    base = make_config_with_completion_verification(
        tmp_path,
        required_checks=[],
        optional_checks=["linear_state"],
        auto_retry_on_fail=True,
    )
    config = ServiceConfig(
        tracker=base.tracker,
        polling=base.polling,
        workspace=base.workspace,
        hooks=base.hooks,
        agent=base.agent,
        codex=base.codex,
        prompt_template=base.prompt_template,
        workflow_path=base.workflow_path,
        completion_verification=base.completion_verification,
        acceptance=AcceptanceConfig(enabled=True),
    )
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Implementation evidence is sufficient for this gate.",
  "evidence_citations": ["linear.issue.MT-1"],
  "residual_findings": [],
  "recommended_next_action": "Pass this gate."
}
"""
    )
    orchestrator = Orchestrator(config, tracker, runner, acceptance_runner=acceptance_runner)

    await orchestrator.tick()
    await runner.started.wait()
    orchestrator.state.running["mt-1"].workspace_path = str(workspace)
    runner.release.set()
    await orchestrator.wait_for_idle()

    assert acceptance_runner.calls
    assert tracker.transitions == [("issue-1", "Done"), ("gate-1", "Done")]
    assert "mt-1" not in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.continuations

async def test_retry_prompt_includes_previous_verification_failure_reason(tmp_path: Path) -> None:
    from performer.runner import AgentRunner
    from performer.workspace import WorkspaceManager

    class CapturingCodexClient:
        def __init__(self) -> None:
            self.prompts: list[str] = []

        async def run_session(self, workspace_path, prompt, title, **kwargs):
            self.prompts.append(prompt)

    class NoopTracker:
        async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
            return [issue("MT-1")]

    config = make_config(tmp_path)
    workspace_manager = WorkspaceManager(config.workspace, config.hooks)
    codex_client = CapturingCodexClient()
    runner = AgentRunner(config, workspace_manager, codex_client=codex_client, tracker=NoopTracker())

    issue_payload = issue("MT-1")
    issue_payload.description = "Previous attempt failed verification: workspace_changes"

    await runner.run_issue(issue_payload, 2, lambda event: None)

    assert "Previous attempt failed verification:" in codex_client.prompts[0]
    assert "workspace_changes" in codex_client.prompts[0]

async def test_codex_event_updates_session_and_token_totals(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "session_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
                    },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "thread_token_usage_updated",
            "session_id": "thread-1-turn-1",
            "payload": {
                "total_token_usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "total_tokens": 140,
                }
            },
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "thread_token_usage_updated",
            "session_id": "thread-1-turn-1",
            "payload": {
                "total_token_usage": {
                    "input_tokens": 130,
                    "output_tokens": 50,
                    "cached_tokens": 20,
                    "total_tokens": 180,
                }
            },
        },
    )

    entry = orchestrator.state.running["mt-1"]
    assert entry.session_id == "thread-1-turn-1"
    assert entry.thread_id == "thread-1"
    assert entry.turn_id == "turn-1"
    assert entry.tokens.input_tokens == 130
    assert entry.tokens.output_tokens == 50
    assert entry.tokens.cached_tokens == 20
    assert entry.tokens.total_tokens == 180
    assert entry.recent_events[-1]["event"] == "thread_token_usage_updated"
    assert entry.recent_events[-1]["usage"] == {
        "input_tokens": 130,
        "output_tokens": 50,
        "cached_tokens": 20,
        "total_tokens": 180,
    }
    assert entry.recent_events[-1]["raw_event"]["payload"]["total_token_usage"]["total_tokens"] == 180
    assert orchestrator.state.codex_totals.input_tokens == 130
    assert orchestrator.state.codex_totals.output_tokens == 50
    assert orchestrator.state.codex_totals.total_tokens == 180

async def test_codex_events_are_logged_with_issue_context(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/agentMessage/delta",
            "message": "working",
        },
    )

    assert "performer_codex_event" in caplog.text
    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "event=notification" in caplog.text
    assert "raw_method=item/agentMessage/delta" in caplog.text
    assert "message=working" in caplog.text

async def test_low_value_codex_events_do_not_overwrite_last_useful_message(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/completed",
            "message": "189 passed, 1 skipped",
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/commandExecution/outputDelta",
            "message": ".",
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/started",
        },
    )

    assert orchestrator.state.running["mt-1"].last_codex_message == "189 passed, 1 skipped"

async def test_command_execution_events_capture_command_and_exit_code_in_recent_events(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()

    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/commandExecution/started",
            "payload": {"command": "pytest tests/test_target.py::test_fix -q"},
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "notification",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
            "raw_method": "item/completed",
            "payload": {"exit_code": 0, "command": "pytest tests/test_target.py::test_fix -q"},
            "message": "1 passed",
        },
    )

    recent = orchestrator.state.running["mt-1"].recent_events
    assert recent[-2]["command"] == "pytest tests/test_target.py::test_fix -q"
    assert recent[-1]["command"] == "pytest tests/test_target.py::test_fix -q"
    assert recent[-1]["exit_code"] == 0
