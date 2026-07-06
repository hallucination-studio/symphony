from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from performer_api.config import (
    AgentConfig,
    CompletionVerificationConfig,
    AcceptanceConfig,
    CodexConfig,
    HooksConfig,
    PersistenceConfig,
    PollingConfig,
    RepositoryHandoffConfig,
    ServiceConfig,
    TrackerConfig,
    WorkerConfig,
    WorkspaceConfig,
)
from performer_api.models import BlockerRef, HumanInterventionEntry, Issue, RetryEntry, RunningEntry, utc_now
from performer_api.phase import PhaseAdvanceRequest, RunPhase
from performer.codex_client import CodexError
from performer.orchestrator import Orchestrator, _human_intervention_description, _retry_delay_seconds
from performer.ops_telemetry import ExecutionTelemetryRecorder
from performer_api.ops_store import OpsStore
from performer_api.persistence import PersistenceStore, ops_snapshot_path_from_persistence_path


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


class FakeTracker:
    def __init__(self, candidates: list[Issue] | None = None):
        self.candidates = candidates or []
        self.refreshed: list[Issue] = []
        self.by_states: list[Issue] = []
        self.comments: list[tuple[str, str]] = []
        self.lifecycle_labels: list[tuple[str, str]] = []
        self.created_issues: list[dict[str, Any]] = []
        self.created_relations: list[dict[str, Any]] = []
        self.children: dict[str, list[dict[str, Any]]] = {}
        self.transitions: list[tuple[str, str]] = []
        self.description_updates: list[tuple[str, str, str]] = []
        self.issue_comments: dict[str, list[dict[str, Any]]] = {}
        self.existing_acceptance_issue: dict[str, Any] | None = None
        self.fail_candidates = False
        self.fail_by_states = False
        self.fail_refresh = False
        self.fail_comment = False
        self.fail_lifecycle_label = False

    async def fetch_candidate_issues(self) -> list[Issue]:
        if self.fail_candidates:
            raise RuntimeError("candidate unavailable")
        return self.candidates

    async def fetch_issue_states_by_ids(self, issue_ids: list[str]) -> list[Issue]:
        if self.fail_refresh:
            raise RuntimeError("refresh unavailable")
        return [issue for issue in self.refreshed if issue.id in issue_ids]

    async def fetch_issues_by_states(self, state_names: list[str]) -> list[Issue]:
        if self.fail_by_states:
            raise RuntimeError("linear unavailable")
        return [issue for issue in self.by_states if issue.state in state_names]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, Any]:
        if self.fail_comment:
            raise RuntimeError("comment unavailable")
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def fetch_issue_comments(self, issue_id: str, *, first: int = 20) -> list[dict[str, Any]]:
        return list(self.issue_comments.get(issue_id, []))[:first]

    async def set_issue_lifecycle_label(self, issue_id: str, label_name: str) -> dict[str, Any]:
        if self.fail_lifecycle_label:
            raise RuntimeError("label unavailable")
        self.lifecycle_labels.append((issue_id, label_name))
        self._record_label(issue_id, label_name, prefix=None)
        return {"success": True, "issue_id": issue_id, "label": label_name}

    async def set_issue_label_group(self, issue_id: str, label_name: str, *, prefix: str) -> dict[str, Any]:
        if self.fail_lifecycle_label:
            raise RuntimeError("label unavailable")
        self.lifecycle_labels.append((issue_id, label_name))
        self._record_label(issue_id, label_name, prefix=prefix)
        return {"success": True, "issue_id": issue_id, "label": label_name, "prefix": prefix}

    def _record_label(self, issue_id: str, label_name: str, *, prefix: str | None) -> None:
        for created in self.created_issues:
            if created.get("id") != issue_id:
                continue
            labels = list(created.get("label_ids") or created.get("labels") or [])
            if prefix:
                labels = [label for label in labels if not str(label).startswith(prefix)]
            if label_name not in labels:
                labels.append(label_name)
            created["label_ids"] = labels
            created["labels"] = labels

    async def create_issue(
        self,
        *,
        team_id: str,
        project_id: str,
        state_id: str,
        label_ids: list[str],
        title: str,
        description: str,
        parent_id: str | None = None,
        assignee_id: str | None = None,
        delegate_id: str | None = None,
    ) -> dict[str, Any]:
        created = {
            "id": f"issue-{len(self.created_issues) + 1}",
            "identifier": f"MT-A{len(self.created_issues) + 1}",
            "team_id": team_id,
            "project_id": project_id,
            "state_id": state_id,
            "label_ids": label_ids,
            "title": title,
            "description": description,
            "parent_id": parent_id,
            "assignee_id": assignee_id,
            "delegate_id": delegate_id,
            "url": f"https://linear.app/x/issue/MT-A{len(self.created_issues) + 1}",
        }
        self.created_issues.append(created)
        if parent_id:
            self.children.setdefault(parent_id, []).append(created)
        return created

    async def create_acceptance_issue_for(
        self,
        *,
        original_issue_id: str,
        title: str,
        description: str,
        acceptance_label_name: str,
    ) -> dict[str, Any]:
        created = await self.create_issue(
            team_id="team-1",
            project_id="project-1",
            state_id="state-todo",
            label_ids=[acceptance_label_name],
            title=title,
            description=description,
        )
        created["original_issue_id"] = original_issue_id
        return created

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
        assignee_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.create_issue(
            team_id="team-1",
            project_id="project-1",
            state_id="state-todo",
            label_ids=label_names,
            title=title,
            description=description,
            parent_id=parent_issue_id,
            assignee_id=assignee_id,
            delegate_id=delegate_id,
        )

    async def fetch_child_issues(
        self,
        parent_issue_id: str,
        *,
        label_name: str | None = None,
    ) -> list[dict[str, Any]]:
        children = list(self.children.get(parent_issue_id, []))
        if label_name is None:
            return children
        return [child for child in children if label_name in child.get("label_ids", []) or label_name in child.get("labels", [])]

    async def find_acceptance_issue_for(
        self,
        *,
        original_issue: Issue,
        acceptance_label_name: str,
    ) -> dict[str, Any] | None:
        if self.existing_acceptance_issue is not None:
            return self.existing_acceptance_issue
        for created in self.created_issues:
            if created.get("original_issue_id") == original_issue.id:
                return created
        return None

    async def create_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        relation = {
            "id": f"relation-{len(self.created_relations) + 1}",
            "issue_id": issue_id,
            "related_issue_id": related_issue_id,
            "type": relation_type,
        }
        self.created_relations.append(relation)
        return relation

    async def ensure_issue_relation(
        self,
        *,
        issue_id: str,
        related_issue_id: str,
        relation_type: str,
    ) -> dict[str, Any]:
        for relation in self.created_relations:
            if (
                relation.get("issue_id") == issue_id
                and relation.get("related_issue_id") == related_issue_id
                and relation.get("type") == relation_type
            ):
                return relation
        return await self.create_issue_relation(
            issue_id=issue_id,
            related_issue_id=related_issue_id,
            relation_type=relation_type,
        )

    async def transition_issue_by_state_name(
        self,
        issue_id: str,
        state_name: str,
    ) -> dict[str, Any]:
        self.transitions.append((issue_id, state_name))
        return {"success": True, "issue_id": issue_id, "state": state_name}

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, Any]:
        self.description_updates.append((issue_id, marker_name, block))
        self.refreshed = [
            replace(
                issue,
                description=f"{issue.description or ''}\n\nImplementation summary:\n{block}",
            )
            if issue.id == issue_id
            else issue
            for issue in self.refreshed
        ]
        return {"success": True, "issue_id": issue_id, "description": block}


class FakeRunner:
    def __init__(self):
        self.started: list[tuple[Issue, int | None]] = []
        self.wait = asyncio_event()

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        self.started.append((issue, attempt))
        await self.wait.wait()


class FakeAcceptanceRunner:
    def __init__(self, report: str) -> None:
        self.report = report
        self.calls: list[dict[str, Any]] = []

    async def run_acceptance(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return self.report


class CompletingPhaseRunner:
    def __init__(self) -> None:
        self.started: list[tuple[Issue, int | None]] = []

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> Any:
        self.started.append((issue, attempt))
        on_event({"event": "session_started", "session_id": "thread-1-turn-1", "cwd": f"/tmp/{issue.identifier}"})
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})

        class Result:
            structured_result = {
                "summary": "implemented",
                "test_commands": ["pytest -q -> passed"],
                "changed_files": ["file.py"],
                "remaining_risks": ["none"],
            }

        return Result()


class FakeGatePlanner:
    def __init__(self, report: str | dict[str, Any]) -> None:
        self.report = report
        self.calls: list[dict[str, Any]] = []

    async def plan_gates(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        if isinstance(self.report, str):
            return self.report
        import json

        return json.dumps(self.report)


def asyncio_event():
    import asyncio

    return asyncio.Event()


async def asyncio_sleep() -> None:
    import asyncio

    await asyncio.sleep(0)


async def async_value(value: Any) -> Any:
    return value


def make_config(tmp_path: Path, *, max_concurrent: int = 10) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="linear",
            endpoint="https://api.linear.app/graphql",
            project_slug="MT",
            api_key="linear-token",
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=max_concurrent, max_retry_backoff_ms=60_000),
        codex=CodexConfig(stall_timeout_ms=300_000),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
        completion_verification=CompletionVerificationConfig(enabled=False),
    )


def make_config_with_completion_verification(
    tmp_path: Path,
    *,
    required_checks: list[str],
    optional_checks: list[str] | None = None,
    auto_retry_on_fail: bool = True,
) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        completion_verification=CompletionVerificationConfig(
            required_checks=required_checks,
            optional_checks=optional_checks or [],
            auto_retry_on_fail=auto_retry_on_fail,
        ),
    )


def make_config_with_acceptance(tmp_path: Path) -> ServiceConfig:
    config = make_config_with_completion_verification(
        tmp_path,
        required_checks=[],
        optional_checks=[],
    )
    return ServiceConfig(
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


def make_config_with_acceptance_handoff(tmp_path: Path) -> ServiceConfig:
    config = make_config_with_acceptance(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        completion_verification=config.completion_verification,
        acceptance=config.acceptance,
        persistence=PersistenceConfig(path=tmp_path / "state" / "performer.json"),
        repository_handoff=RepositoryHandoffConfig(enabled=True),
    )


def make_config_with_required_delegate(tmp_path: Path, delegate_id: str) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=TrackerConfig(
            kind=config.tracker.kind,
            endpoint=config.tracker.endpoint,
            project_slug=config.tracker.project_slug,
            api_key=config.tracker.api_key,
            required_delegate_id=delegate_id,
            active_states=config.tracker.active_states,
            terminal_states=config.tracker.terminal_states,
        ),
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )


def make_config_with_codex_backend(tmp_path: Path, backend: str) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=CodexConfig(backend=backend),
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
    )


def make_config_with_workers(tmp_path: Path, hosts: list[str], per_host: int = 1) -> ServiceConfig:
    config = make_config(tmp_path)
    return ServiceConfig(
        tracker=config.tracker,
        polling=config.polling,
        workspace=config.workspace,
        hooks=config.hooks,
        agent=config.agent,
        codex=config.codex,
        prompt_template=config.prompt_template,
        workflow_path=config.workflow_path,
        worker=WorkerConfig(ssh_hosts=hosts, max_concurrent_agents_per_host=per_host),
    )


def make_custom_tracker_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        tracker=TrackerConfig(
            kind="custom",
            endpoint="https://tracker.example/api",
            project_slug="",
            api_key="",
        ),
        polling=PollingConfig(interval_ms=30_000),
        workspace=WorkspaceConfig(root=tmp_path),
        hooks=HooksConfig(),
        agent=AgentConfig(max_concurrent_agents=10, max_retry_backoff_ms=60_000),
        codex=CodexConfig(stall_timeout_ms=300_000),
        prompt_template="Do {{ issue.identifier }}",
        workflow_path=tmp_path / "WORKFLOW.md",
    )


def issue(identifier: str, **overrides: Any) -> Issue:
    data = {
        "id": identifier.lower(),
        "identifier": identifier,
        "title": "Build",
        "state": "Todo",
        "labels": ["codex"],
        "project_slug": "MT",
    }
    data.update(overrides)
    return Issue(**data)


def _implementation_evidence() -> str:
    return (
        "Implementation summary: created requested behavior.\n"
        "Test commands and exact output: pytest tests/test_target.py -q -> passed.\n"
        "Remaining risks: none."
    )


def phase_request(
    *,
    phase: RunPhase,
    run_id: str = "run-1",
    issue_id: str = "mt-1",
    issue_identifier: str = "MT-1",
    attempt: int = 1,
    human_response: str | None = None,
) -> PhaseAdvanceRequest:
    return PhaseAdvanceRequest(
        run_id=run_id,
        instance_id="instance-1",
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        current_phase=phase,
        attempt=attempt,
        human_response=human_response,
        workspace_context={},
    )


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


class CompletingRunner:
    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        on_event({"event": "session_started", "session_id": "thread-1-turn-1"})
        on_event(
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
            }
        )
        on_event(
            {
                "event": "thread_token_usage_updated",
                "session_id": "thread-1-turn-1",
                "payload": {
                    "total_token_usage": {
                        "input_tokens": 130,
                        "output_tokens": 50,
                        "total_tokens": 180,
                    }
                },
            }
        )
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})


class StructuredCompletingRunner(CompletingRunner):
    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> Any:
        await super().run_issue(issue, attempt, on_event, worker_host=worker_host)

        class Result:
            structured_result = {
                "summary": "created requested artifact",
                "test_commands": ["pytest tests/test_smoke.py -q -> 1 passed"],
                "changed_files": ["SYMPHONY_REAL_E2E_RESULT.md"],
                "remaining_risks": ["none"],
                "next_action": "ready_for_review",
            }

        return Result()


class ControlledCompletingRunner:
    def __init__(self) -> None:
        self.started = asyncio_event()
        self.release = asyncio_event()

    async def run_issue(
        self, issue: Issue, attempt: int | None, on_event: Any, *, worker_host: str | None = None
    ) -> None:
        on_event({"event": "session_started", "session_id": "thread-1-turn-1"})
        on_event(
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
            }
        )
        self.started.set()
        await self.release.wait()
        on_event({"event": "turn_completed", "session_id": "thread-1-turn-1", "turn_id": "turn-1"})


@pytest.mark.asyncio
async def test_tick_dispatches_candidate_issues_from_tracker(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="agent-user-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-1" in orchestrator.state.running


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_tick_rejects_candidate_from_different_project(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", project_slug="OTHER")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert runner.started == []
    assert orchestrator.state.running == {}


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_tick_ignores_linear_assignee_for_custom_agent_delegate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", assignee_id="other-user")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_tick_respects_global_concurrency_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path, max_concurrent=1), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert len(orchestrator.state.running) == 1


@pytest.mark.asyncio
async def test_tick_assigns_ssh_worker_hosts_and_respects_per_host_limit(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2"), issue("MT-3")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1", "builder-2"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1", "MT-2"]
    assert orchestrator.state.running["mt-1"].worker_host == "builder-1"
    assert orchestrator.state.running["mt-2"].worker_host == "builder-2"
    assert "mt-3" not in orchestrator.state.running


@pytest.mark.asyncio
async def test_tick_waits_when_all_ssh_hosts_are_saturated(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1"), issue("MT-2")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_workers(tmp_path, ["builder-1"]), tracker, runner)

    await orchestrator.tick()

    assert [started[0].identifier for started in runner.started] == ["MT-1"]
    assert "mt-2" not in orchestrator.state.running
    assert "mt-2" not in orchestrator.state.claimed


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_retrying_issue_is_not_dispatched_by_normal_candidate_scan(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)

    await orchestrator.tick()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_future_monotonic_retry_is_not_dispatched_when_wall_clock_due_at_is_past(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=60_000)
    orchestrator.state.retry_attempts["mt-1"].due_at = utc_now() - timedelta(seconds=60)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" in orchestrator.state.retry_attempts


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_reconcile_terminal_running_issue_waits_for_worker_when_acceptance_enabled(
    tmp_path: Path,
) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", state="In Progress")])
    tracker.refreshed = [issue("MT-1", state="Done")]
    runner = ControlledCompletingRunner()
    orchestrator = Orchestrator(make_config_with_acceptance(tmp_path), tracker, runner)

    await orchestrator.tick()
    await runner.started.wait()
    await orchestrator.reconcile_running()

    assert "mt-1" in orchestrator.state.running
    assert "mt-1" in orchestrator.state.claimed
    assert tracker.created_issues == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels

    runner.release.set()
    await orchestrator.wait_for_idle()

    assert tracker.created_issues == []
    assert tracker.created_relations == []
    assert ("mt-1", "performer:phase/done") not in tracker.lifecycle_labels


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_active_state_refresh_updates_running_entry_state(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    await orchestrator.tick()
    tracker.refreshed = [issue("MT-1", state="In Progress")]

    await orchestrator.reconcile_running()

    assert orchestrator.state.running["mt-1"].issue.state == "In Progress"


@pytest.mark.asyncio
async def test_reconcile_with_no_running_issues_is_noop(tmp_path: Path) -> None:
    tracker = FakeTracker()
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)

    await orchestrator.reconcile_running()

    assert orchestrator.state.running == {}


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_due_retry_dispatches_when_issue_is_still_candidate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config(tmp_path), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == [(tracker.candidates[0], 2)]
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" in orchestrator.state.claimed


@pytest.mark.asyncio
async def test_due_retry_releases_claim_when_issue_loses_required_delegate(tmp_path: Path) -> None:
    tracker = FakeTracker(candidates=[issue("MT-1", delegate_id="other-agent")])
    runner = FakeRunner()
    orchestrator = Orchestrator(make_config_with_required_delegate(tmp_path, "agent-user-1"), tracker, runner)
    orchestrator._schedule_retry(issue("MT-1", delegate_id="agent-user-1"), 2, error="retry", delay_ms=-1)

    await orchestrator.process_due_retries()

    assert runner.started == []
    assert "mt-1" not in orchestrator.state.retry_attempts
    assert "mt-1" not in orchestrator.state.claimed


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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
