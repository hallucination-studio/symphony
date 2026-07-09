from __future__ import annotations

from typing import Any

from conductor.conductor_managed_run_coordinator import ConductorManagedRunCoordinator
from conductor.conductor_managed_run_human_action import ingest_managed_run_human_action_event
from conductor.conductor_managed_run_projection import ManagedRunLinearProjector
from conductor.conductor_managed_run_store import ConductorManagedRunStore
from performer_api.managed_runs import (
    ManagedRunPlan,
    ParallelizationPolicy,
    VerificationRubric,
    WorkItem,
    WorkItemSliceType,
    WorkItemState,
    WorkItemVerification,
)


class Tracker:
    def __init__(self) -> None:
        self.children: list[dict[str, object]] = []
        self.comments: list[tuple[str, str]] = []
        self.updated_comments: list[tuple[str, str]] = []
        self.description_blocks: list[tuple[str, str, str]] = []
        self.transitions: list[tuple[str, list[str], str]] = []

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, object]]:
        return [child for child in self.children if child.get("parent_issue_id") == parent_issue_id]

    async def create_child_issue_for(
        self,
        *,
        parent_issue_id: str,
        title: str,
        description: str,
        label_names: list[str],
        delegate_id: str | None = None,
    ) -> dict[str, object]:
        child = {
            "id": f"child-{len(self.children) + 1}",
            "parent_issue_id": parent_issue_id,
            "title": title,
            "description": description,
            "labels": list(label_names),
        }
        self.children.append(child)
        return child

    async def update_issue_description_marker_block(self, issue_id: str, marker_name: str, block: str) -> dict[str, object]:
        self.description_blocks.append((issue_id, marker_name, block))
        return {"success": True}

    async def transition_issue_by_state_target(self, issue_id: str, *, names: list[str], state_type: str) -> dict[str, object]:
        self.transitions.append((issue_id, list(names), state_type))
        return {"success": True}

    async def comment_issue(self, issue_id: str, body: str) -> dict[str, object]:
        self.comments.append((issue_id, body))
        return {"success": True, "comment_id": f"comment-{len(self.comments)}"}

    async def update_issue_comment(self, comment_id: str, body: str) -> dict[str, object]:
        self.updated_comments.append((comment_id, body))
        return {"success": True, "comment_id": comment_id}


async def test_managed_run_human_action_instruction_is_idempotent_and_state_flip_resumes(tmp_path) -> None:
    store = ConductorManagedRunStore(tmp_path)
    coordinator = ConductorManagedRunCoordinator(store=store)
    accepted = coordinator.accept_dispatch({"issue_id": "root-1", "issue_identifier": "HELL-1"}, instance_id="instance-1")
    coordinator.apply_plan(accepted.run_id, _approval_plan(), backend_session_id="thread-1")
    coordinator.start_work_item(accepted.run_id, "wi-1")
    tracker = Tracker()
    projector = ManagedRunLinearProjector(store=store, tracker=tracker, root_issue_id="root-1")

    await projector.reconcile_once(accepted.run_id)
    await projector.reconcile_once(accepted.run_id)

    assert len(tracker.comments) == 1
    assert tracker.comments[0][0] == "child-1"
    assert "comments are context only" in tracker.comments[0][1]
    assert "resume requires flipping the issue out of the blocked state" in tracker.comments[0][1]
    assert tracker.updated_comments[0][0] == "comment-1"
    run = store.get_run(accepted.run_id) or {}
    wait = run["payload"]["human_action_instructions"]["managed-run:wi-1:human_approval_required"]
    assert wait["linear_comment_id"] == "comment-1"
    ignored = ingest_managed_run_human_action_event(
        coordinator,
        accepted.run_id,
        {"event_type": "comment_created", "work_item_id": "wi-1", "linear_comment_id": "comment-99"},
    )
    assert ignored["applied"] is False
    assert ignored["reason"] == "comment_only_does_not_resume"
    assert store.list_work_items(accepted.run_id)[0]["state"] == WorkItemState.BLOCKED.value

    resumed = ingest_managed_run_human_action_event(
        coordinator,
        accepted.run_id,
        {
            "event_type": "state_changed",
            "work_item_id": "wi-1",
            "from_blocked_style": True,
            "to_blocked_style": False,
            "event_id": "state-flip-1",
        },
    )

    item = store.list_work_items(accepted.run_id)[0]
    assert resumed == {"applied": True, "reason": "state_flip_resumed"}
    assert item["state"] == WorkItemState.TODO.value
    assert item["gate_status"] == "human_approval_approved:state-flip-1"


def _approval_plan() -> ManagedRunPlan:
    item = WorkItem(
        id="wi-1",
        title="Implement approval",
        objective="Wait for operator approval",
        slice_type=WorkItemSliceType.VERTICAL,
        acceptance_criteria=["operator approved"],
        verification=WorkItemVerification(red_command="pytest -q", green_commands=["pytest -q"]),
        dependencies=[],
        estimated_scope="S",
        files_likely_touched=["src/approval.py"],
        parallelization=ParallelizationPolicy(safe_to_parallelize=False, reason="human approval"),
        needs_human_approval=True,
    )
    return ManagedRunPlan(
        summary="Approval plan",
        architecture_decisions=["Wait for a state flip"],
        work_items=[item],
        checkpoints=[],
        verification_rubric=VerificationRubric(
            correctness=["approved"],
            quality=["visible"],
            integration=["resumable"],
            documentation=["projected"],
            ship_readiness=["operator clear"],
        ),
        risks=[],
        open_questions=[],
        approval_required=False,
    )
