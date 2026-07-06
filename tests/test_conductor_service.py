from __future__ import annotations

import asyncio
import json
import inspect
from pathlib import Path
from datetime import datetime, timedelta, timezone
import subprocess
import sys

import httpx
import pytest

from conductor.conductor_models import ConductorSettings, InstanceCreateRequest, InstancePatchRequest, InstanceRecord
from conductor.conductor_linear_direct import ProjectLabelLinearProxy, RepositoryHandoffLinearProxy
from conductor.conductor_runtime import LogQueryResult
from conductor.conductor_service import ConductorService, ConductorServiceError, CoordinationResult
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase
from performer_api.models import (
    BlockedEntry,
    ContinuationEntry,
    HumanInterventionEntry,
    RetryEntry,
    RuntimeTokens,
    utc_now,
)
from performer_api.ops_models import IssueRecord, OpsSnapshot, RetentionMetadata, RunRecord, TraceEvent
from performer_api.ops_store import OpsStore
from performer_api.persistence import PersistenceStore, PersistedSession, PersistedState


def make_service(tmp_path: Path) -> ConductorService:
    store = ConductorStore(tmp_path / "conductor-data")
    return ConductorService(store=store, data_root=tmp_path / "conductor-data")


def test_direct_linear_proxy_classes_are_not_defined_in_conductor_service() -> None:
    import conductor.conductor_service as conductor_service_module

    source = inspect.getsource(conductor_service_module)

    assert "class RepositoryHandoffLinearProxy" not in source
    assert "class ProjectLabelLinearProxy" not in source
    assert RepositoryHandoffLinearProxy.__module__ == "conductor.conductor_linear_direct"
    assert ProjectLabelLinearProxy.__module__ == "conductor.conductor_linear_direct"


def test_conductor_service_constructs_long_lived_collaborators(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    assert service.scheduler is service.scheduler
    assert service.linear_projector is service.linear_projector
    assert service.direct_ingress is service.direct_ingress
    assert service.performer_supervisor is service.performer_supervisor
    assert service.phase_human_actions is service.phase_human_actions
    assert service.orchestration_remediator is service.orchestration_remediator


@pytest.mark.asyncio
async def test_repository_handoff_proxy_returns_dependency_metadata_from_linear_candidates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-2",
                                "identifier": "ENG-2",
                                "title": "Blocked child",
                                "description": "",
                                "url": "https://linear.test/ENG-2",
                                "state": {"name": "Todo", "type": "unstarted"},
                                "parent": {"id": "parent-1", "identifier": "ENG-0"},
                                "delegate": {"id": "app-user-1"},
                                "labels": {"nodes": [{"name": "codex"}]},
                                "inverseRelations": {
                                    "nodes": [
                                        {
                                            "type": "blocks",
                                            "issue": {
                                                "id": "issue-1",
                                                "identifier": "ENG-1",
                                                "state": {"name": "In Progress"},
                                            },
                                        }
                                    ]
                                },
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        )

    proxy = RepositoryHandoffLinearProxy(
        endpoint="https://linear.test/graphql",
        api_key="linear-token",
        project_slug="ENG",
        transport=httpx.MockTransport(handler),
    )

    issues = await proxy.fetch_candidate_issues()

    assert issues[0]["parent_issue_id"] == "parent-1"
    assert issues[0]["blocked_by"] == [
        {"id": "issue-1", "identifier": "ENG-1", "state": "In Progress"}
    ]


def make_repo(tmp_path: Path, name: str = "repo") -> Path:
    repo = tmp_path / name
    repo.mkdir(parents=True)
    (repo / ".git").mkdir()
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    return repo


def make_request(repo: Path, *, name: str = "Alpha", port: int | None = None) -> InstanceCreateRequest:
    return InstanceCreateRequest(
        name=name,
        repo_source_type="local_path",
        repo_source_value=str(repo),
        linear_project="ENG",
        linear_filters={"labels": ["codex"], "active_states": ["Todo", "In Progress"]},
        workflow_profile="default",
        workflow_inputs={"goal": "Handle tasks"},
        http_port=port,
    )


def write_sample_ops_snapshot(instance: InstanceRecord) -> None:
    OpsStore(Path(instance.persistence_path).parent / "ops.json").save(
        OpsSnapshot(
            issues={
                "issue-1": IssueRecord(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    title="Trace UI",
                    state="stalled",
                    total_turn_count=7,
                    total_tokens=188240,
                    total_estimated_cost_usd=0.97,
                    failure_reason="no Codex output arrived for 14 minutes after a tool timeout",
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            runs={
                "run-1": RunRecord(
                    run_id="run-1",
                    issue_id="issue-1",
                    instance_id=instance.id,
                    status="stalled",
                    turn_count=7,
                    attempt_count=2,
                    total_tokens=188240,
                    estimated_cost_usd=0.97,
                    failure_summary="no Codex output arrived for 14 minutes after a tool timeout",
                    last_activity_at="2026-06-30T00:10:00Z",
                )
            },
            events=[
                TraceEvent(
                    event_id="evt-1",
                    event_type="issue_dispatched",
                    timestamp="2026-06-30T00:00:00Z",
                    issue_id="issue-1",
                    run_id="run-1",
                    retention_tier="summary",
                ),
                TraceEvent(
                    event_id="evt-2",
                    event_type="tool_call_failed",
                    timestamp="2026-06-30T00:09:00Z",
                    issue_id="issue-1",
                    run_id="run-1",
                    retention_tier="raw",
                ),
            ],
            retention=RetentionMetadata(),
        )
    )


class CapturingRuntime:
    def __init__(self) -> None:
        self.env: dict[str, str] | None = None
        self.advance_request_path: str | None = None
        self.phase_result_path: str | None = None
        self.phase_issue_id: str | None = None
        self.started_phase_issue_ids: list[str | None] = []
        self.refreshed_instance = None
        self.stop_calls: list[str] = []

    async def start(
        self,
        instance,
        *,
        env: dict[str, str] | None = None,
        advance_request_path: str | None = None,
        phase_result_path: str | None = None,
    ):
        self.env = env
        self.advance_request_path = advance_request_path
        self.phase_result_path = phase_result_path
        self.phase_issue_id = _phase_issue_id_from_request(advance_request_path)
        self.started_phase_issue_ids.append(self.phase_issue_id)
        return instance.with_updates(process_status="running", pid=4242)

    async def stop(self, instance):
        self.stop_calls.append(instance.id)
        return instance.with_updates(process_status="stopped", pid=None)

    async def restart(self, instance, *, env: dict[str, str] | None = None):
        self.env = env
        return instance.with_updates(process_status="running", pid=4242)

    def refresh(self, instance):
        if self.refreshed_instance is not None:
            return self.refreshed_instance
        return instance

    def runtime_snapshot(self, instance):
        return {"instance_id": instance.id, "process_status": instance.process_status}

    def read_logs(self, instance):
        return ""

    def query_logs(self, instance, query=None):
        return LogQueryResult(
            instance_id=instance.id,
            generation=None,
            path=None,
            order=query.order if query is not None else "desc",
            lines=[],
            offset_start=0,
            offset_end=0,
            warnings=[],
        )


def _phase_issue_id_from_request(path: str | None) -> str | None:
    if not path:
        return None
    return str(json.loads(Path(path).read_text(encoding="utf-8")).get("issue_id") or "") or None


class FakeRepositoryHandoffTracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.candidate_issues: list[dict[str, object]] = []
        self.comments: list[tuple[str, str]] = []
        self.updated_descriptions: list[tuple[str, str, str]] = []
        self.phase_projections: list[dict[str, object]] = []
        self.drifted_phase_issues: set[str] = set()

    async def fetch_candidate_issues(self) -> list[dict[str, object]]:
        return list(self.candidate_issues)

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [
            child
            for child in self.children
            if child.get("parent_issue_id") == parent_issue_id
            and (label_name is None or label_name in child.get("labels", []))
        ]

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
    ) -> dict[str, object]:
        issue = {
            "id": f"child-{len(self.children) + 1}",
            "identifier": f"ENG-{len(self.children) + 100}",
            "title": title,
            "description": description,
            "state": "Todo",
            "labels": list(label_names),
            "parent_issue_id": parent_issue_id,
            "delegate_id": delegate_id,
            "url": f"https://linear.test/{len(self.children) + 100}",
        }
        self.children.append(issue)
        return issue

    async def update_issue_description_marker_block(
        self,
        issue_id: str,
        marker_name: str,
        block: str,
    ) -> dict[str, object]:
        self.updated_descriptions.append((issue_id, marker_name, block))
        for child in self.children:
            if child["id"] == issue_id:
                child["description"] = block
        return {"success": True, "issue_id": issue_id, "description": block}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def project_issue_phase(
        self,
        issue_id: str,
        *,
        phase_label: str,
        state_name: str | None,
    ) -> dict[str, object]:
        projection = {"issue_id": issue_id, "phase_label": phase_label, "state_name": state_name}
        self.phase_projections.append(projection)
        self.drifted_phase_issues.discard(issue_id)
        return {"success": True, **projection}

    async def issue_phase_projection_matches(
        self,
        issue_id: str,
        *,
        phase_label: str,
        state_name: str | None,
    ) -> bool:
        if issue_id in self.drifted_phase_issues:
            return False
        return {"issue_id": issue_id, "phase_label": phase_label, "state_name": state_name} in self.phase_projections


class FailingProjectionTracker(FakeRepositoryHandoffTracker):
    def __init__(self) -> None:
        super().__init__()
        self.project_attempts = 0

    async def project_issue_phase(
        self,
        issue_id: str,
        *,
        phase_label: str,
        state_name: str | None,
    ) -> dict[str, object]:
        self.project_attempts += 1
        raise RuntimeError("Linear 502")


class FakeProjectLabelProxy:
    def __init__(self, *, project_id: str | None = "proj-1", existing: list[str] | None = None) -> None:
        self._project_id = project_id
        self.labels: list[str] = list(existing or [])
        self.set_calls: list[list[str]] = []

    async def find_project_id(self, project_slug: str) -> str | None:
        return self._project_id

    async def fetch_project_labels(self, project_id: str) -> list[dict[str, str]]:
        return [{"id": f"id-{name}", "name": name} for name in self.labels]

    async def ensure_project_label_id(self, name: str) -> str:
        return f"id-{name}"

    async def set_project_labels(self, project_id: str, label_ids: list[str]) -> dict[str, object]:
        names = [label_id.removeprefix("id-") for label_id in label_ids]
        self.set_calls.append(names)
        self.labels = names
        return {"success": True, "project_id": project_id, "label_ids": label_ids}


class RecordingConductorLinearTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[dict[str, object]]) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, object]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "json": json.loads(request.content.decode()),
            }
        )
        if not self.responses:
            return httpx.Response(500, json={"errors": [{"message": "unexpected request"}]})
        return httpx.Response(200, json=self.responses.pop(0))


def test_conductor_service_lists_issue_run_trace_and_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    write_sample_ops_snapshot(instance)

    issues = service.list_issues()
    runs = service.list_runs()
    traces = service.list_trace_events(issue_id="issue-1", run_id=None)
    retention = service.retention_status()

    assert issues[0]["issue_identifier"] == "ENG-1"
    assert issues[0]["instance_id"] == instance.id
    assert "no Codex output" in service.get_issue("issue-1")["state_explanation"]
    assert runs[0]["turn_count"] == 7
    assert service.get_run("run-1")["run"]["run_id"] == "run-1"
    assert traces[0]["event_type"] == "issue_dispatched"
    assert retention["pinned_issue_count"] == 0


def test_list_runs_uses_conductor_phase_rows_with_ops_enrichment(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    phase_run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        phase_run.run_id,
        phase=RunPhase.DONE,
        status="completed",
        workspace_path="/tmp/workspace/ENG-1",
        ops_snapshot_path=str(Path(instance.persistence_path).parent / "ops.json"),
        last_reason="completed_by_runtime",
        ack_status="acked",
    )
    write_sample_ops_snapshot(instance)

    runs = service.list_runs()
    detail = service.get_run(phase_run.run_id)

    assert runs == [
        {
            "run_id": phase_run.run_id,
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "instance_id": instance.id,
            "phase": "done",
            "status": "completed",
            "attempt": 1,
            "workflow_profile": "default",
            "dispatch_id": "dispatch-1",
            "workspace_path": "/tmp/workspace/ENG-1",
            "ops_snapshot_path": str(Path(instance.persistence_path).parent / "ops.json"),
            "human_action": {},
            "human_response": None,
            "last_reason": "completed_by_runtime",
            "last_error": None,
            "process_pid": None,
            "ack_status": "acked",
            "retry_count": 0,
            "crash_count": 0,
            "init_failure_count": 0,
            "overload_count": 0,
            "next_run_at": None,
            "turn_count": 7,
            "total_tokens": 188240,
            "estimated_cost_usd": 0.97,
            "last_activity_at": "2026-06-30T00:10:00Z",
        }
    ]
    assert detail["run"]["run_id"] == phase_run.run_id
    assert detail["run"]["phase"] == "done"
    assert detail["run"]["init_failure_count"] == 0
    assert detail["telemetry"]["run"]["run_id"] == "run-1"


def test_list_runs_exposes_human_action_metadata_from_phase_rows(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    phase_run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        phase_run.run_id,
        phase=RunPhase.AWAITING_HUMAN,
        status="waiting",
        human_action={
            "child_issue_id": "child-1",
            "child_identifier": "ENG-2",
            "child_url": "https://linear.test/ENG-2",
            "kind": "runtime_error",
        },
    )

    runs = service.list_runs()

    assert runs[0]["phase"] == "awaiting_human"
    assert runs[0]["human_action"] == {
        "child_issue_id": "child-1",
        "child_identifier": "ENG-2",
        "child_url": "https://linear.test/ENG-2",
        "kind": "runtime_error",
    }


@pytest.mark.asyncio
async def test_coordinate_background_times_out_hung_phase_process_as_retry(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service.runtime_manager = runtime
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    instance = await service._start_direct_phase_issue(
        instance,
        issue_id="issue-1",
        issue_identifier="ENG-1",
    )
    service.store.update_instance(instance)
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    with service.store.connect() as connection:
        connection.execute(
            """
            UPDATE orchestration_events
            SET created_at = CASE event_type
              WHEN 'dispatch.created' THEN '2026-07-04T00:00:00Z'
              WHEN 'performer.started' THEN '2026-07-04T00:00:01Z'
              ELSE created_at
            END
            WHERE run_id = ?
            """,
            (run.run_id,),
        )

    result = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)

    assert result["phase_timeouts"] == 1
    assert result["remediations"]["escalated"] == 0
    assert result["phase_failure_human_actions_created"] == 0
    assert runtime.stop_calls == [instance.id]
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.status == "queued"
    assert updated.retry_count == 1
    assert updated.crash_count == 0
    assert updated.overload_count == 0
    assert updated.init_failure_count == 0
    assert updated.last_reason == "turn_timeout"
    result_event = next(event for event in events if event.event_type == "performer.result")
    assert result_event.payload["status"] == "retry"
    assert result_event.payload["reason"] == "turn_timeout"
    assert "linear.diagnostic_commented" in [event.event_type for event in events]
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase timed out" in tracker.comments[0][1]
    assert "retry_count: 1" in tracker.comments[0][1]
    assert "crash_count: 0" in tracker.comments[0][1]


@pytest.mark.asyncio
async def test_coordinate_background_returns_structured_result_without_legacy_resumed_field(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    result = await service.coordinate_background_once()

    assert isinstance(result, CoordinationResult)
    assert result["phase_runs_started"] == result.phase_runs_started
    assert result["dispatchable"] == 0
    assert result["blocked_waiting"] == 0
    assert "resumed" not in result.to_dict()
    with pytest.raises(KeyError):
        _ = result["resumed"]


@pytest.mark.asyncio
async def test_coordinate_background_reports_dependency_readiness_breakdown(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-ready",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-blocked",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
        blocked_by=["missing-blocker"],
    )

    result = await service.coordinate_background_once()

    assert result["dispatchable"] == 0
    assert result["blocked_waiting"] == 1
    assert result["phase_runs_started"] == 1


@pytest.mark.asyncio
async def test_managed_background_fails_fast_when_proxy_token_missing_for_linear_projection(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(managed_mode=True))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
            reason="implementation_ready_for_review",
        )
    )

    with pytest.raises(ConductorServiceError) as exc:
        await service.coordinate_background_once()

    assert exc.value.code == "managed_podium_proxy_token_required"


@pytest.mark.asyncio
async def test_repository_handoff_closeout_creates_child_once_and_updates_on_rerun(tmp_path: Path) -> None:
    tracker = FakeRepositoryHandoffTracker()
    service = make_service(tmp_path)
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_filters={
                "linear_agent_app_user_id": "app-user-1",
                "integration_agent_mention": "@integration-agent",
            }
        )
    )
    ops_store = OpsStore(Path(instance.persistence_path).parent / "ops.json")
    ops_store.save(
        OpsSnapshot(
            events=[
                TraceEvent(
                    event_id="evt-1",
                    event_type="repository_handoff_report.v1",
                    timestamp="2026-07-03T00:00:00Z",
                    issue_id="issue-1",
                    retention_tier="summary",
                    payload={
                        "issue_id": "issue-1",
                        "issue_identifier": "ENG-1",
                        "workspace_path": instance.workspace_root,
                        "structured_result": {
                            "implementation_summary": "Changed README",
                            "test_commands_and_exact_output": "pytest -q\n1 passed",
                            "remaining_risks": "none",
                        },
                        "git_snapshot": {
                            "is_git_repo": True,
                            "repo_root": instance.workspace_root,
                            "branch": "main",
                            "head_sha": "abc123",
                            "status_porcelain": " M README.md",
                            "diff_stat": "README.md | 2 +",
                            "changed_files": ["README.md"],
                        },
                        "artifact_manifest": [{"path": "changes.patch", "size": 12, "sha256": "abc"}],
                        "bundle": {
                            "type": "local_bundle",
                            "path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1"),
                            "changes_patch_path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1" / "changes.patch"),
                            "manifest_path": str(Path(instance.persistence_path).parent / "handoffs" / "ENG-1" / "manifest.json"),
                        },
                        "recommended_next_action": "create_repository_integration_issue",
                        "generated_at": "2026-07-03T00:00:00Z",
                    },
                )
            ]
        )
    )

    first = await service.coordinate_repository_handoff_closeouts()
    second = await service.coordinate_repository_handoff_closeouts()

    assert first["closed_out"] == 1
    assert second["closed_out"] == 0
    assert len(tracker.children) == 1
    child = tracker.children[0]
    assert child["title"] == "Integrate ENG-1 implementation"
    assert child["delegate_id"] == "app-user-1"
    assert "performer:type/repository-integration" in child["labels"]
    assert "<!-- SYMPHONY REPOSITORY HANDOFF source_issue_id=issue-1 -->" in str(child["description"])
    assert "changes.patch" in str(child["description"])
    assert tracker.comments
    assert "@integration-agent" in tracker.comments[0][1]
    snapshot = ops_store.load()
    closeouts = [event for event in snapshot.events if event.event_type == "repository_handoff_closeout.v1"]
    assert len(closeouts) == 1
    assert closeouts[0].payload["status"] == "completed"
    assert closeouts[0].payload["child_issue_id"] == "child-1"


def test_get_instance_refreshes_exited_runtime_state(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    running = instance.with_updates(process_status="running", pid=4242)
    service.store.update_instance(running)
    runtime.refreshed_instance = running.with_updates(process_status="exited", pid=None, last_exit_code=0)

    refreshed = service.get_instance(instance.id)

    assert refreshed is not None
    assert refreshed.process_status == "exited"
    assert refreshed.pid is None
    assert refreshed.last_exit_code == 0
    assert service.store.get_instance(instance.id).process_status == "exited"


def test_conductor_service_pins_issue_and_collects_retention(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    write_sample_ops_snapshot(instance)

    service.pin_issue("issue-1")
    retention = service.retention_status()
    service.collect_retention()

    assert retention["pinned_issue_count"] == 1
    assert "issue-1" in retention["pinned_issue_ids"]
    snapshot = OpsStore(Path(instance.persistence_path).parent / "ops.json").load()
    assert "issue-1" in snapshot.retention.pinned_issue_ids


def test_create_instance_from_local_path_generates_valid_workflow(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    data_root = repo / ".custom-conductor-data"
    service = ConductorService(store=ConductorStore(data_root), data_root=data_root)
    (repo / "src.txt").write_text("source\n", encoding="utf-8")
    (data_root / "must-not-copy.txt").write_text("no\n", encoding="utf-8")
    for excluded in [".conductor", "conductor-data", ".venv", "workspaces", ".codex-runtime", ".test-real-flow"]:
        (repo / excluded).mkdir()
        (repo / excluded / "excluded.txt").write_text("no\n", encoding="utf-8")

    instance = service.create_instance(make_request(repo))

    assert instance.repo_source_type == "local_path"
    assert instance.resolved_repo_path == str(repo.resolve())
    assert instance.workspace_root == str((Path(instance.instance_dir) / "workspace" / "repo").resolve())
    assert instance.workflow_generation_status == "valid"
    assert Path(instance.workflow_path).exists()
    assert Path(instance.log_path).parent.exists()
    assert (Path(instance.workspace_root) / "src.txt").read_text(encoding="utf-8") == "source\n"
    assert (Path(instance.workspace_root) / ".git").exists()
    for excluded in [".conductor", "conductor-data", ".venv", "workspaces", ".codex-runtime", ".test-real-flow"]:
        assert not (Path(instance.workspace_root) / excluded).exists()
    assert not (Path(instance.workspace_root) / ".custom-conductor-data").exists()
    assert "Handle tasks" in instance.workflow_content


def test_create_instance_uses_configured_podium_proxy_endpoint(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(podium_url="https://podium.internal/"))

    instance = service.create_instance(make_request(repo))

    assert "endpoint: https://podium.internal/api/v1/linear/graphql" in instance.workflow_content
    assert "api_key: $PODIUM_PROXY_TOKEN" in instance.workflow_content


def test_create_instance_uses_podium_proxy_even_without_proxy_token_configured(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            podium_url="http://127.0.0.1:8090",
        )
    )

    instance = service.create_instance(make_request(repo))

    assert "endpoint: http://127.0.0.1:8090/api/v1/linear/graphql" in instance.workflow_content
    assert "api_key: $PODIUM_PROXY_TOKEN" in instance.workflow_content
    assert "$LINEAR_API_KEY" not in instance.workflow_content


def test_create_instance_reuses_existing_workspace_without_resyncing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")

    instance = service.create_instance(
        make_request(repo).with_overrides(
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"
    assert not (workspace_root / "README.md").exists()


def test_create_instance_clones_git_source_only_when_workspace_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        target = Path(command[-1])
        target.mkdir(parents=True, exist_ok=True)
        (target / ".git").mkdir()
        (target / "README.md").write_text("cloned\n", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        )
    )

    assert instance.resolved_repo_path == "https://example.com/acme/repo.git"
    assert calls == [["git", "clone", "--", "https://example.com/acme/repo.git", instance.workspace_root]]
    assert (Path(instance.workspace_root) / "README.md").read_text(encoding="utf-8") == "cloned\n"


def test_create_instance_reuses_non_empty_git_workspace_without_cloning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = make_service(tmp_path)
    instance_dir = tmp_path / "custom-instance"
    workspace_root = instance_dir / "workspace" / "repo"
    workspace_root.mkdir(parents=True)
    (workspace_root / "keep.txt").write_text("existing\n", encoding="utf-8")
    calls: list[list[str]] = []

    def fake_run(command, *, check, cwd=None):
        calls.append(list(command))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    instance = service.create_instance(
        InstanceCreateRequest(
            name="Git Source",
            repo_source_type="git",
            repo_source_value="https://example.com/acme/repo.git",
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
            instance_dir=str(instance_dir),
            workspace_root=str(workspace_root),
        )
    )

    assert instance.workspace_root == str(workspace_root)
    assert calls == []
    assert (workspace_root / "keep.txt").read_text(encoding="utf-8") == "existing\n"


def test_instance_runtime_includes_persisted_performer_issue_details(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    store = PersistenceStore(Path(instance.persistence_path))
    started_at = utc_now() - timedelta(seconds=9)
    store.save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url="https://linear.app/x/issue/ENG-1",
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=started_at,
                    last_event="notification",
                    last_message="working",
                    last_raw_message="item/agentMessage/delta",
                    phase="running",
                    status_label="performer:phase/implementation",
                    workspace_path=str(Path(instance.workspace_root) / "ENG-1"),
                    recent_events=[
                        {
                            "at": "2026-06-30T00:00:00Z",
                            "event": "notification",
                            "message": "working",
                            "raw_method": "item/agentMessage/delta",
                            "raw_event": {
                                "event": "notification",
                                "raw_method": "item/agentMessage/delta",
                                "payload": {"delta": "working"},
                            },
                        }
                    ],
                    turn_count=3,
                    tokens=RuntimeTokens(input_tokens=20, output_tokens=8, cached_tokens=5, total_tokens=33),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url="https://linear.app/x/issue/ENG-2",
                    phase="retrying",
                    status_label="performer:phase/implementation",
                )
            ],
            continuations=[
                ContinuationEntry(
                    issue_id="issue-3",
                    identifier="ENG-3",
                    attempt=3,
                    due_at=utc_now() + timedelta(seconds=90),
                    due_at_ms=234567,
                    issue_url="https://linear.app/x/issue/ENG-3",
                    last_message="continuing",
                )
            ],
            blocked=[
                BlockedEntry(
                    issue_id="issue-4",
                    identifier="ENG-4",
                    attempt=4,
                    blocked_at=utc_now(),
                    error="runtime_permission_blocked: writing outside of the project",
                    issue_url="https://linear.app/x/issue/ENG-4",
                )
            ],
            human_interventions=[
                HumanInterventionEntry(
                    issue_id="issue-5",
                    identifier="ENG-5",
                    child_issue_id="issue-5h",
                    child_identifier="ENG-H1",
                    child_url="https://linear.app/x/issue/ENG-H1",
                    kind="runtime_permission",
                    attempt=5,
                    created_at=utc_now(),
                    error="runtime_permission_blocked: approval required",
                    issue_url="https://linear.app/x/issue/ENG-5",
                )
            ],
        )
    )

    runtime = service.instance_runtime(instance.id)

    assert runtime["workspace"]["root"] == instance.workspace_root
    assert runtime["workspace"]["strategy"] == "instance_repo_workspace"
    assert "reuses the prepared repository workspace" in runtime["workspace"]["description"]
    assert runtime["performer"]["source"] == "persistence"
    assert runtime["performer"]["counts"] == {
        "running": 1,
        "retrying": 1,
        "continuing": 1,
        "blocked": 1,
        "pending_human": 1,
    }
    assert runtime["performer"]["running"][0]["issue_identifier"] == "ENG-1"
    assert runtime["performer"]["running"][0]["phase"] == "running"
    assert runtime["performer"]["running"][0]["status_label"] == "performer:phase/implementation"
    assert "thread_id" not in runtime["performer"]["running"][0]
    assert runtime["performer"]["running"][0]["turn_count"] == 3
    assert runtime["performer"]["running"][0]["tokens"]["cached_tokens"] == 5
    assert runtime["performer"]["running"][0]["tokens"]["total_tokens"] == 33
    assert runtime["performer"]["running"][0]["recent_events"][0]["raw_event"]["payload"]["delta"] == "working"
    assert runtime["performer"]["retrying"][0]["issue_identifier"] == "ENG-2"
    assert runtime["performer"]["retrying"][0]["error"] == "worker exited: boom"
    assert runtime["performer"]["continuing"][0]["issue_identifier"] == "ENG-3"
    assert runtime["performer"]["continuing"][0]["phase"] == "continuing"
    assert runtime["performer"]["continuing"][0]["status_label"] == "performer:phase/implementation"
    assert runtime["performer"]["blocked"][0]["issue_identifier"] == "ENG-4"
    assert runtime["performer"]["blocked"][0]["phase"] == "error"
    assert runtime["performer"]["blocked"][0]["status_label"] == "performer:phase/blocked"
    assert runtime["performer"]["human_interventions"][0]["issue_identifier"] == "ENG-5"
    assert runtime["performer"]["human_interventions"][0]["child_identifier"] == "ENG-H1"
    assert runtime["performer"]["human_interventions"][0]["child_url"] == "https://linear.app/x/issue/ENG-H1"
    assert runtime["metrics"]["tokens"]["cached_tokens"] == 5
    assert runtime["metrics"]["tokens"]["total_tokens"] == 33
    assert runtime["metrics"]["turns"] == 3
    assert runtime["metrics"]["retrying"] == 1
    assert runtime["metrics"]["blocked"] == 1
    assert runtime["metrics"]["pending_human"] == 1


def test_instance_runtime_includes_conductor_phase_runs_without_persistence(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.AWAITING_HUMAN,
        status="waiting",
        human_action={"child_issue_id": "child-1", "child_identifier": "ENG-2"},
    )

    runtime = service.instance_runtime(instance.id)

    assert runtime["performer"]["source"] == "conductor_phase"
    assert runtime["performer"]["counts"]["pending_human"] == 1
    assert runtime["performer"]["issues"][0]["phase"] == "awaiting_human"
    assert runtime["performer"]["issues"][0]["status"] == "waiting"
    assert runtime["performer"]["issues"][0]["human_action"]["child_identifier"] == "ENG-2"


def test_phase_runtime_recovers_from_conductor_events_when_performer_json_is_deleted(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    Path(instance.persistence_path).unlink(missing_ok=True)

    runtime = service.instance_runtime(instance.id)
    rebuilt = service.store.rebuild_run(run.run_id)

    assert rebuilt.phase is RunPhase.DONE
    assert runtime["performer"]["source"] == "conductor_phase"
    assert runtime["performer"]["completed"][0]["run_id"] == run.run_id
    assert runtime["performer"]["telemetry"]["source"] == "persistence"


def test_dashboard_aggregates_persisted_runtime_metrics(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            sessions=[
                PersistedSession(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    issue_url=None,
                    session_id="thread-turn",
                    thread_id="thread",
                    turn_id="turn",
                    worker_host="local",
                    started_at=utc_now() - timedelta(seconds=20),
                    turn_count=2,
                    tokens=RuntimeTokens(input_tokens=30, output_tokens=12, total_tokens=42),
                )
            ],
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-2",
                    identifier="ENG-2",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=123456,
                    error="worker exited: boom",
                    issue_url=None,
                )
            ],
            continuations=[
                ContinuationEntry(
                    issue_id="issue-3",
                    identifier="ENG-3",
                    attempt=2,
                    due_at=utc_now() + timedelta(seconds=60),
                    due_at_ms=234567,
                    issue_url=None,
                )
            ],
            human_interventions=[
                HumanInterventionEntry(
                    issue_id="issue-4",
                    identifier="ENG-4",
                    child_issue_id="issue-4h",
                    child_identifier="ENG-H1",
                    child_url=None,
                    kind="runtime_error",
                    attempt=1,
                    created_at=utc_now(),
                )
            ],
        )
    )

    dashboard = service.dashboard()

    assert dashboard["totals"]["tokens"] == 42
    assert dashboard["totals"]["runtime_seconds"] >= 19
    assert dashboard["totals"]["failures"] == 1
    assert dashboard["totals"]["retries"] == 1
    assert dashboard["totals"]["continuations"] == 1
    assert dashboard["totals"]["pending_human"] == 1


def test_dashboard_aggregates_phase_run_status_counts(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    waiting = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    failed = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.store.update_orchestration_run(waiting.run_id, phase=RunPhase.AWAITING_HUMAN, status="waiting")
    service.store.update_orchestration_run(failed.run_id, phase=RunPhase.FAILED, status="failed", retry_count=2)

    dashboard = service.dashboard()

    assert dashboard["totals"]["failures"] == 1
    assert dashboard["totals"]["retries"] == 2
    assert dashboard["totals"]["blocked"] == 1
    assert dashboard["totals"]["pending_human"] == 1


def test_query_instance_logs_returns_structured_query_result(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("line-1\nline-2\nline-3\n", encoding="utf-8")
    updated = instance.with_updates(log_path=str(current))
    service.store.update_instance(updated)

    result = service.query_instance_logs(instance.id, tail=2, order="desc")

    assert result["instance_id"] == instance.id
    assert result["generation"] == 1
    assert result["order"] == "desc"
    assert result["lines"] == ["line-3", "line-2"]
    assert result["logs"] == "line-3\nline-2\n"


def test_instance_logs_preserves_legacy_text_result(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("line-1\nline-2\n", encoding="utf-8")
    service.store.update_instance(instance.with_updates(log_path=str(current)))

    assert service.instance_logs(instance.id) == "line-1\nline-2\n"


def test_create_instance_rejects_duplicate_workspace_resources(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo_a = make_repo(tmp_path, "repo-a")
    repo_b = make_repo(tmp_path, "repo-b")
    first = service.create_instance(make_request(repo_a, name="Alpha", port=8801))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(
            make_request(repo_b, name="Beta", port=first.http_port).with_overrides(
                workspace_root=first.workspace_root
            )
        )

    assert exc.value.code == "resource_collision"


def test_create_instance_rejects_same_local_repo_binding(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo, name="Alpha"))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(make_request(repo, name="Beta"))

    assert exc.value.code == "resource_collision"


def test_create_instance_rejects_duplicate_name(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo_a = make_repo(tmp_path, "repo-a")
    repo_b = make_repo(tmp_path, "repo-b")
    service.create_instance(make_request(repo_a, name="Alpha"))

    with pytest.raises(ConductorServiceError) as exc:
        service.create_instance(make_request(repo_b, name="Alpha"))

    assert exc.value.code == "resource_collision"
    assert any("name collides" in diag for diag in exc.value.diagnostics)


@pytest.mark.asyncio
async def test_sync_instance_project_labels_merges_managed_namespace(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(existing=["team-owned", "symphony:performer/old"])
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha").with_overrides(workflow_profile="task"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "synced"
    # User label preserved; stale managed label dropped; new managed labels added.
    assert "team-owned" in proxy.labels
    assert "symphony:performer/Alpha" in proxy.labels
    assert "symphony:profile/task" in proxy.labels
    assert "symphony:performer/old" not in proxy.labels


@pytest.mark.asyncio
async def test_sync_instance_project_labels_noop_when_unchanged(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(
        existing=["symphony:performer/Alpha", "symphony:profile/task", "keep"]
    )
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha").with_overrides(workflow_profile="task"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "unchanged"
    assert proxy.set_calls == []


@pytest.mark.asyncio
async def test_sync_project_labels_once_debounces_after_first_sync(tmp_path: Path) -> None:
    proxy = FakeProjectLabelProxy(existing=[])
    service = make_service(tmp_path)
    service.update_settings(service.settings().__class__(podium_proxy_token="proxy-token"))
    service.project_label_proxy_factory = lambda instance: proxy
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo, name="Alpha"))

    first = await service.sync_project_labels_once()
    second = await service.sync_project_labels_once()

    assert first == 1
    assert second == 0
    assert len(proxy.set_calls) == 1


@pytest.mark.asyncio
async def test_sync_instance_project_labels_skips_without_proxy_token(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo, name="Alpha"))

    result = await service.sync_instance_project_labels(instance)

    assert result["status"] == "skipped"
    assert result["reason"] == "proxy_not_configured"


@pytest.mark.asyncio
async def test_managed_background_does_not_call_conductor_linear_proxy_factories(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            managed_mode=True,
            podium_proxy_token="proxy-token",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    OpsStore(Path(instance.persistence_path).parent / "ops.json").save(
        OpsSnapshot(
            events=[
                TraceEvent(
                    event_id="evt-managed-handoff",
                    event_type="repository_handoff_report.v1",
                    timestamp="2026-07-03T00:00:00Z",
                    issue_id="issue-1",
                    retention_tier="summary",
                    payload={
                        "issue_id": "issue-1",
                        "issue_identifier": "ENG-1",
                        "workspace_path": instance.workspace_root,
                    },
                )
            ]
        )
    )

    def fail_repository_proxy(instance):
        raise AssertionError("managed background must not create a Conductor Linear repository proxy")

    def fail_project_proxy(instance):
        raise AssertionError("managed background must not create a Conductor Linear project-label proxy")

    service.repository_handoff_tracker_factory = fail_repository_proxy
    service.project_label_proxy_factory = fail_project_proxy

    result = await service.coordinate_background_once()

    assert result["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 0}
    assert result["project_labels_synced"] == 0


@pytest.mark.asyncio
async def test_direct_background_throttles_low_frequency_linear_work_between_ticks(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo))
    closeout_calls = 0
    project_label_calls = 0

    async def closeouts() -> dict[str, int]:
        nonlocal closeout_calls
        closeout_calls += 1
        return {"closed_out": 0, "failed": 0, "skipped": 0}

    async def project_labels() -> int:
        nonlocal project_label_calls
        project_label_calls += 1
        return 0

    service.coordinate_repository_handoff_closeouts = closeouts
    service.sync_project_labels_once = project_labels

    first = await service.coordinate_background_once()
    second = await service.coordinate_background_once()

    assert first["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 0}
    assert second["repository_handoff"] == {"closed_out": 0, "failed": 0, "skipped": 1}
    assert first["project_labels_synced"] == 0
    assert second["project_labels_synced"] == 0
    assert closeout_calls == 1
    assert project_label_calls == 1


def test_update_instance_revalidates_workflow_and_persists_raw_edits(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(
            workflow_content=instance.workflow_content.replace("Handle tasks", "Updated goal"),
        ),
    )

    assert updated.workflow_generation_status == "valid"
    assert "Updated goal" in Path(updated.workflow_path).read_text(encoding="utf-8")


def test_update_instance_persists_replaced_workflow_content_in_metadata(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    replacement = instance.workflow_content.replace(
        "https://podium.example/api/v1/linear/graphql",
        "http://127.0.0.1:9999/graphql",
    )

    updated = service.update_instance(
        instance.id,
        InstancePatchRequest(workflow_content=replacement),
    )

    stored = service.get_instance(instance.id)
    assert stored is not None
    assert "http://127.0.0.1:9999/graphql" in updated.workflow_content
    assert "http://127.0.0.1:9999/graphql" in stored.workflow_content


def test_update_instance_rejects_invalid_raw_workflow(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    with pytest.raises(ConductorServiceError) as exc:
        service.update_instance(instance.id, InstancePatchRequest(workflow_content="---\ntracker: [\n---"))

    assert exc.value.code == "workflow_parse_error"


def test_validate_workflow_returns_diagnostics_without_saving(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    result = service.validate_workflow(instance.id, "---\ntracker: [\n---")

    assert result.ok is False
    reloaded = service.get_instance(instance.id)
    assert reloaded is not None
    assert reloaded.workflow_generation_status == "valid"


def test_delete_instance_removes_record_when_stopped(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    service.delete_instance(instance.id)

    assert service.get_instance(instance.id) is None


def test_inspect_repo_reports_local_directory_context(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    repo = make_repo(tmp_path)

    result = service.inspect_repo("local_path", str(repo))

    assert result["exists"] is True
    assert result["git"] is True
    assert result["resolved_path"] == str(repo.resolve())
    assert "README.md" in result["files"]


def test_service_initialization_marks_stale_running_instances_stopped(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    instance = InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(repo),
        resolved_repo_path=str(repo),
        instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
        workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
        workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
        persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "performer.json"),
        log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
        workflow_profile="default",
        workflow_inputs={},
    ).with_updates(process_status="running", pid=999999)
    store.save_instance(instance)

    ConductorService(store=store, data_root=tmp_path / "conductor-data")

    reloaded = store.get_instance("inst-1")
    assert reloaded is not None
    assert reloaded.process_status == "stopped"
    assert reloaded.pid is None


@pytest.mark.asyncio
async def test_service_initialization_recovers_live_running_instance_pid(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    repo = make_repo(tmp_path)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        instance = InstanceRecord.create(
            id="inst-1",
            name="Alpha",
            repo_source_type="local_path",
            repo_source_value=str(repo),
            resolved_repo_path=str(repo),
            instance_dir=str(tmp_path / "conductor-data" / "instances" / "inst-1"),
            workflow_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "WORKFLOW.md"),
            workspace_root=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "workspace"),
            persistence_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "state" / "performer.json"),
            log_path=str(tmp_path / "conductor-data" / "instances" / "inst-1" / "logs" / "performer-000001.log"),
            http_port=8801,
            linear_project="ENG",
            linear_filters={"labels": ["codex"]},
            workflow_profile="default",
            workflow_inputs={},
        ).with_updates(process_status="running", pid=process.pid)
        store.save_instance(instance)

        service = ConductorService(store=store, data_root=tmp_path / "conductor-data")

        reloaded = store.get_instance("inst-1")
        assert reloaded is not None
        assert reloaded.process_status == "running"
        assert reloaded.pid == process.pid
        stopped = await service.stop_instance("inst-1")
        assert stopped.process_status == "stopped"
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.asyncio
async def test_start_instance_passes_podium_proxy_token_to_runtime_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    store = ConductorStore(tmp_path / "conductor-data")
    runtime = CapturingRuntime()
    service = ConductorService(store=store, data_root=tmp_path / "conductor-data", runtime_manager=runtime)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.example",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-token",
            podium_proxy_token="proxy-token",
            runtime_group_id="group-1",
        )
    )

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {
        "PODIUM_PROXY_TOKEN": "proxy-token",
        "PODIUM_RUNTIME_GROUP_ID": "group-1",
        "PODIUM_RUNTIME_ID": "runtime-1",
        "PODIUM_RUNTIME_TOKEN": "runtime-token",
    }


@pytest.mark.asyncio
async def test_start_instance_does_not_require_conductor_linear_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {}


@pytest.mark.asyncio
async def test_direct_start_instance_passes_linear_api_key_explicitly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False))
    monkeypatch.setenv("LINEAR_API_KEY", "direct-linear-token")
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))

    started = await service.start_instance(instance.id)

    assert started.process_status == "running"
    assert runtime.env == {"LINEAR_API_KEY": "direct-linear-token"}


@pytest.mark.asyncio
async def test_dispatch_podium_event_starts_one_shot_performer_for_matching_linear_agent_app_user(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(podium_proxy_token="proxy-token"))
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
            "assignee_id": "human-user-1",
        }
    )

    assert result == {
        "status": "accepted",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "instance_id": instance.id,
        "agent_session_id": "session-1",
        "agent_app_user_id": "app-user-1",
    }
    assert runtime.phase_issue_id == "issue-1"
    assert runtime.env == {"PODIUM_PROXY_TOKEN": "proxy-token"}
    assert runtime.advance_request_path is not None
    assert runtime.phase_result_path is not None
    request_payload = json.loads(Path(runtime.advance_request_path).read_text(encoding="utf-8"))
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert run.phase is RunPhase.IMPLEMENTING
    assert run.status == "running"
    assert run.request_path == runtime.advance_request_path
    assert run.result_path == runtime.phase_result_path
    assert request_payload["run_id"] == run.run_id
    assert request_payload["current_phase"] == "queued"
    assert request_payload["workspace_context"]["workspace_root"] == instance.workspace_root


@pytest.mark.asyncio
async def test_dispatch_podium_event_keeps_blocked_run_queued_at_scheduler_gate(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-2",
            "issue_identifier": "ENG-2",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
            "blocked_by": [{"id": "issue-1", "identifier": "ENG-1", "state": "In Progress"}],
            "parent_issue_id": "parent-1",
        }
    )

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-2")
    assert result["status"] == "accepted"
    assert run is not None
    assert run.phase is RunPhase.QUEUED
    assert run.blocked_by == ["issue-1"]
    assert run.parent_issue_id == "parent-1"
    assert runtime.started_phase_issue_ids == []


@pytest.mark.asyncio
async def test_dispatch_podium_event_accepts_project_bound_instance_without_agent_filter(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"active_states": ["Todo", "In Progress"]})
    )

    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-1",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
            "instance_id": instance.id,
        }
    )

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert result["status"] == "accepted"
    assert run is not None
    assert runtime.started_phase_issue_ids == ["issue-1"]


@pytest.mark.asyncio
async def test_dispatch_podium_event_leaves_new_run_queued_when_instance_is_busy(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    first = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    second = await service.dispatch_podium_event(
        {
            "issue_id": "issue-2",
            "issue_identifier": "ENG-2",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )

    assert first["status"] == "accepted"
    assert second["status"] == "accepted"
    assert runtime.started_phase_issue_ids == ["issue-1"]
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-2")
    assert run is not None
    assert run.phase is RunPhase.QUEUED
    assert run.status == "queued"


@pytest.mark.asyncio
async def test_dispatch_podium_event_does_not_restart_retry_before_next_run_at(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.QUEUED,
        status="queued",
        retry_count=1,
        next_run_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
    )

    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-2",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )

    assert result["status"] == "accepted"
    assert runtime.started_phase_issue_ids == []
    updated = service.store.get_orchestration_run(run.run_id)
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.dispatch_id == "dispatch-2"


@pytest.mark.asyncio
async def test_completed_phase_result_file_drives_podium_ack_without_performer_persistence(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    result = await service.dispatch_podium_event(
        {
            "dispatch_id": "dispatch-1",
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    assert result["status"] == "accepted"
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert runtime.phase_result_path is not None
    Path(runtime.phase_result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
                workspace_path=str(Path(instance.workspace_root) / "ENG-1"),
                ops_snapshot_path=str(Path(instance.persistence_path).parent / "ops.json"),
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    captured: dict[str, object] = {}

    def handler(request):
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"dispatch": {"status": "completed"}})

    ack = await service.ack_completed_podium_dispatches(transport=httpx.MockTransport(handler))
    completed = service.store.get_orchestration_run(run.run_id)

    assert ack == {"acked": 1, "failed": 0, "skipped": 0}
    assert completed is not None
    assert completed.phase is RunPhase.DONE
    assert completed.status == "completed"
    assert completed.ack_status == "acked"
    assert captured["body"] == {
        "dispatch_id": "dispatch-1",
        "status": "completed",
        "reason": "completed_by_runtime",
        "runtime_phase": "done",
    }


@pytest.mark.asyncio
async def test_background_projects_linear_phase_from_conductor_run_events(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
            reason="implementation_ready_for_review",
        )
    )

    first = await service.coordinate_background_once()
    second = await service.coordinate_background_once()
    events = service.store.list_orchestration_events(run.run_id)

    assert first["linear_phase_projections"] == 1
    assert second["linear_phase_projections"] == 0
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/review", "state_name": "In Review"}
    ]
    assert "linear.projected_review_state" in [event.event_type for event in events]


@pytest.mark.asyncio
async def test_background_replays_linear_phase_projection_when_linear_drifts(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )
    await service.coordinate_background_once()
    tracker.drifted_phase_issues.add("issue-1")

    result = await service.coordinate_background_once()

    assert result["linear_phase_projections"] == 1
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/done", "state_name": "Done"},
        {"issue_id": "issue-1", "phase_label": "performer:phase/done", "state_name": "Done"},
    ]


@pytest.mark.asyncio
async def test_linear_phase_projection_failures_back_off_and_escalate(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    tracker = FailingProjectionTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id=None,
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.DONE,
            status="completed",
            reason="completed_by_runtime",
        )
    )

    first = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:00Z")
    skipped = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:10Z")
    second = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:00:31Z")
    third = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:01:32Z")
    escalated = await service.reconcile_linear_phase_projections_once(now="2026-07-05T00:03:33Z")

    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)
    failed_events = [event for event in events if event.event_type == "linear.phase_projection_failed"]
    assert [first, skipped, second, third, escalated] == [0, 0, 0, 0, 0]
    assert tracker.project_attempts == 4
    assert [event.payload["failure_count"] for event in failed_events] == [1, 2, 3]
    assert failed_events[0].payload["next_run_at"] == "2026-07-05T00:00:30Z"
    assert failed_events[1].payload["next_run_at"] == "2026-07-05T00:01:31Z"
    assert failed_events[2].payload["next_run_at"] == "2026-07-05T00:03:32Z"
    assert updated is not None
    assert updated.phase is RunPhase.FAILED
    assert updated.ack_status == "pending"
    assert events[-1].event_type == "linear.phase_projection_escalated"


@pytest.mark.asyncio
async def test_managed_background_projects_linear_phase_through_podium_proxy(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.REVIEWING,
            status="reviewing",
            reason="implementation_ready_for_review",
        )
    )

    result = await service.coordinate_background_once()

    assert result["linear_phase_projections"] == 1
    assert tracker.phase_projections == [
        {"issue_id": "issue-1", "phase_label": "performer:phase/review", "state_name": "In Review"}
    ]


@pytest.mark.asyncio
async def test_managed_phase_cycle_runs_without_conductor_linear_credentials_or_calls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    monkeypatch.setenv("LINEAR_API_KEY", "linear-secret-that-managed-mode-must-ignore")
    tracker = FakeRepositoryHandoffTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )

    dispatch = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
        }
    )
    background_before_result = await service.coordinate_background_once()
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert runtime.phase_result_path is not None
    Path(runtime.phase_result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.DONE,
                status="completed",
                reason="completed_by_runtime",
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))

    background_after_result = await service.coordinate_background_once()

    completed = service.store.get_orchestration_run(run.run_id)
    assert dispatch["status"] == "accepted"
    assert background_before_result["direct_dispatches_received"] == 0
    assert background_before_result["phase_human_actions_completed"] == 0
    assert background_after_result["phase_results_applied"] == 1
    assert completed is not None
    assert completed.phase is RunPhase.DONE
    assert completed.status == "completed"
    assert tracker.phase_projections
    assert runtime.env == {"PODIUM_PROXY_TOKEN": "proxy-token"}
    assert "LINEAR_API_KEY" not in (runtime.env or {})


@pytest.mark.asyncio
async def test_dispatch_podium_event_applies_codex_profile_to_visible_workflow(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "app-user-1",
            "codex_profile": {
                "model": "gpt-5-codex",
                "sandbox": "workspace_write",
                "config_overrides": [
                    "model_provider=openai",
                    "model_providers.openai.api_key=$OPENAI_API_KEY",
                ],
            },
        }
    )
    updated = service.store.get_instance(instance.id)

    assert result["status"] == "accepted"
    assert updated is not None
    assert updated.workflow_inputs["codex_profile"]["model"] == "gpt-5-codex"
    workflow_content = Path(updated.workflow_path).read_text(encoding="utf-8")
    assert "model: gpt-5-codex" in workflow_content
    assert "sandbox: workspace_write" in workflow_content
    assert "config_overrides:\n    - model_provider=openai\n    - model_providers.openai.api_key=$OPENAI_API_KEY" in workflow_content
    assert "sk-" not in workflow_content
    assert "$LINEAR_API_KEY" not in instance.workflow_content
    assert "linear-secret-that-managed-mode-must-ignore" not in instance.workflow_content


@pytest.mark.asyncio
async def test_background_requeues_phase_run_after_result_retry_without_persistence(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert runtime.phase_result_path is not None
    Path(runtime.phase_result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.QUEUED,
                status="upstream_overloaded",
                reason="temporary failure",
                retry_delay_seconds=0,
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))

    first = await service.coordinate_background_once()
    delayed = service.store.get_orchestration_run(run.run_id)
    assert delayed is not None
    assert delayed.next_run_at is not None
    service.store.update_orchestration_run(run.run_id, next_run_at="1970-01-01T00:00:00Z")
    second = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)

    assert first["phase_results_applied"] == 1
    assert second["phase_runs_started"] == 1
    assert runtime.started_phase_issue_ids == ["issue-1", "issue-1"]
    assert updated is not None
    assert updated.attempt == 2


@pytest.mark.asyncio
async def test_background_records_phase_crash_without_performer_persistence(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=1))

    result = await service.coordinate_background_once()
    crashed = service.store.get_orchestration_run(run.run_id)

    assert result["phase_crash_retries"] == 1
    assert crashed is not None
    assert crashed.phase is RunPhase.QUEUED
    assert crashed.status == "queued"
    assert crashed.crash_count == 1
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase process exited" in tracker.comments[0][1]
    assert "crash_count: 1" in tracker.comments[0][1]


@pytest.mark.asyncio
async def test_background_does_not_record_phase_crash_when_result_file_exists(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )
    await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_app_user_id": "app-user-1",
        }
    )
    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert run is not None
    assert run.result_path is not None
    Path(run.result_path).write_text(
        json.dumps(
            PhaseAdvanceResult(
                run_id=run.run_id,
                issue_id="issue-1",
                next_phase=RunPhase.QUEUED,
                status="upstream_overloaded",
                reason="upstream_overloaded_exhausted",
                detail="upstream 502: server overloaded raw body",
                http_status=502,
                retry_delay_seconds=5,
            ).to_dict()
        ),
        encoding="utf-8",
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=1))

    result = await service.coordinate_background_once()
    updated = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)

    assert result["phase_results_applied"] == 1
    assert result["phase_crash_retries"] == 0
    assert updated is not None
    assert updated.retry_count == 0
    assert updated.crash_count == 0
    assert updated.overload_count == 1
    assert "performer.upstream_overloaded" in [event.event_type for event in events]
    assert "linear.diagnostic_commented" in [event.event_type for event in events]
    assert tracker.comments
    assert tracker.comments[0][0] == "issue-1"
    assert "Performer phase reported upstream_overloaded" in tracker.comments[0][1]
    assert "reason: upstream_overloaded_exhausted" in tracker.comments[0][1]
    assert "detail: upstream 502: server overloaded raw body" in tracker.comments[0][1]
    assert "http_status: 502" in tracker.comments[0][1]
    assert "overload_count: 1" in tracker.comments[0][1]


@pytest.mark.asyncio
async def test_managed_background_does_not_resume_from_performer_persistence_without_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.store.update_instance(instance.with_updates(process_status="running", pid=4242))
    runtime.refreshed_instance = instance.with_updates(process_status="exited", pid=None, last_exit_code=0)
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="legacy retry",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()

    assert "resumed" not in result.to_dict()
    assert runtime.started_phase_issue_ids == []


@pytest.mark.asyncio
async def test_direct_background_resumes_done_human_action_child_from_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="runtime error needs review",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "kind": "runtime_error",
            },
        )
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1",
            "description": "Human response:\nFixed the Codex state directory.\n\nWhen finished, move this child issue to Done.",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
            "url": "https://linear.test/ENG-2",
        }
    )

    result = await service.coordinate_background_once()

    updated = service.store.get_orchestration_run(run.run_id)
    assert result["phase_human_actions_completed"] == 1
    assert result["phase_runs_started"] == 1
    assert updated is not None
    assert updated.phase is RunPhase.IMPLEMENTING
    assert updated.human_response == "Fixed the Codex state directory."
    assert runtime.started_phase_issue_ids == ["issue-1"]
    assert runtime.advance_request_path is not None


@pytest.mark.asyncio
async def test_background_creates_human_action_child_for_failed_upstream_overload(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.FAILED,
            status="failed",
            reason="upstream_overloaded_exhausted",
            detail="JSON-RPC error -32000: upstream 502: server overloaded raw body",
            http_status=502,
        )
    )

    result = await service.coordinate_background_once()

    assert result["phase_failure_human_actions_created"] == 1
    assert len(tracker.children) == 1
    child = tracker.children[0]
    assert child["title"] == "[Human Action] ENG-1: Runtime error needs review"
    assert child["labels"] == ["performer:type/human-action"]
    assert "Upstream HTTP status: 502" in child["description"]
    assert "Last error:\nJSON-RPC error -32000: upstream 502: server overloaded raw body" in child["description"]
    updated = service.store.get_orchestration_run(run.run_id)
    assert updated is not None
    assert updated.human_action["child_issue_id"] == child["id"]
    assert updated.phase is RunPhase.FAILED


@pytest.mark.asyncio
async def test_background_remediates_orchestration_projection_drift(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    with service.store.connect() as connection:
        connection.execute("UPDATE orchestration_runs SET phase = ? WHERE run_id = ?", (RunPhase.FAILED.value, run.run_id))

    result = await service.coordinate_background_once()

    repaired = service.store.get_orchestration_run(run.run_id)
    events = service.store.list_orchestration_events(run.run_id)
    assert result["remediations"]["repaired"] == 1
    assert repaired is not None
    assert repaired.phase is RunPhase.QUEUED
    assert any(event.event_type == "remediation.projection_rebuilt" for event in events)


@pytest.mark.asyncio
async def test_direct_background_dispatches_new_work_from_poll_into_phase_run(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    tracker.candidate_issues.append(
        {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Build the direct mode task",
            "state": "Todo",
        }
    )

    result = await service.coordinate_background_once()

    run = service.store.get_orchestration_run_by_issue(instance.id, "issue-1")
    assert result["direct_dispatches_received"] == 1
    assert result["phase_runs_started"] == 1
    assert run is not None
    assert run.phase is RunPhase.IMPLEMENTING
    assert runtime.started_phase_issue_ids == ["issue-1"]


@pytest.mark.asyncio
async def test_direct_background_does_not_dispatch_system_child_issues_from_poll(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"active_states": ["Todo", "In Progress"]},
        )
    )
    tracker.candidate_issues.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1: Runtime error needs review",
            "state": "Todo",
            "labels": ["performer:type/human-action"],
        }
    )

    result = await service.coordinate_background_once()

    run = service.store.get_orchestration_run_by_issue(instance.id, "child-1")
    assert result["direct_dispatches_received"] == 0
    assert result["phase_runs_started"] == 0
    assert run is None
    assert runtime.started_phase_issue_ids == []


@pytest.mark.asyncio
async def test_direct_default_tracker_fetches_candidate_issues_from_linear_proxy(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    service.update_settings(
        ConductorSettings(
            podium_url="https://podium.example",
            podium_proxy_token="proxy-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    transport = RecordingConductorLinearTransport(
        [
            {
                "data": {
                    "issues": {
                        "nodes": [
                            {
                                "id": "issue-1",
                                "identifier": "ENG-1",
                                "title": "Build the direct task",
                                "description": "Do it",
                                "url": "https://linear.test/ENG-1",
                                "state": {"name": "Todo", "type": "started"},
                                "delegate": {"id": "app-user-1"},
                                "labels": {"nodes": [{"name": "performer:phase/queued"}]},
                            }
                        ],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        ]
    )
    tracker = service._repository_handoff_tracker(instance, transport=transport)

    issues = await tracker.fetch_candidate_issues()

    assert issues == [
        {
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Build the direct task",
            "description": "Do it",
            "url": "https://linear.test/ENG-1",
            "state": "Todo",
            "state_type": "started",
            "delegate_id": "app-user-1",
            "parent_issue_id": None,
            "parent_identifier": None,
            "blocked_by": [],
            "labels": ["performer:phase/queued"],
        }
    ]
    request = transport.requests[0]
    assert request["url"] == "https://podium.example/api/v1/linear/graphql"
    assert request["headers"]["authorization"] == "proxy-token"
    variables = request["json"]["variables"]
    assert variables["projectSlug"] == "ENG"
    assert variables["stateNames"] == ["Todo", "In Progress"]
    assert variables["delegateId"] == "app-user-1"
    assert "$delegateId: ID" in request["json"]["query"]
    assert "delegate: { id: { eq: $delegateId } }" in request["json"]["query"]


@pytest.mark.asyncio
async def test_direct_background_does_not_resume_required_human_action_without_response(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    tracker = FakeRepositoryHandoffTracker()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    service.update_settings(ConductorSettings(managed_mode=False, podium_proxy_token="proxy-token"))
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(
            linear_project="ENG",
            linear_filters={"linear_agent_app_user_id": "app-user-1", "active_states": ["Todo", "In Progress"]},
        )
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="need scope",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "kind": "preflight_needs_input",
            },
        )
    )
    service.store.update_instance(instance.with_updates(process_status="exited", pid=None, last_exit_code=0))
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "title": "[Human Action] ENG-1",
            "description": "Human response:\n\n(Add the answer or decision here when information is required.)\n\nWhen finished, move this child issue to Done.",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
            "url": "https://linear.test/ENG-2",
        }
    )

    result = await service.coordinate_background_once()

    updated = service.store.get_orchestration_run(run.run_id)
    assert result["phase_human_actions_completed"] == 0
    assert result["phase_human_actions_missing_response"] == 1
    assert updated is not None
    assert updated.phase is RunPhase.AWAITING_HUMAN
    assert runtime.started_phase_issue_ids == []
    assert tracker.comments == [
        (
            "child-1",
            "This human action is marked Done, but the `Human response` section is empty. Add the response there, then keep this child issue in Done.",
        )
    ]


@pytest.mark.asyncio
async def test_background_restarts_crashed_performer_with_pending_work(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    service.store.update_instance(instance.with_updates(process_status="running", pid=4242))
    runtime.refreshed_instance = instance.with_updates(process_status="exited", pid=None, last_exit_code=1)
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="worker crashed",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()
    restarted = service.store.get_instance(instance.id)

    assert result["crash_restarts"] == 1
    assert restarted is not None
    assert restarted.process_status == "running"
    assert restarted.restart_count == 1
    assert restarted.restart_window_started_at
    assert restarted.restart_next_at
    assert runtime.started_phase_issue_ids == ["issue-1"]


@pytest.mark.asyncio
async def test_background_marks_crash_loop_after_repeated_crashes(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    crashed = instance.with_updates(
        process_status="exited",
        pid=None,
        last_exit_code=1,
        restart_count=3,
        restart_window_started_at=utc_now().isoformat().replace("+00:00", "Z"),
        restart_next_at=None,
    )
    service.store.update_instance(crashed)
    runtime.refreshed_instance = crashed
    PersistenceStore(Path(instance.persistence_path)).save(
        PersistedState(
            retry_attempts=[
                RetryEntry(
                    issue_id="issue-1",
                    identifier="ENG-1",
                    attempt=1,
                    due_at=utc_now(),
                    due_at_ms=0,
                    error="worker crashed",
                )
            ]
        )
    )

    result = await service.coordinate_background_once()
    updated = service.store.get_instance(instance.id)

    assert result["crash_loops"] == 1
    assert updated is not None
    assert updated.process_status == "crash_loop"
    assert updated.restart_count == 4
    assert "crashed more than 3 times" in (updated.last_error or "")
    assert runtime.started_phase_issue_ids == []


@pytest.mark.asyncio
async def test_dispatch_podium_event_skips_when_no_instance_matches_project(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(make_request(repo).with_overrides(linear_project="ENG"))

    result = await service.dispatch_podium_event(
        {"issue_id": "issue-1", "issue_identifier": "OPS-1", "project_slug": "OPS", "agent_app_user_id": "app-user-1"}
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "OPS-1",
        "reason": "no_matching_instance",
    }
    assert runtime.phase_issue_id is None


@pytest.mark.asyncio
async def test_dispatch_podium_event_requires_linear_agent_app_user(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {"issue_id": "issue-1", "issue_identifier": "ENG-1", "project_slug": "ENG", "agent_session_id": "session-1"}
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "reason": "missing_linear_agent_app_user",
    }
    assert runtime.phase_issue_id is None


@pytest.mark.asyncio
async def test_dispatch_podium_event_skips_when_linear_agent_app_user_does_not_match_instance(tmp_path: Path) -> None:
    runtime = CapturingRuntime()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,
    )
    repo = make_repo(tmp_path)
    service.create_instance(
        make_request(repo).with_overrides(linear_project="ENG", linear_filters={"linear_agent_app_user_id": "app-user-1"})
    )

    result = await service.dispatch_podium_event(
        {
            "issue_id": "issue-1",
            "issue_identifier": "ENG-1",
            "project_slug": "ENG",
            "agent_session_id": "session-1",
            "agent_app_user_id": "other-app-user",
        }
    )

    assert result == {
        "status": "skipped",
        "issue_id": "issue-1",
        "issue_identifier": "ENG-1",
        "reason": "no_matching_instance",
    }
    assert runtime.phase_issue_id is None
