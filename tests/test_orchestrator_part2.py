from test_orchestrator_support import *  # noqa: F401,F403

async def test_todo_issue_with_non_terminal_blocker_is_not_dispatched(tmp_path: Path) -> None:
    blocked = issue(
        "MT-1",
        blocked_by=[BlockerRef(id="dep", identifier="MT-0", state="In Progress")],
    )
    tracker = FakeTracker(candidates=[blocked])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []

async def test_todo_issue_with_terminal_blocker_is_dispatched(tmp_path: Path) -> None:
    blocked = issue(
        "MT-1",
        blocked_by=[BlockerRef(id="dep", identifier="MT-0", state="Done")],
    )
    tracker = FakeTracker(candidates=[blocked])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]

async def test_worker_failure_schedules_exponential_retry(tmp_path: Path) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    intervention = orchestrator.state.human_interventions["mt-1"]
    assert intervention.attempt == 1
    assert intervention.kind == "runtime_error"
    assert intervention.error == "worker exited: boom"
    assert "mt-1" in orchestrator.state.claimed
    assert ("mt-1", "performer:phase/blocked") not in tracker.lifecycle_labels
    assert tracker.created_issues[-1]["title"] == "[Human Action] MT-1: Runtime error needs review"
    assert "worker exited: boom" in tracker.created_issues[-1]["description"]

async def test_worker_failure_comments_on_linear_issue(tmp_path: Path) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert tracker.comments == []
    child = tracker.created_issues[-1]
    assert child["parent_id"] == "mt-1"
    assert "MT-1" in child["title"]
    assert "worker exited: boom" in child["description"]
    assert "move this child issue to Done" in child["description"]

async def test_retrying_issue_is_not_dispatched_by_normal_candidate_scan(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)

    await orchestrator.tick()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed

def test_schedule_retry_blocks_after_verification_retry_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(
        make_config_with_completion_verification(
            tmp_path,
            required_checks=["test_command_evidence"],
            max_verification_retries=1,
        ),
        tracker,
        runner,
    )

    orchestrator._schedule_retry(issue("MT-1"), 3, error="verification_failed: command missing", delay_ms=60_000)

    blocked = orchestrator.state.blocked["mt-1"]
    outcome = orchestrator.phase_runtime.pop_recorded_outcome("mt-1")
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed
    assert blocked.error == "verification retry limit exceeded: verification_failed: command missing"
    assert blocked.attempt == 3
    assert outcome is not None
    assert outcome.next_phase is RunPhase.AWAITING_HUMAN
    assert outcome.status == "failed"

async def test_future_monotonic_retry_is_not_dispatched_when_wall_clock_due_at_is_past(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)
    orchestrator.state.retry_attempts["mt-1"].due_at = utc_now() - timedelta(seconds=60)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts

async def test_worker_failure_is_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    class FailingRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            raise RuntimeError("boom")

    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FailingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "performer_worker outcome=failed" in caplog.text
    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "reason=boom" in caplog.text

async def test_worker_lifecycle_logs_include_issue_and_session_context(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "issue_id=mt-1" in caplog.text
    assert "issue_identifier=MT-1" in caplog.text
    assert "session_id=thread-1-turn-1" in caplog.text
    assert "outcome=completed" in caplog.text

async def test_normal_worker_exit_schedules_continuation_for_still_active_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    continuation = orchestrator.state.continuations["mt-1"]
    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert continuation.attempt == 1
    assert continuation.phase == "continuing"
    assert continuation.status_label == "performer:phase/implementation"
    assert "mt-1" not in orchestrator._desired_lifecycle_labels
    assert ("mt-1", "performer:phase/implementation") not in tracker.lifecycle_labels

async def test_completion_refresh_missing_issue_schedules_continuation(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="Todo")])
    tracker.refreshed = []
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    continuation = orchestrator.state.continuations["mt-1"]
    assert continuation.last_message == "completion state refresh failed; continuing"
    assert "mt-1" in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.completed

async def test_zero_check_verification_without_acceptance_keeps_active_issue_continuing(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="Todo")])
    tracker.refreshed = [issue("MT-1", state="Todo")]
    orchestrator = Orchestrator(
        make_config_with_completion_verification(tmp_path, required_checks=[]),
        tracker,
        CompletingRunner(),
    )

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    continuation = orchestrator.state.continuations["mt-1"]
    assert tracker.transitions == []
    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" in orchestrator.state.claimed
    assert continuation.attempt == 1
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

async def test_due_continuation_dispatches_without_retry_label(tmp_path: Path) -> None:
    candidate = issue("MT-1")
    tracker = FakeTracker(candidates=[candidate])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_continuation(candidate, 2, delay_ms=-1)

    await orchestrator.process_due_continuations()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert runner.started[0][1] == 2
    assert "mt-1" not in orchestrator.state.continuations
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert ("mt-1", "performer:retrying") not in tracker.lifecycle_labels

async def test_normal_worker_exit_records_completed_bookkeeping_for_terminal_issue(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.refreshed = [issue("MT-1", state="Done")]
    orchestrator = Orchestrator(make_config(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "mt-1" in orchestrator.state.completed
    assert "mt-1" not in orchestrator.state.claimed
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

async def test_acceptance_enabled_creates_gate_issue_instead_of_marking_original_done(tmp_path: Path) -> None:
    description = (
        "Implementation summary: created requested behavior.\n"
        "Test commands and exact output: pytest tests/test_target.py -q -> passed.\n"
        "Remaining risks: none."
    )
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress", description=description, delegate_id="agent-user-1")])
    tracker.refreshed = [issue("MT-1", state="In Progress", description=description, delegate_id="agent-user-1")]
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "delegate_id": "agent-user-1",
        }
    ]
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert "mt-1" not in orchestrator.state.completed
    assert tracker.created_issues == []
    assert tracker.created_relations == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels
    assert any(label == "performer:gate/pending" for _, label in tracker.lifecycle_labels)
    assert tracker.transitions == []

async def test_structured_codex_result_is_published_before_acceptance_review(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress", delegate_id="agent-user-1")])
    tracker.refreshed = [issue("MT-1", state="In Progress", delegate_id="agent-user-1")]
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "delegate_id": "agent-user-1",
        }
    ]
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, StructuredCompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert tracker.description_updates
    _, marker, block = tracker.description_updates[-1]
    assert marker == "PERFORMER IMPLEMENTATION EVIDENCE"
    assert "Implementation summary:" in block
    assert "created requested artifact" in block
    assert "Test commands and exact output:" in block
    assert "pytest tests/test_smoke.py -q -> 1 passed" in block
    assert any("Performer implementation handoff." in body for _, body in tracker.comments)
    assert tracker.transitions == []

async def test_acceptance_enabled_leaves_review_for_conductor_coordinated_gate(tmp_path: Path) -> None:
    description = (
        "Implementation summary: created requested behavior.\n"
        "Test commands and exact output: pytest tests/test_target.py -q -> passed.\n"
        "Remaining risks: none."
    )
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress", description=description, delegate_id="agent-user-1")])
    tracker.refreshed = [issue("MT-1", state="In Progress", description=description, delegate_id="agent-user-1")]
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Behavior",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "delegate_id": "agent-user-1",
        }
    ]
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Implementation evidence and focused test output support the requested behavior.",
  "evidence_citations": ["linear.issue.MT-1", "pytest"],
  "residual_findings": [],
  "recommended_next_action": "Move the original issue to Done."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        CompletingRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert acceptance_runner.calls == []
    assert tracker.created_issues == []
    assert tracker.transitions == []
    assert "mt-1" not in orchestrator.state.completed
    assert "mt-1" not in orchestrator.state.claimed

async def test_acceptance_enabled_does_not_enter_review_without_implementation_evidence(
    tmp_path: Path,
) -> None:
    description = (
        "Business issue for Performer gate tree smoke.\n\n"
        "Implement a tiny validation artifact named PERFORMER_GATE_TREE_SMOKE.md containing this issue identifier.\n"
        "Run: pytest tests/test_acceptance.py -q\n"
        "Final evidence must include Implementation summary, Test commands and exact output, and Remaining risks."
    )
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress", description=description)])
    tracker.refreshed = [issue("MT-1", state="In Progress", description=description)]
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
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, CompletingRunner())

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert ("mt-1", "In Review") not in tracker.transitions
    assert "mt-1" in orchestrator.state.retry_attempts
    assert orchestrator.state.retry_attempts["mt-1"].error is not None
    assert "implementation_evidence_missing" in str(orchestrator.state.retry_attempts["mt-1"].error)

async def test_acceptance_todo_preflight_creates_marker_plan_and_moves_to_in_progress(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    runner = FakeRunner()
    planner = FakeGatePlanner(
        {
            "gates": [
                {
                    "title": "Behavior",
                    "purpose": "Verify the user-visible behavior only.",
                    "acceptance_criteria": ["The feature works for the requested case."],
                    "required_evidence": ["Focused test output for the requested case."],
                },
                {
                    "title": "Regression Coverage",
                    "purpose": "Verify regression tests only.",
                    "acceptance_criteria": ["A targeted regression test exists."],
                    "required_evidence": ["Exact pytest output."],
                },
            ]
        }
    )
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, runner, gate_planner=planner)

    await orchestrator.tick()

    assert runner.started == []
    assert len(tracker.created_issues) == 2
    assert [created["parent_id"] for created in tracker.created_issues] == ["mt-1", "mt-1"]
    assert [created["delegate_id"] for created in tracker.created_issues] == ["agent-user-1", "agent-user-1"]
    assert [created["label_ids"] for created in tracker.created_issues] == [
        ["performer:type/gate"],
        ["performer:type/gate"],
    ]
    assert tracker.created_relations == []
    assert tracker.transitions == []
    assert not any(label == "performer:type/task" for _, label in tracker.lifecycle_labels)
    assert not any(label == "performer:phase/queued" for _, label in tracker.lifecycle_labels)
    assert tracker.description_updates
    _, marker, block = tracker.description_updates[0]
    assert marker == "PERFORMER ACCEPTANCE"
    assert "gate_count: 2" in block
    assert "plan_revision: 1" in block
    assert "Gate plan:" in block
    assert "Evidence required:" in block
    assert planner.calls

async def test_acceptance_children_use_required_delegate_when_parent_has_no_delegate(tmp_path: Path) -> None:
    description = _implementation_evidence()
    tracker = FakeTracker()
    parent = issue("MT-1", state="In Review", description=description, delegate_id=None)
    tracker.refreshed = [parent]
    tracker.children[parent.id] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1",
            "description": "Check it",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "delegate_id": None,
        }
    ]
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Implementation evidence and focused test output support the requested behavior.",
  "evidence_citations": ["linear.issue.MT-1", "pytest"],
  "residual_findings": [],
  "recommended_next_action": "Move the original issue to Done."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_required_delegate(tmp_path, "agent-user-1"),
        tracker,
        CompletingRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator._run_acceptance_gate_for_issue(parent, completion_verdict=None)

    evidence = tracker.children["gate-1"][0]
    assert evidence["delegate_id"] == "agent-user-1"

async def test_phase_advance_maps_acceptance_preflight_codex_init_failure_to_init_failed(tmp_path: Path) -> None:
    class InitFailingGatePlanner:
        async def plan_gates(self, **kwargs: Any) -> str:
            raise CodexError("codex_init_failed", "sdk_transport_error: upstream unavailable")

    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    tracker.refreshed = [issue("MT-1", delegate_id="agent-user-1")]
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        FakeRunner(),
        gate_planner=InitFailingGatePlanner(),
    )

    result = await orchestrator.advance(
        PhaseAdvanceRequest(
            run_id="run-1",
            instance_id="inst-1",
            issue_id="mt-1",
            issue_identifier="MT-1",
            current_phase=RunPhase.QUEUED,
            attempt=1,
        )
    )

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "init_failed"
    assert result.reason == "codex_init_failed"

async def test_acceptance_todo_preflight_reuses_existing_gate_children(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    tracker.children["mt-1"] = [
        {
            "id": "gate-1",
            "identifier": "MT-G1",
            "title": "[Gate] MT-1: Existing",
            "label_ids": ["performer:type/gate"],
            "labels": ["performer:type/gate"],
            "state": "Todo",
            "delegate_id": "agent-user-1",
        }
    ]
    planner = FakeGatePlanner({"gates": []})
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, FakeRunner(), gate_planner=planner)

    await orchestrator.tick()
    await orchestrator.tick()

    assert tracker.created_issues == []
    assert tracker.created_relations == []
    assert tracker.transitions == []
    assert planner.calls == []

async def test_reconcile_terminal_running_issue_cancels_when_acceptance_enabled(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress")])
    tracker.refreshed = [issue("MT-1", state="Done")]
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()
    await orchestrator.reconcile_running()

    assert "mt-1" not in orchestrator.state.running
    assert "mt-1" not in orchestrator.state.claimed
    assert tracker.created_issues == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

    await orchestrator.wait_for_idle()

    assert tracker.created_issues == []
    assert tracker.created_relations == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

async def test_acceptance_score_4_marks_original_done_after_gate_passes(tmp_path: Path) -> None:
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
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 4,
  "result": "pass",
  "score_reason": "Workspace evidence, focused validation command, ops turn, and Linear completion all support the implementation.",
  "evidence_citations": ["workspace.status", "ops.events", "linear.issue.MT-1"],
  "residual_findings": [],
  "recommended_next_action": "Move the original issue to Done."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance_handoff(tmp_path),
        tracker,
        CompletingRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    assert acceptance_runner.calls
    assert "mt-1" in orchestrator.state.completed
    evidence = tracker.children["gate-1"][0]
    assert evidence["label_ids"] == ["performer:type/evidence"]
    assert tracker.transitions == [(evidence["id"], "Done"), ("gate-1", "Done")]
    assert ("gate-1", "performer:gate/passed") in tracker.lifecycle_labels
    assert ("gate-1", "performer:score/4/4") in tracker.lifecycle_labels
    assert tracker.comments[-1][0] == "gate-1"
    assert "Acceptance score: 4" in tracker.comments[-1][1]
    snapshot = OpsStore(ops_snapshot_path_from_persistence_path(orchestrator.config.persistence.path)).load()
    handoff_events = [event for event in snapshot.events if event.event_type == "repository_handoff_report.v1"]
    assert len(handoff_events) == 1
    assert handoff_events[0].issue_id == "mt-1"

async def test_acceptance_rejected_keeps_original_blocked_with_failed_gate(tmp_path: Path) -> None:
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
    acceptance_runner = FakeAcceptanceRunner(
        """
{
  "score": 2,
  "result": "fail",
  "score_reason": "The claimed test evidence does not demonstrate the requested Linear workflow or acceptance issue creation.",
  "evidence_citations": ["workspace.status"],
  "residual_findings": ["No acceptance issue linkage was verified."],
  "recommended_next_action": "Return the original issue for implementation fixes."
}
"""
    )
    orchestrator = Orchestrator(
        make_config_with_acceptance(tmp_path),
        tracker,
        CompletingRunner(),
        acceptance_runner=acceptance_runner,
    )

    await orchestrator.tick()

    assert "mt-1" not in orchestrator.state.completed
    assert tracker.transitions == []
    assert ("gate-1", "performer:gate/failed") in tracker.lifecycle_labels
    assert ("gate-1", "performer:score/2/4") in tracker.lifecycle_labels
    assert tracker.children["gate-1"][0]["label_ids"] == ["performer:type/evidence"]
    assert tracker.comments[-1][0] == "gate-1"
    assert "Gate rejection reasons:" in tracker.comments[-1][1]
    assert "score_below_minimum" in tracker.comments[-1][1]
