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
        self.stopped_pids: list[int | None] = []

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
        self.stopped_pids.append(instance.pid)
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


class NonRecoveringRuntime(CapturingRuntime):
    def recover(self, instance):
        return None


class PidRecoveringRuntime(CapturingRuntime):
    def __init__(self, live_pids: set[int]) -> None:
        super().__init__()
        self.live_pids = set(live_pids)

    def recover(self, instance):
        if instance.pid in self.live_pids:
            return instance.with_updates(process_status="running", pid=instance.pid)
        return None


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
