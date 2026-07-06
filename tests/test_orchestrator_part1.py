from test_orchestrator_support import *  # noqa: F401,F403

def test_retry_delay_seconds_rounds_up_with_phase_buffer() -> None:
    class Entry:
        due_at = utc_now() + timedelta(seconds=2)

    assert _retry_delay_seconds(Entry()) >= 5

def test_human_intervention_description_preserves_raw_error_and_http_status() -> None:
    issue_obj = issue("MT-1")

    description = _human_intervention_description(
        issue_obj,
        kind="runtime_error",
        error="upstream 502: server overloaded raw body",
        questions=[],
        last_message=None,
        http_status=502,
    )

    assert "Upstream HTTP status: 502" in description
    assert "Last error:\nupstream 502: server overloaded raw body" in description

def test_human_intervention_description_redacts_secret_like_raw_error() -> None:
    issue_obj = issue("MT-1")
    secret = "sk-test-secret-123456"

    description = _human_intervention_description(
        issue_obj,
        kind="runtime_error",
        error=f"upstream failed Authorization: Bearer {secret}",
        questions=[],
        last_message=None,
        http_status=502,
    )

    assert secret not in description
    assert "Bearer [REDACTED]" in description

async def test_phase_advance_dispatches_implementation_for_queued(tmp_path: Path) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    runner = CompletingPhaseRunner()
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.QUEUED))

    assert [started.identifier for started, _ in runner.started] == ["MT-1"]
    assert result.run_id == "run-1"
    assert result.issue_id == "mt-1"
    assert result.next_phase == RunPhase.REVIEWING
    assert result.status == "reviewing"
    assert "thread_id" not in result.to_dict()

async def test_phase_advance_maps_worker_upstream_overload_to_phase_result(tmp_path: Path) -> None:
    class OverloadedRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            on_event({"event": "session_started", "session_id": "thread-1-turn-1", "cwd": f"/tmp/{issue.identifier}"})
            raise CodexError(
                "upstream_overloaded_exhausted",
                "JSON-RPC error -32000: upstream 502: server overloaded raw body",
                http_status=502,
            )

    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        OverloadedRunner(),
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.QUEUED))

    assert result.next_phase is RunPhase.QUEUED
    assert result.status == "upstream_overloaded"
    assert result.reason == "upstream_overloaded_exhausted"
    assert result.detail == "JSON-RPC error -32000: upstream 502: server overloaded raw body"
    assert result.http_status == 502
    assert orchestrator.state.human_interventions == {}

async def test_phase_advance_returns_inline_outcome_without_waiting_or_state_probe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    runner = CompletingPhaseRunner()
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
    )

    async def fail_wait_for_idle() -> None:
        raise AssertionError("phase advance must execute inline, not through wait_for_idle")

    monkeypatch.setattr(orchestrator, "wait_for_idle", fail_wait_for_idle)

    result = await orchestrator.advance(phase_request(phase=RunPhase.QUEUED))

    assert not hasattr(orchestrator, "_phase_result_from_runtime_state")
    assert not hasattr(orchestrator, "_phase_outcomes")
    assert not hasattr(orchestrator, "_record_phase_outcome")
    assert not hasattr(orchestrator, "_pop_phase_outcome")
    assert not hasattr(orchestrator, "_run_worker_for_phase")
    assert hasattr(orchestrator, "phase_runtime")
    assert [(started.identifier, attempt) for started, attempt in runner.started] == [("MT-1", 1)]
    assert result.next_phase == RunPhase.REVIEWING
    assert result.status == "reviewing"
    assert orchestrator.state.running == {}

async def test_phase_advance_workspace_path_uses_root_when_per_issue_disabled(tmp_path: Path) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    runner = CompletingPhaseRunner()
    config = replace(make_config(tmp_path), workspace=WorkspaceConfig(root=tmp_path / "workspace", per_issue=False))
    orchestrator = Orchestrator(config, tracker, runner)

    result = await orchestrator.advance(
        phase_request(
            phase=RunPhase.QUEUED,
            issue_identifier="MT-1",
        )
    )

    assert result.workspace_path == str(tmp_path / "workspace")

async def test_phase_advance_processes_due_retry_before_claim_check(tmp_path: Path) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    tracker.candidates = tracker.refreshed
    runner = CompletingPhaseRunner()
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
    )
    orchestrator.state.claimed.add("mt-1")
    orchestrator.state.retry_attempts["mt-1"] = RetryEntry(
        issue_id="mt-1",
        identifier="MT-1",
        attempt=2,
        due_at=utc_now() - timedelta(seconds=1),
        due_at_ms=0,
        error="verification_failed",
        issue_url="https://linear.test/MT-1",
        phase="retry_pending",
        status_label="performer:phase/implementation",
        runtime_phase="failed",
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.QUEUED, attempt=2))

    assert [(started.identifier, attempt) for started, attempt in runner.started] == [("MT-1", 2)]
    assert result.next_phase == RunPhase.REVIEWING

async def test_phase_advance_dispatches_gate_for_reviewing_without_implementation(tmp_path: Path) -> None:
    description = _implementation_evidence()
    parent = issue("MT-1", state="In Review", description=description)
    tracker = FakeTracker()
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
        }
    ]
    runner = CompletingPhaseRunner()
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
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
        acceptance_runner=acceptance_runner,
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.REVIEWING))

    assert runner.started == []
    assert len(acceptance_runner.calls) == 1
    assert result.next_phase == RunPhase.DONE
    assert result.status == "completed"
    assert "thread_id" not in result.to_dict()

async def test_phase_advance_dispatches_rework_as_implementation(tmp_path: Path) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", state="In Progress", description=_implementation_evidence())]
    runner = CompletingPhaseRunner()
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.REWORKING, attempt=2))

    assert [(started.identifier, attempt) for started, attempt in runner.started] == [("MT-1", 2)]
    assert result.next_phase == RunPhase.REVIEWING
    assert result.status == "reviewing"
    assert "thread_id" not in result.to_dict()

async def test_tick_dispatches_candidate_issues_from_tracker(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-1" in orchestrator.state.running

async def test_preflight_needs_more_info_creates_human_action_child_and_does_not_dispatch(tmp_path: Path) -> None:
    tracker = FakeTracker()
    tracker.refreshed = [issue("MT-1", assignee_id="human-1", delegate_id="agent-user-1")]
    runner = FakeRunner()
    planner = FakeGatePlanner(
        {
            "needs_more_info": True,
            "questions": ["Which repository should be changed?"],
        }
    )
    orchestrator = Orchestrator(
        replace(
            make_config_with_required_delegate(tmp_path, "agent-user-1"),
            acceptance=AcceptanceConfig(enabled=True),
        ),
        tracker,
        runner,
        gate_planner=planner,
    )

    result = await orchestrator.advance(phase_request(phase=RunPhase.QUEUED))

    assert result.next_phase == RunPhase.AWAITING_HUMAN
    assert result.status == "awaiting_human"
    assert runner.started == []
    intervention = orchestrator.state.human_interventions["mt-1"]
    assert intervention.kind == "preflight_needs_input"
    child = tracker.created_issues[-1]
    assert child["parent_id"] == "mt-1"
    assert child["assignee_id"] == "human-1"
    assert child["title"] == "[Human Action] MT-1: Need more information"
    assert "Which repository should be changed?" in child["description"]
    assert "performer:type/human-action" in child["label_ids"]
    assert "performer:human/needs-input" not in child["label_ids"]

async def test_done_human_action_child_without_required_response_does_not_resume(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    planner = FakeGatePlanner(
        {
            "needs_more_info": True,
            "questions": ["Which repository should be changed?"],
        }
    )
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
        gate_planner=planner,
    )

    await orchestrator.tick()
    child = tracker.created_issues[-1]
    child["state"] = "Done"

    await orchestrator.tick()

    assert "mt-1" in orchestrator.state.human_interventions
    assert runner.started == []
    assert tracker.comments[-1][0] == child["id"]
    assert "Human response" in tracker.comments[-1][1]

async def test_done_human_action_child_with_response_releases_preflight(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    planner = FakeGatePlanner(
        {
            "needs_more_info": True,
            "questions": ["Which repository should be changed?"],
        }
    )
    orchestrator = Orchestrator(
        replace(make_config(tmp_path), acceptance=AcceptanceConfig(enabled=True)),
        tracker,
        runner,
        gate_planner=planner,
    )

    await orchestrator.tick()
    child = tracker.created_issues[-1]
    child["state"] = "Done"
    child["description"] = "Human response:\nUse packages/performer.\n\nWhen finished, move this child issue to Done."

    await orchestrator.process_human_interventions()

    assert "mt-1" not in orchestrator.state.human_interventions
    assert "mt-1" not in orchestrator.state.claimed
    assert tracker.description_updates[-1][0] == "mt-1"
    assert tracker.description_updates[-1][1] == "SYMPHONY HUMAN RESPONSE"
    assert "Use packages/performer." in tracker.description_updates[-1][2]

async def test_dispatch_and_codex_events_update_lifecycle_labels_and_phase(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", labels=["codex2"])])
    runner = FakeRunner()
    config = make_config(tmp_path)
    orchestrator = Orchestrator(config, tracker, runner)

    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "process_launch",
            "cwd": str(tmp_path / "workspaces" / "MT-1"),
            "command": ["bash", "-lc", "codex app-server"],
        },
    )
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "turn_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    await asyncio_sleep()

    entry = orchestrator.state.running["mt-1"]
    assert entry.phase == "running"
    assert entry.runtime_phase == "implementation_running"
    assert entry.status_label == "performer:phase/implementation"
    assert ("mt-1", "performer:phase/implementation") not in tracker.lifecycle_labels
    assert entry.recent_events[-1]["event"] == "turn_started"
    assert entry.recent_events[-1]["raw_event"]["session_id"] == "thread-1-turn-1"
    assert entry.workspace_path == str(tmp_path / "workspaces" / "MT-1")

async def test_retry_failure_marks_retry_pending_label(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    task = asyncio_event()
    entry_issue = issue("MT-1")
    orchestrator.state.running["mt-1"] = RunningEntry(
        issue=entry_issue,
        task=task,
        started_at=utc_now(),
        retry_attempt=0,
    )
    orchestrator.state.claimed.add("mt-1")

    await orchestrator._finish_worker("mt-1", normal=False, error="proxy timeout")
    await asyncio_sleep()

    intervention = orchestrator.state.human_interventions["mt-1"]
    assert intervention.kind == "runtime_error"
    assert intervention.error == "worker exited: proxy timeout"
    assert ("mt-1", "performer:phase/blocked") not in tracker.lifecycle_labels

async def test_non_retryable_failure_marks_failed_phase_label(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    config = replace(make_config(tmp_path), completion_verification=CompletionVerificationConfig(auto_retry_on_fail=False))
    orchestrator = Orchestrator(config, tracker, runner)
    verdict = type("Verdict", (), {"status": "NEEDS_RETRY", "reason": "terminal verification failure"})()
    orchestrator.completion_verifier = type(
        "Verifier",
        (),
        {"verify_completion": lambda _self, *_args: async_value(verdict)},
    )()
    tracker.refreshed = [issue("MT-1")]
    entry_issue = issue("MT-1")
    orchestrator.state.running["mt-1"] = RunningEntry(
        issue=entry_issue,
        task=asyncio_event(),
        started_at=utc_now(),
        retry_attempt=0,
    )
    orchestrator.state.claimed.add("mt-1")

    await orchestrator._finish_worker("mt-1", normal=True, error=None)
    await asyncio_sleep()

    assert "mt-1" not in orchestrator.state.retry_attempts
    assert ("mt-1", "performer:phase/failed") not in tracker.lifecycle_labels

async def test_human_blocked_runtime_error_marks_human_blocked_label(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    entry_issue = issue("MT-1")
    orchestrator.state.running["mt-1"] = RunningEntry(
        issue=entry_issue,
        task=asyncio_event(),
        started_at=utc_now(),
        retry_attempt=0,
        human_blocked_reason="permission denied",
    )
    orchestrator.state.claimed.add("mt-1")

    await orchestrator._finish_worker("mt-1", normal=False, error="cancelled")
    await asyncio_sleep()

    assert orchestrator.state.human_interventions["mt-1"].kind == "runtime_permission"
    assert orchestrator.state.human_interventions["mt-1"].error == "permission denied"
    assert ("mt-1", "performer:phase/blocked") not in tracker.lifecycle_labels

async def test_lifecycle_label_failures_do_not_block_dispatch(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.fail_lifecycle_label = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "performer_label_group outcome=failed" not in caplog.text
    assert "label=performer:phase/implementation" not in caplog.text

async def test_wait_for_idle_drains_background_label_tasks(tmp_path: Path) -> None:
    class ImmediateRunner:
        async def run_issue(
            self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
        ) -> None:
            return None

    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = ImmediateRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()
    await orchestrator.wait_for_idle()

    assert orchestrator._background_label_tasks == set()
    assert ("mt-1", "performer:phase/implementation") not in tracker.lifecycle_labels

async def test_background_label_updates_are_serialized_per_issue(tmp_path: Path) -> None:
    class SlowLabelTracker(FakeTracker):
        async def set_issue_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> dict[str, Any]:
            if label_name.endswith("first"):
                await asyncio.sleep(0.02)
            return await super().set_issue_label_group(issue_id, label_name, prefix=prefix)

    tracker = SlowLabelTracker()
    tracker.created_issues.append({"id": "mt-1", "label_ids": []})
    orchestrator = Orchestrator(make_config(tmp_path), tracker, FakeRunner())

    orchestrator._sync_label_group_background("mt-1", "performer:gate/first", prefix="performer:gate/")
    orchestrator._sync_label_group_background("mt-1", "performer:gate/second", prefix="performer:gate/")

    await orchestrator.wait_for_idle()

    assert tracker.lifecycle_labels == [
        ("mt-1", "performer:gate/first"),
        ("mt-1", "performer:gate/second"),
    ]
    assert tracker.created_issues[0]["label_ids"] == ["performer:gate/second"]

async def test_lifecycle_labels_can_be_disabled_for_managed_custom_agent_dispatch(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    base_config = make_config(tmp_path)
    config = replace(base_config, tracker=replace(base_config.tracker, lifecycle_labels_enabled=False))
    orchestrator = Orchestrator(config, tracker, runner)

    await orchestrator.tick()
    orchestrator.on_codex_event(
        "mt-1",
        {
            "event": "turn_started",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "session_id": "thread-1-turn-1",
        },
    )
    await asyncio_sleep()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert tracker.lifecycle_labels == []
    assert orchestrator.state.running["mt-1"].status_label == "performer:phase/implementation"

async def test_tick_logs_candidate_summary_and_skip_reasons(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.INFO)
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2", project_slug="OTHER")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert "performer_dispatch_scan candidate_count=2 available_slots=10" in caplog.text
    assert "performer_dispatch_candidate outcome=dispatch issue_id=mt-1 issue_identifier=MT-1 worker_host=local" in caplog.text
    assert "performer_dispatch_candidate outcome=skip issue_id=mt-2 issue_identifier=MT-2 reason=project_mismatch" in caplog.text
    assert "performer_dispatch_summary dispatched=1 skipped=1 running=1 claimed=1" in caplog.text

async def test_candidate_fetch_failure_logs_and_skips_dispatch(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    tracker.fail_candidates = True
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}
    assert "performer_dispatch failed" in caplog.text
    assert "reason=candidate unavailable" in caplog.text

async def test_tick_rejects_non_sdk_codex_backend(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    caplog.set_level(logging.WARNING)
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_codex_backend(tmp_path, "app_server"), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert "performer_dispatch_validation failed" in caplog.text
    assert "invalid_codex_backend" in caplog.text

async def test_tick_rejects_candidate_from_different_project(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", project_slug="OTHER")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}

async def test_tick_allows_non_linear_tracker_issue_without_project_slug(tmp_path: Path) -> None:
    from performer.tracker import register_tracker_adapter

    class CustomTracker:
        def __init__(self, config):
            self.config = config

    register_tracker_adapter("custom", CustomTracker)
    tracker = FakeTracker(candidates=[issue("EXT-1", project_slug=None)])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_custom_tracker_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["EXT-1"]

async def test_tick_ignores_linear_assignee_for_custom_agent_delegate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", assignee_id="other-user")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]

async def test_acceptance_preflight_requires_linear_agent_delegate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id=None)])
    runner = FakeRunner()
    orchestrator = Orchestrator(
        replace(
            make_config_with_required_delegate(tmp_path, "agent-user-1"),
            acceptance=AcceptanceConfig(enabled=True),
        ),
        tracker,
        runner,
    )

    await orchestrator.tick()

    assert tracker.created_issues == []
    assert runner.started == []

async def test_tick_respects_global_concurrency_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path, max_concurrent=1), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert len(orchestrator.state.running) == 1

async def test_tick_assigns_ssh_worker_hosts_and_respects_per_host_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2"), issue("MT-3")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1", "builder-2"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1", "MT-2"]
    assert orchestrator.state.running["mt-1"].worker_host == "builder-1"
    assert orchestrator.state.running["mt-2"].worker_host == "builder-2"
    assert "mt-3" not in orchestrator.state.running

async def test_tick_waits_when_all_ssh_hosts_are_saturated(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-2" not in orchestrator.state.running
    assert "mt-2" not in orchestrator.state.claimed
