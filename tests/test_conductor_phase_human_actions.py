from __future__ import annotations

from pathlib import Path

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_phase import PhaseReducer
from conductor.conductor_phase_human_actions import PhaseHumanActionCoordinator
from conductor.conductor_store import ConductorStore
from performer_api.phase import PhaseAdvanceResult, RunPhase


class FakeTracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.comments: list[tuple[str, str]] = []
        self.description_updates: list[tuple[str, str, str]] = []

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [
            child
            for child in self.children
            if child.get("parent_issue_id") == parent_issue_id
            and (label_name is None or label_name in child.get("labels", []))
        ]

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True}

    async def update_issue_description_marker_block(
        self, issue_id: str, marker_name: str, block: str
    ) -> dict[str, object]:
        self.description_updates.append((issue_id, marker_name, block))
        return {"success": True}


def make_instance(tmp_path: Path) -> InstanceRecord:
    return InstanceRecord.create(
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(tmp_path / "instances" / "inst-1"),
        workflow_path=str(tmp_path / "instances" / "inst-1" / "WORKFLOW.md"),
        workspace_root=str(tmp_path / "instances" / "inst-1" / "workspace" / "repo"),
        persistence_path=str(tmp_path / "instances" / "inst-1" / "state" / "performer.json"),
        log_path=str(tmp_path / "instances" / "inst-1" / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={},
        workflow_profile="default",
        workflow_inputs={},
        id="inst-1",
    )


@pytest.mark.asyncio
async def test_phase_human_action_coordinator_resumes_done_child_with_response(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    tracker = FakeTracker()
    coordinator = PhaseHumanActionCoordinator(
        store=store,
        phase_reducer=reducer,
        managed_mode_enabled=lambda: False,
        tracker_factory=lambda instance: tracker,
    )
    run = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="runtime error",
            human_action={"child_issue_id": "child-1", "child_identifier": "ENG-2", "kind": "runtime_error"},
        )
    )
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "description": "Human response:\nRestart approved.\n\nWhen finished, move this child issue to Done.",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
        }
    )

    result = await coordinator.coordinate()

    updated = store.get_orchestration_run(run.run_id)
    assert result == {"completed": 1, "missing_response": 0, "failed": 0}
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.human_response == "Restart approved."
    assert tracker.description_updates[-1][0] == "issue-1"


@pytest.mark.asyncio
async def test_phase_human_action_coordinator_comments_when_required_response_missing(tmp_path: Path) -> None:
    store = ConductorStore(tmp_path / "conductor-data")
    reducer = PhaseReducer(store)
    instance = make_instance(tmp_path)
    store.create_instance(instance)
    tracker = FakeTracker()
    coordinator = PhaseHumanActionCoordinator(
        store=store,
        phase_reducer=reducer,
        managed_mode_enabled=lambda: False,
        tracker_factory=lambda instance: tracker,
    )
    run = reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            reason="need input",
            human_action={"child_issue_id": "child-1", "child_identifier": "ENG-2", "kind": "preflight_needs_input"},
        )
    )
    tracker.children.append(
        {
            "id": "child-1",
            "identifier": "ENG-2",
            "description": "Human response:\n\n(Add the answer or decision here when information is required.)",
            "state": "Done",
            "labels": ["performer:type/human-action"],
            "parent_issue_id": "issue-1",
        }
    )

    result = await coordinator.coordinate()

    assert result == {"completed": 0, "missing_response": 1, "failed": 0}
    assert store.get_orchestration_run(run.run_id).phase is RunPhase.AWAITING_HUMAN  # type: ignore[union-attr]
    assert tracker.comments == [
        (
            "child-1",
            "This human action is marked Done, but the `Human response` section is empty. Add the response there, then keep this child issue in Done.",
        )
    ]
