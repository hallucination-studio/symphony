from __future__ import annotations

import asyncio
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
from performer_api.persistence import CodexThreadEntry, PersistenceStore, ops_snapshot_path_from_persistence_path








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
    max_verification_retries: int = 1,
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
            max_verification_retries=max_verification_retries,
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


__all__ = [name for name in globals() if not name.startswith("__")]
